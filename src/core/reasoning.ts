import type { Message, MessageBus } from "../bus/index.js";
import { InMemoryBeliefBase, type BeliefBase } from "./beliefs.js";
import { GoalQueue } from "./goals.js";
import { PlanLibrary } from "./plans.js";
import { IntentionStack, createIntention } from "./intentions.js";
import type { Intention } from "./intentions.js";
import type { ActionResult } from "./plans.js";

export interface AgentConfig {
  id: string;
  bus: MessageBus;
  planLibrary: PlanLibrary;
  beliefs?: BeliefBase;
  enableIntentionReconsideration?: boolean;
  maxConcurrentIntentions?: number;
  tickIntervalMs?: number;
}

export class Agent {
  readonly id: string;
  readonly beliefs: BeliefBase;
  readonly goals: GoalQueue;
  readonly intentions: IntentionStack;
  private readonly bus: MessageBus;
  private readonly planLibrary: PlanLibrary;
  private readonly config: Required<AgentConfig>;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
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
      tickIntervalMs: 100,
      ...config,
      beliefs: this.beliefs,
    };
  }

  start(): void {
    this.bus.registerAgent(this.id, this.handleMessage.bind(this));

    for (const topic of this.subscribedTopics) {
      this.unsubs.push(
        this.bus.subscribe(topic, this.handleMessage.bind(this)),
      );
    }

    this.unsubs.push(
      this.beliefs.on("beliefAdded", () => this.onBeliefChange()),
      this.beliefs.on("beliefUpdated", () => this.onBeliefChange()),
    );

    this.running = true;
    this.tickTimer = setInterval(() => {
      if (this.running) {
        this.tick();
      }
    }, this.config.tickIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }

  async tick(): Promise<void> {
    this.reviseBeliefs();
    this.deliberate();
    await this.meansEndsReasoning();
    await this.execute();
  }

  subscribe(topic: string): () => void {
    if (this.subscribedTopics.has(topic)) {
      return () => {};
    }
    this.subscribedTopics.add(topic);
    if (!this.running) {
      return () => {
        this.subscribedTopics.delete(topic);
      };
    }
    const unsub = this.bus.subscribe(topic, this.handleMessage.bind(this));
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
      // Check if this plan is belief-triggered (trigger doesn't depend on a specific goal name)
      const testGoal = {
        id: "__probe__",
        name: plan.name,
        priority: 5,
        status: "active" as const,
      };
      if (plan.trigger(this.beliefs, testGoal)) {
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
  }

  private async meansEndsReasoning(): Promise<void> {
    const activeGoals = this.goals.getByStatus("active");
    const activeIntentions = this.intentions.getActive();

    if (activeIntentions.length >= this.config.maxConcurrentIntentions) {
      return;
    }

    const activeGoalIds = new Set(activeIntentions.map((i) => i.goal.id));

    for (const goal of activeGoals) {
      if (activeGoalIds.has(goal.id)) {
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
    const active = this.intentions.getActive();

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

    try {
      const result = await action.execute(intention, this.beliefs);

      if (result.failure) {
        this.intentions.fail(intention.id, result.failure.reason);
        this.goals.setStatus(intention.goal.id, "failed");
        return;
      }

      await this.applyActionResult(result);
      this.intentions.advance(intention.id);

      const nextAction = intention.plan.body[intention.actionIndex];
      if (!nextAction) {
        this.intentions.complete(intention.id, result);
        this.goals.setStatus(intention.goal.id, "achieved");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.intentions.fail(intention.id, reason);
      this.goals.setStatus(intention.goal.id, "failed");
    }
  }

  private async applyActionResult(result: ActionResult): Promise<void> {
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

    if (result.newGoals) {
      for (const goal of result.newGoals) {
        this.goals.add({
          id: `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: goal.name,
          priority: goal.priority,
          status: "pending",
          data: goal.data,
        });
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
