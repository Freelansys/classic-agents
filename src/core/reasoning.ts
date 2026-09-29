import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Message, MessageBus } from "../bus/index.js";
import { InMemoryBeliefBase, type BeliefBase } from "./beliefs.js";
import { GoalQueue, type GoalSource } from "./goals.js";
import { PlanLibrary } from "./plans.js";
import { IntentionStack, createIntention } from "./intentions.js";
import type { ChildFailure, Intention } from "./intentions.js";
import type { ActionResult } from "./plans.js";

/** Topic every agent publishes a failure notification on. */
export const FAILURE_TOPIC = "__failure__";

/**
 * Topic every agent publishes a completion notice on when a goal reaches
 * `achieved`. The achieved counterpart of `FAILURE_TOPIC`, so a monitor can
 * watch both ends of a job without inferring success from silence.
 *
 * Completion notices go to monitors only. Replying to whoever requested a goal
 * is left to the plan that requested it, which knows the reply shape its
 * caller needs.
 */
export const GOAL_ACHIEVED_TOPIC = "__goal_achieved__";

/**
 * An acknowledgement received for a request this agent sent, naming the goal id
 * that actually got assigned. The payload of a `goalAcknowledged` event.
 */
export interface GoalAck {
  /** Id of the agent that acknowledged, i.e. that created the goal. */
  agentId: string;
  goal: string;
  goalId: string;
  conversationId?: string;
  messageId?: string;
}

export type AgentEvent = "goalAcknowledged";

export type GoalAckHandler = (ack: GoalAck) => void;

/**
 * An acknowledgement queued while a request is turned into a goal, telling the
 * sender which id that goal actually ended up with. Flushed on the next tick.
 */
interface PendingGoalAck {
  to: string;
  goal: string;
  goalId: string;
  conversationId?: string;
  messageId?: string;
}

export interface AgentConfig {
  id: string;
  bus: MessageBus;
  planLibrary: PlanLibrary;
  beliefs?: BeliefBase;
  enableIntentionReconsideration?: boolean;
  maxConcurrentIntentions?: number;
}

export class Agent {
  readonly id: string;
  readonly beliefs: BeliefBase;
  readonly goals: GoalQueue;
  readonly intentions: IntentionStack;
  private readonly bus: MessageBus;
  private readonly planLibrary: PlanLibrary;
  private readonly config: Required<AgentConfig>;
  private tickTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private running = false;
  private unsubs: Array<() => void> = [];
  private subscribedTopics = new Set<string>();
  private pendingBeliefGoals = new Set<string>();
  private pendingAcks: PendingGoalAck[] = [];
  private readonly emitter = new EventEmitter();

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.bus = config.bus;
    this.planLibrary = config.planLibrary;
    this.beliefs = config.beliefs ?? new InMemoryBeliefBase();
    this.goals = new GoalQueue();
    this.intentions = new IntentionStack();
    this.emitter.setMaxListeners(0);

    this.config = {
      enableIntentionReconsideration: false,
      maxConcurrentIntentions: 10,
      ...config,
      beliefs: this.beliefs,
    };
  }

  /**
   * Start the agent. Registers its mailbox and subscribes every previously
   * requested topic, awaiting the bus once the transport has acknowledged
   * them (for a Redis bus this means no published message can race ahead of
   * the subscription). Resolves when the agent is fully ready. If
   * `tickIntervalMs` is provided, the reasoning cycle runs on a timer;
   * otherwise drive it manually via `tick()`.
   */
  async start(tickIntervalMs?: number): Promise<void> {
    this.running = true;
    this.bus.registerAgent(this.id, this.handleMessage.bind(this));

    const topics = Array.from(this.subscribedTopics);
    const unsubs = await Promise.all(
      topics.map((topic) =>
        this.bus.subscribe(topic, this.handleMessage.bind(this)),
      ),
    );
    this.unsubs.push(...unsubs);

    this.unsubs.push(
      this.beliefs.on("beliefAdded", () => this.onBeliefChange()),
      this.beliefs.on("beliefUpdated", () => this.onBeliefChange()),
    );

    if (tickIntervalMs) {
      this.tickTimer = setInterval(() => {
        if (this.running) {
          this.tick();
        }
      }, tickIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }

  async tick(): Promise<void> {
    // Yield to the event loop so messages queued on async transports (e.g.
    // Redis Pub/Sub) can be delivered before this reasoning cycle runs. A
    // manual drive loop that awaits tick() in a tight chain runs entirely on
    // microtasks and starves pending socket I/O; this macrotask yield is a
    // correctness requirement, not a timeout.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.flushGoalAcks();
    this.reviseBeliefs();
    this.deliberate();
    await this.meansEndsReasoning();
    await this.execute();
  }

  async subscribe(topic: string): Promise<() => void> {
    if (this.subscribedTopics.has(topic)) {
      return () => {};
    }
    this.subscribedTopics.add(topic);
    if (!this.running) {
      return () => {
        this.subscribedTopics.delete(topic);
      };
    }
    const unsub = await this.bus.subscribe(
      topic,
      this.handleMessage.bind(this),
    );
    this.unsubs.push(unsub);
    return () => {
      unsub();
      this.subscribedTopics.delete(topic);
    };
  }

  /**
   * Observes agent-level events. Currently only `goalAcknowledged`, fired when
   * a `confirm` arrives — the reply to a request this agent sent.
   *
   * Acks deliberately produce no belief, goal or intention: they report a fact
   * the agent already has (it asked, and the responder owns the goal queue), and
   * folding them into beliefs would let a belief-triggered plan fire off a
   * bookkeeping message. Correlating ids to threads is the caller's job.
   *
   * Returns an unsubscribe function.
   */
  on(event: AgentEvent, handler: GoalAckHandler): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }

  private handleMessage(msg: Message): void {
    this.processMessage(msg);
  }

  private processMessage(msg: Message): void {
    if (msg.performative === "inform" && isRecord(msg.content)) {
      for (const [key, value] of Object.entries(msg.content)) {
        this.beliefs.set(`msg.${key}`, value);
      }
    } else if (msg.performative === "request") {
      this.goalFromMessage(msg, 5);
    } else if (msg.performative === "achieve") {
      this.goalFromMessage(msg, 8);
    } else if (msg.performative === "confirm") {
      this.handleAcknowledgement(msg);
    }
  }

  private handleAcknowledgement(msg: Message): void {
    if (!isRecord(msg.content)) {
      return;
    }

    const goalId = msg.content.goalId;
    if (typeof goalId !== "string" || !goalId) {
      return;
    }

    const conversationId =
      typeof msg.content.conversationId === "string"
        ? msg.content.conversationId
        : msg.conversationId;

    this.emitter.emit("goalAcknowledged", {
      agentId: msg.sender,
      goal: typeof msg.content.goal === "string" ? msg.content.goal : "",
      goalId,
      ...(conversationId ? { conversationId } : {}),
      ...(typeof msg.content.messageId === "string"
        ? { messageId: msg.content.messageId }
        : {}),
    } satisfies GoalAck);
  }

  /**
   * Turns a `request`/`achieve` into a goal, recording where it came from so
   * the sender can follow it through decomposition and failure notices.
   *
   * A caller may pin the id with `content.goalId`; it is honoured only while
   * free, since a taken id would otherwise silently overwrite an existing goal.
   * Either way the sender is told which id was assigned via a `confirm` ack, so
   * it never has to guess.
   */
  private goalFromMessage(msg: Message, priority: number): void {
    if (!isRecord(msg.content)) {
      return;
    }

    const content = msg.content;
    const goalName = content.goal as string;
    if (!goalName) {
      return;
    }

    const requestedId =
      typeof content.goalId === "string" && content.goalId.trim()
        ? content.goalId
        : undefined;

    const goalId =
      requestedId && !this.goals.get(requestedId)
        ? requestedId
        : `goal-${randomUUID()}`;

    const source: GoalSource = {
      sender: msg.sender,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.id ? { messageId: msg.id } : {}),
    };

    this.goals.add({
      id: goalId,
      name: goalName,
      priority,
      status: "pending",
      data: content,
      dependsOn: Array.isArray(content.dependsOn)
        ? (content.dependsOn as string[])
        : undefined,
      source,
    });

    // Acknowledging ourselves would just be noise: an agent subscribed to a
    // topic receives its own publishes.
    if (msg.sender && msg.sender !== this.id) {
      this.pendingAcks.push({
        to: msg.sender,
        goal: goalName,
        goalId,
        ...(source.conversationId
          ? { conversationId: source.conversationId }
          : {}),
        ...(source.messageId ? { messageId: source.messageId } : {}),
      });
    }
  }

  /**
   * Sends the acknowledgements queued since the last tick. Deliveries happen
   * here rather than in the message handler, which the bus calls synchronously,
   * so a failed send stays a catchable error instead of an unhandled rejection.
   */
  private async flushGoalAcks(): Promise<void> {
    if (this.pendingAcks.length === 0) {
      return;
    }

    const acks = this.pendingAcks;
    this.pendingAcks = [];

    for (const ack of acks) {
      try {
        await this.bus.send(ack.to, {
          performative: "confirm",
          sender: this.id,
          receiver: ack.to,
          content: {
            goal: ack.goal,
            goalId: ack.goalId,
            ...(ack.conversationId
              ? { conversationId: ack.conversationId }
              : {}),
            ...(ack.messageId ? { messageId: ack.messageId } : {}),
          },
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error(
          `[${this.id}] Failed to acknowledge goal ${ack.goalId} to ${ack.to}:`,
          error,
        );
      }
    }
  }

  private reviseBeliefs(): void {
    // Hook point for future extensions.
  }

  private deliberate(): void {
    // Standard goal selection
    const nextGoal = this.goals.selectNext();
    if (nextGoal) {
      this.goals.setStatus(nextGoal.id, "active");
    }

    // Belief-triggered plans: create implicit goals for plans that match current beliefs
    // but don't already have a pending/active goal for them.
    const activeGoals = this.goals.getByStatus("active");
    const pendingGoals = this.goals.getByStatus("pending");
    const allGoals = [...activeGoals, ...pendingGoals];
    const goalNames = new Set(allGoals.map((g) => g.name));

    for (const plan of this.planLibrary.all()) {
      // A plan is belief-triggered if its trigger returns true for a neutral goal
      // (one whose name won't match any real plan). If it only matches when the
      // goal name equals plan.name, it's a goal-triggered plan and should not
      // get an implicit goal.
      const neutralGoal = {
        id: "__neutral__",
        name: "___nonexistent_neutral_goal___",
        priority: 0,
        status: "active" as const,
      };

      if (!plan.trigger(this.beliefs, neutralGoal)) {
        continue; // goal-triggered plan, skip implicit goal creation
      }

      // Only create a goal if no goal with this plan's name already exists
      // and no existing active intention is already running this plan
      const alreadyRunning = this.intentions
        .getActive()
        .some((i) => i.plan.name === plan.name);

      if (!goalNames.has(plan.name) && !alreadyRunning) {
        const goalId = `belief-goal-${plan.name}-${randomUUID()}`;
        this.goals.add({
          id: goalId,
          name: plan.name,
          priority: 5,
          status: "pending",
        });
        this.pendingBeliefGoals.add(goalId);
        goalNames.add(plan.name);
      }
    }
  }

  private async meansEndsReasoning(): Promise<void> {
    const activeGoals = this.goals.getByStatus("active");
    const activeIntentions = this.intentions.getActive();

    if (activeIntentions.length >= this.config.maxConcurrentIntentions) {
      return;
    }

    const activeGoalIds = new Set(activeIntentions.map((i) => i.goal.id));
    const achievedGoalIds = new Set(
      this.goals
        .all()
        .filter((g) => g.status === "achieved")
        .map((g) => g.id),
    );

    for (const goal of activeGoals) {
      if (activeGoalIds.has(goal.id)) {
        continue;
      }

      if (
        goal.dependsOn &&
        !goal.dependsOn.every((depId) => achievedGoalIds.has(depId))
      ) {
        continue;
      }

      const plan = this.planLibrary.findApplicable(this.beliefs, goal);
      if (plan) {
        const intention = createIntention(goal, plan);
        intention.status = "executing";
        this.intentions.push(intention);
      }
    }
  }

  private async execute(): Promise<void> {
    const active = this.intentions
      .getAll()
      .filter((i) => i.status === "pending" || i.status === "executing");

    const results = await Promise.allSettled(
      active.map((intention) => this.executeIntention(intention)),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`[${this.id}] Intention execution error:`, result.reason);
      }
    }
  }

  private async executeIntention(intention: Intention): Promise<void> {
    const action = intention.plan.body[intention.actionIndex];
    if (!action) {
      this.intentions.complete(intention.id, {});
      this.goals.setStatus(intention.goal.id, "achieved");
      await this.publishAchieved(intention, intention.result ?? {});
      return;
    }

    let result: ActionResult | undefined;
    try {
      result = await action.execute(intention, this.beliefs);

      // Every other effect the action reports is applied even when it also
      // reports a failure: partial progress is real progress, and dropping it
      // would lose the beliefs, sub-goals and messages the action did produce.
      const hasChildren = await this.applyActionResult(result, intention);

      if (result.failure) {
        await this.failIntention(intention, result.failure.reason);
        return;
      }

      this.intentions.advance(intention.id);

      const nextAction = intention.plan.body[intention.actionIndex];
      if (!nextAction) {
        this.intentions.complete(intention.id, result);
        this.goals.setStatus(intention.goal.id, "achieved");
        await this.publishAchieved(intention, result);
        this.resumeWaitingParents();
        return;
      }

      if (hasChildren) {
        this.intentions.setStatus(intention.id, "waiting");
        return;
      }
    } catch (error) {
      // An action that reported a failure stays failed for the reason it
      // reported, even if applying its other results then threw.
      const reason =
        result?.failure?.reason ??
        (error instanceof Error ? error.message : String(error));
      await this.failIntention(intention, reason);
    }
  }

  private async failIntention(
    intention: Intention,
    reason: string,
  ): Promise<void> {
    this.intentions.fail(intention.id, reason);
    this.goals.setStatus(intention.goal.id, "failed");
    this.dropDependentGoals(intention.goal.id);
    await this.publishFailure(intention, reason);
    await this.failWaitingParents(intention, reason);
  }

  /**
   * A sub-goal that fails must not leave its parent waiting forever: the parent
   * either fails with it or resumes, so the slot it holds in `getActive()` is
   * always released. Failing parents cascade the same way, so the whole chain
   * of waiting ancestors unwinds up to the top-level goal.
   */
  private async failWaitingParents(
    child: Intention,
    reason: string,
  ): Promise<void> {
    const childName = this.goals.get(child.goal.id)?.name ?? child.goal.name;

    const parents = this.intentions
      .getAll()
      .filter(
        (i) => i.status === "waiting" && i.children.includes(child.goal.id),
      );

    for (const parent of parents) {
      if (parent.plan.onChildFailure === "continue") {
        this.resumeAfterChildFailure(parent, {
          goalId: child.goal.id,
          goal: childName,
          reason,
        });
        continue;
      }

      await this.failIntention(
        parent,
        `sub-goal "${childName}" failed: ${reason}`,
      );
    }
  }

  /**
   * Recovery path for plans with `onChildFailure: "continue"`. The failed
   * sub-goal leaves the pending set, the reason is kept for the next action to
   * read, and the parent resumes once no sub-goal is outstanding.
   */
  private resumeAfterChildFailure(
    intention: Intention,
    failure: ChildFailure,
  ): void {
    intention.children = intention.children.filter(
      (id) => id !== failure.goalId,
    );
    intention.childFailures.push(failure);

    if (this.remainingChildren(intention).length === 0) {
      intention.status = "executing";
    }
  }

  private async publishFailure(
    intention: Intention,
    reason: string,
  ): Promise<void> {
    const goal = this.goals.get(intention.goal.id) ?? intention.goal;
    try {
      await this.bus.publish(FAILURE_TOPIC, {
        performative: "inform",
        sender: this.id,
        topic: FAILURE_TOPIC,
        content: {
          [`failure.${this.id}`]: {
            agentId: this.id,
            intentionId: intention.id,
            goalId: intention.goal.id,
            goal: intention.goal.name,
            plan: intention.plan.name,
            action: intention.plan.body[intention.actionIndex]?.name,
            reason,
            ...(goal.parentGoalId
              ? {
                  parentGoalId: goal.parentGoalId,
                  rootGoalId: goal.rootGoalId,
                }
              : {}),
            // Carries the originating sender (and conversation) so a monitor
            // can attribute a failure to whoever asked for the work.
            ...(goal.source ? { source: goal.source } : {}),
          },
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${this.id}] Failed to publish failure notification:`,
        error,
      );
    }
  }

  /**
   * Announces a goal reaching `achieved` on `GOAL_ACHIEVED_TOPIC`, mirroring
   * the failure notice: the same namespacing under `achieved.<agentId>`, the
   * same lineage and `source` fields, and the result of the last action.
   */
  private async publishAchieved(
    intention: Intention,
    result: ActionResult,
  ): Promise<void> {
    const goal = this.goals.get(intention.goal.id) ?? intention.goal;
    try {
      await this.bus.publish(GOAL_ACHIEVED_TOPIC, {
        performative: "inform",
        sender: this.id,
        topic: GOAL_ACHIEVED_TOPIC,
        content: {
          [`achieved.${this.id}`]: {
            agentId: this.id,
            intentionId: intention.id,
            goalId: intention.goal.id,
            goal: intention.goal.name,
            plan: intention.plan.name,
            // The action that ran last, which is one before the current index:
            // the index has already advanced past the plan's final action.
            action: intention.plan.body[intention.actionIndex - 1]?.name,
            status: "achieved",
            result,
            ...(goal.parentGoalId
              ? {
                  parentGoalId: goal.parentGoalId,
                  rootGoalId: goal.rootGoalId,
                }
              : {}),
            // Carries the originating sender (and conversation) so a monitor
            // can attribute a completion to whoever asked for the work.
            ...(goal.source ? { source: goal.source } : {}),
          },
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${this.id}] Failed to publish goal achieved notification:`,
        error,
      );
    }
  }

  private async applyActionResult(
    result: ActionResult,
    intention: Intention,
  ): Promise<boolean> {
    if (result.beliefUpdates) {
      for (const { key, value } of result.beliefUpdates) {
        this.beliefs.set(key, value);
      }
    }

    if (result.beliefRemovals) {
      for (const key of result.beliefRemovals) {
        this.beliefs.remove(key);
      }
    }

    let hasChildren = false;
    if (result.newGoals) {
      const childIds: string[] = [];
      for (const goal of result.newGoals) {
        const childId = `goal-${randomUUID()}`;
        childIds.push(childId);
        this.goals.add({
          id: childId,
          name: goal.name,
          priority: goal.priority,
          status: "pending",
          data: goal.data,
          parentGoalId: intention.goal.id,
          rootGoalId: intention.goal.rootGoalId ?? intention.goal.id,
          // Inherited so the original sender stays traceable however deep the
          // decomposition goes.
          ...(intention.goal.source ? { source: intention.goal.source } : {}),
        });
      }
      if (childIds.length > 0) {
        intention.children.push(...childIds);
        hasChildren = true;
      }
    }

    if (result.messages) {
      for (const msg of result.messages) {
        if (msg.topic !== undefined) {
          await this.bus.publish(msg.topic, {
            performative: msg.performative as Message["performative"],
            sender: this.id,
            topic: msg.topic,
            content: msg.content,
            timestamp: Date.now(),
          });
        } else if (msg.receiver !== undefined) {
          await this.bus.send(msg.receiver, {
            performative: msg.performative as Message["performative"],
            sender: this.id,
            receiver: msg.receiver,
            content: msg.content,
            timestamp: Date.now(),
          });
        } else {
          throw new Error(
            "ActionResult message must specify a topic or a receiver",
          );
        }
      }
    }

    return hasChildren;
  }

  private dropDependentGoals(failedGoalId: string): void {
    for (const goal of this.goals.all()) {
      if (goal.dependsOn?.includes(failedGoalId)) {
        this.goals.setStatus(goal.id, "dropped");
      }
    }
  }

  private resumeWaitingParents(): void {
    for (const intention of this.intentions.getAll()) {
      if (intention.status !== "waiting") continue;

      if (this.remainingChildren(intention).length === 0) {
        intention.children = [];
        intention.status = "executing";
      }
    }
  }

  /** Sub-goal ids this intention is still waiting for: everything not yet achieved. */
  private remainingChildren(intention: Intention): string[] {
    const achievedGoalIds = new Set(
      this.goals
        .all()
        .filter((g) => g.status === "achieved")
        .map((g) => g.id),
    );

    return intention.children.filter((id) => !achievedGoalIds.has(id));
  }

  private onBeliefChange(): void {
    if (!this.config.enableIntentionReconsideration) return;

    for (const intention of this.intentions.getActive()) {
      if (intention.status === "executing" && intention.actionIndex > 0) {
        const plan = this.planLibrary.findApplicable(
          this.beliefs,
          intention.goal,
        );
        if (!plan || plan.name !== intention.plan.name) {
          this.intentions.drop(intention.id);
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
