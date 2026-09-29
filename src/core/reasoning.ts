import type { Message, MessageBus } from "../bus/index.js";
import { InMemoryBeliefBase, type BeliefBase } from "./beliefs.js";
import { GoalQueue } from "./goals.js";
import { PlanLibrary } from "./plans.js";
import { IntentionStack, createIntention } from "./intentions.js";
import type { ChildFailure, Intention } from "./intentions.js";
import type { ActionResult } from "./plans.js";

/** Topic every agent publishes a failure notification on. */
export const FAILURE_TOPIC = "__failure__";

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

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.bus = config.bus;
    this.planLibrary = config.planLibrary;
    this.beliefs = config.beliefs ?? new InMemoryBeliefBase();
    this.goals = new GoalQueue();
    this.intentions = new IntentionStack();

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

  private handleMessage(msg: Message): void {
    this.processMessage(msg);
  }

  private processMessage(msg: Message): void {
    const content = msg.content as Record<string, unknown>;

    if (
      msg.performative === "inform" &&
      content &&
      typeof content === "object"
    ) {
      for (const [key, value] of Object.entries(content)) {
        this.beliefs.set(`msg.${key}`, value);
      }
    } else if (
      msg.performative === "request" &&
      content &&
      typeof content === "object"
    ) {
      const goalName = (content as Record<string, unknown>).goal as string;
      if (goalName) {
        this.goals.add({
          id: `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: goalName,
          priority: 5,
          status: "pending",
          data: content,
          dependsOn: Array.isArray(content.dependsOn)
            ? (content.dependsOn as string[])
            : undefined,
        });
      }
    } else if (
      msg.performative === "achieve" &&
      content &&
      typeof content === "object"
    ) {
      const goalName = (content as Record<string, unknown>).goal as string;
      if (goalName) {
        this.goals.add({
          id: `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: goalName,
          priority: 8,
          status: "pending",
          data: content,
          dependsOn: Array.isArray(content.dependsOn)
            ? (content.dependsOn as string[])
            : undefined,
        });
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
        const goalId = `belief-goal-${plan.name}-${Date.now()}`;
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
        const childId = `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        childIds.push(childId);
        this.goals.add({
          id: childId,
          name: goal.name,
          priority: goal.priority,
          status: "pending",
          data: goal.data,
          parentGoalId: intention.goal.id,
          rootGoalId: intention.goal.rootGoalId ?? intention.goal.id,
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
