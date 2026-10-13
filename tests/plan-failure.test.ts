import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  AgentConfig,
  GoalFailed,
  GoalFailure,
  IntentionFailed,
} from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan, PlanFailure } from "../src/core/plans.js";
import type { Goal } from "../src/core/goals.js";

function agent(
  bus: InMemoryMessageBus,
  id: string,
  plans: Plan[],
  config: Partial<AgentConfig> = {},
): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library, ...config });
}

async function run(a: Agent, cycles = 20): Promise<void> {
  for (let i = 0; i < cycles; i++) await a.tick();
}

/** A one-action plan for `goal`, named `label` like its action. */
function plan(
  goal: string,
  label: string,
  execute: () => ActionResult,
  extra: Partial<Plan> = {},
): Plan {
  return {
    name: label,
    goal,
    ...extra,
    body: [{ name: label, execute: async () => execute() }],
  };
}

/** A requester at `ui` that asks `boss` for `goal`. */
function requester(bus: InMemoryMessageBus) {
  const inbox: Message[] = [];
  bus.registerAgent("ui", (m) => inbox.push(m));
  return {
    inbox,
    request(goal: string): Promise<void> {
      return bus.send("boss", {
        performative: "request",
        sender: "ui",
        receiver: "boss",
        content: { goal },
        conversationId: "conv-ui",
        replyWith: "req-ui",
        timestamp: Date.now(),
      });
    },
    performatives(): string[] {
      return inbox.map((m) => m.performative);
    },
  };
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g",
    name: "ship",
    priority: 5,
    status: "pending",
    ...overrides,
  };
}

describe("Plan.onPlanFailure", () => {
  it("runs on an action's failure and applies its beliefs and messages", async () => {
    const bus = new InMemoryMessageBus();
    const ui = requester(bus);
    const seen: PlanFailure[] = [];
    const boss = agent(bus, "boss", [
      plan("ship", "book", () => ({ failure: { reason: "courier down" } }), {
        onPlanFailure: (_intention, _beliefs, failure) => {
          seen.push(failure);
          return {
            beliefUpdates: [{ key: "status", value: "failed" }],
            messages: [
              {
                receiver: "ui",
                performative: "inform",
                content: { alert: failure.reason },
              },
            ],
          };
        },
      }),
    ]);
    await boss.start();

    await ui.request("ship");
    await run(boss);

    expect(seen).toEqual([
      { reason: "courier down", cause: "action", action: "book" },
    ]);
    expect(boss.beliefs.get("status")).toBe("failed");
    expect(ui.performatives()).toEqual(["agree", "inform", "failure"]);
    expect(ui.inbox[1].content).toEqual({ alert: "courier down" });
    await boss.stop();
  });

  it("gets what an action threw", async () => {
    const bus = new InMemoryMessageBus();
    const seen: PlanFailure[] = [];
    const boom = new Error("boom");
    const a = agent(bus, "a", [
      plan(
        "ship",
        "book",
        () => {
          throw boom;
        },
        { onPlanFailure: (_i, _b, failure) => void seen.push(failure) },
      ),
    ]);
    a.goals.add(goal());
    await run(a);

    expect(seen).toEqual([
      { reason: "boom", cause: "action", action: "book", error: boom },
    ]);
  });

  it("replaces the reason the requester is told", async () => {
    const bus = new InMemoryMessageBus();
    const ui = requester(bus);
    const failed: IntentionFailed[] = [];
    const boss = agent(bus, "boss", [
      plan("ship", "book", () => ({ failure: { reason: "ECONNRESET" } }), {
        onPlanFailure: () => ({ reason: "shipping is unavailable" }),
      }),
    ]);
    boss.on("intention:failed", (e) => failed.push(e));
    await boss.start();

    await ui.request("ship");
    await run(boss);

    expect(failed.map((f) => f.reason)).toEqual(["shipping is unavailable"]);
    expect(ui.performatives()).toEqual(["agree", "failure"]);
    const content = JSON.stringify(ui.inbox[1].content);
    expect(content).toContain("shipping is unavailable");
    expect(content).not.toContain("ECONNRESET");
    await boss.stop();
  });

  it("does not stop the failure when it throws", async () => {
    const bus = new InMemoryMessageBus();
    const failed: IntentionFailed[] = [];
    const goals: GoalFailed[] = [];
    const a = agent(bus, "a", [
      plan("ship", "book", () => ({ failure: { reason: "courier down" } }), {
        onPlanFailure: () => {
          throw new Error("hook broke");
        },
      }),
    ]);
    a.on("intention:failed", (e) => failed.push(e));
    a.on("goal:failed", (e) => goals.push(e));
    a.goals.add(goal());
    await run(a);

    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe("courier down");
    expect(failed[0].onPlanFailureError).toBe("hook broke");
    expect(goals.map((g) => g.reason)).toEqual(["courier down"]);
  });

  it("runs when a delegation the plan cannot do without fails", async () => {
    const bus = new InMemoryMessageBus();
    const seen: PlanFailure[] = [];
    const a = agent(bus, "a", [
      plan("ship", "split", () => ({ delegations: [{ goal: "book" }] }), {
        onPlanFailure: (_i, _b, failure) => void seen.push(failure),
      }),
      plan("book", "book", () => ({ failure: { reason: "no courier" } })),
    ]);
    a.goals.add(goal());
    await run(a);

    expect(seen).toHaveLength(1);
    expect(seen[0].cause).toBe("delegation");
    expect(seen[0].action).toBeUndefined();
    expect(seen[0].reason).toContain("no courier");
  });

  it("runs per failed plan, and steers which plan runs next", async () => {
    const bus = new InMemoryMessageBus();
    const log: string[] = [];
    const a = agent(bus, "a", [
      plan(
        "ship",
        "courier",
        () => {
          log.push("courier");
          return { failure: { reason: "courier down" } };
        },
        {
          onPlanFailure: () => {
            log.push("courier:onPlanFailure");
            return { beliefUpdates: [{ key: "courier.up", value: false }] };
          },
        },
      ),
      plan(
        "ship",
        "courier-again",
        () => {
          log.push("courier-again");
          return {};
        },
        { context: (b) => b.get("courier.up") !== false },
      ),
      plan(
        "ship",
        "post",
        () => {
          log.push("post");
          return {};
        },
        { onPlanFailure: () => void log.push("post:onPlanFailure") },
      ),
    ]);
    a.goals.add(goal());
    await run(a);

    expect(log).toEqual(["courier", "courier:onPlanFailure", "post"]);
    expect(a.goals.all()).toEqual([]);
  });

  it("is not run for a goal removed while its action ran", async () => {
    const bus = new InMemoryMessageBus();
    let hooked = 0;
    let a!: Agent;
    a = agent(bus, "a", [
      plan(
        "ship",
        "book",
        () => {
          a.goals.remove("g");
          return { failure: { reason: "courier down" } };
        },
        { onPlanFailure: () => void hooked++ },
      ),
    ]);
    a.goals.add(goal());
    await run(a);

    expect(hooked).toBe(0);
  });
});

describe("goal:failed", () => {
  it("is emitted once, with the reason, when the last plan fails", async () => {
    const bus = new InMemoryMessageBus();
    const failed: GoalFailed[] = [];
    const a = agent(bus, "a", [
      plan("ship", "courier", () => ({ failure: { reason: "courier down" } })),
      plan("ship", "post", () => ({ failure: { reason: "post closed" } })),
    ]);
    a.on("goal:failed", (e) => failed.push({ ...e, goal: { ...e.goal } }));
    a.goals.add(goal());
    await run(a);

    expect(failed).toHaveLength(1);
    expect(failed[0].goal.id).toBe("g");
    expect(failed[0].goal.status).toBe("failed");
    expect(failed[0].reason).toBe("post closed");
  });

  it("is not emitted when another plan achieves the goal", async () => {
    const bus = new InMemoryMessageBus();
    const failed: GoalFailed[] = [];
    const a = agent(bus, "a", [
      plan("ship", "courier", () => ({ failure: { reason: "courier down" } })),
      plan("ship", "post", () => ({})),
    ]);
    a.on("goal:failed", (e) => failed.push(e));
    a.goals.add(goal());
    await run(a);

    expect(failed).toEqual([]);
  });

  it("is emitted when no plan is applicable", async () => {
    const bus = new InMemoryMessageBus();
    const failed: GoalFailed[] = [];
    const a = agent(bus, "a", [
      plan("ship", "courier", () => ({}), { context: () => false }),
    ]);
    a.on("goal:failed", (e) => failed.push(e));
    a.goals.add(goal());
    await run(a);

    expect(failed.map((f) => f.reason)).toEqual([
      'no applicable plan for "ship"',
    ]);
  });

  it("is emitted for a goal no plan serves", async () => {
    const bus = new InMemoryMessageBus();
    const failed: GoalFailed[] = [];
    const a = agent(bus, "a", []);
    a.on("goal:failed", (e) => failed.push(e));
    a.goals.add(goal());
    await run(a);

    expect(failed.map((f) => f.reason)).toEqual(['no plan serves "ship"']);
    expect(failed[0].attempts).toEqual([]);
  });

  it("lists every plan tried, in order, with what each failure was", async () => {
    const bus = new InMemoryMessageBus();
    const failed: GoalFailed[] = [];
    const boom = new Error("post closed");
    const courier = plan(
      "ship",
      "courier",
      () => ({ failure: { reason: "ECONNRESET" } }),
      { onPlanFailure: () => ({ reason: "courier down" }) },
    );
    const post = plan("ship", "post", () => {
      throw boom;
    });
    const skipped = plan("ship", "drone", () => ({}), {
      context: () => false,
    });
    const a = agent(bus, "a", [courier, skipped, post]);
    a.on("goal:failed", (e) => failed.push(e));
    a.goals.add(goal());
    await run(a);

    expect(failed).toHaveLength(1);
    const { attempts } = failed[0];
    // A plan whose context never held was not tried, so it is not listed.
    expect(attempts.map((t) => t.plan)).toEqual([courier, post]);
    // Each plan is named apart from the goal they share.
    expect(attempts.map((t) => t.plan.name)).toEqual(["courier", "post"]);
    expect(

      attempts.map(({ plan: _plan, intentionId: _id, ...rest }) => rest),
    ).toEqual([
      // The reason as the hook replaced it.
      { reason: "courier down", cause: "action", action: "courier" },
      { reason: "post closed", cause: "action", action: "post", error: boom },
    ]);
    expect(new Set(attempts.map((t) => t.intentionId)).size).toBe(2);
    expect(failed[0].reason).toBe("post closed");
  });

  it("lists a delegation failure as one", async () => {
    const bus = new InMemoryMessageBus();
    const failed: GoalFailed[] = [];
    const a = agent(bus, "a", [
      plan("ship", "split", () => ({ delegations: [{ goal: "book" }] })),
      plan("book", "book", () => ({ failure: { reason: "no courier" } })),
    ]);
    a.on("goal:failed", (e) => failed.push(e));
    a.goals.add(goal());
    await run(a);

    const ship = failed.find((f) => f.goal.name === "ship")!;
    expect(ship.attempts).toHaveLength(1);
    expect(ship.attempts[0].cause).toBe("delegation");
    expect(ship.attempts[0].action).toBeUndefined();
  });

  it("starts the list afresh after a continueWith hand-off", async () => {
    const bus = new InMemoryMessageBus();
    const failed: GoalFailed[] = [];
    const a = agent(bus, "a", [
      plan("step", "flaky", () => ({ failure: { reason: "flaky" } })),
      plan("step", "next", () => ({ continueWith: { goal: "last" } })),
      plan("last", "last", () => ({ failure: { reason: "last failed" } })),
    ]);
    a.on("goal:failed", (e) => failed.push(e));
    a.goals.add(goal({ name: "step" }));
    await run(a);

    expect(failed).toHaveLength(1);
    expect(failed[0].attempts.map((t) => t.reason)).toEqual(["last failed"]);
  });

  it("leaves nothing behind once the goal is gone", async () => {
    const bus = new InMemoryMessageBus();
    const a = agent(bus, "a", [
      plan("ship", "courier", () => ({ failure: { reason: "courier down" } })),
      plan("ship", "post", () => ({})),
    ]);
    a.goals.add(goal());
    await run(a);

    expect(a.goals.all()).toEqual([]);
    expect(a.planAttempts.size).toBe(0);
    expect(a.triedPlans.size).toBe(0);
  });
});

describe("AgentConfig.onGoalFailure", () => {
  it("runs once, after the last plan fails, with every attempt", async () => {
    const bus = new InMemoryMessageBus();
    const seen: Array<{ goal: string; failure: GoalFailure }> = [];
    const a = agent(
      bus,
      "a",
      [
        plan("ship", "courier", () => ({
          failure: { reason: "courier down" },
        })),
        plan("ship", "post", () => ({ failure: { reason: "post closed" } })),
        plan("track", "a", () => ({ failure: { reason: "lost" } })),
        plan("track", "b", () => ({})),
      ],
      {
        onGoalFailure: (goal, _beliefs, failure) =>
          void seen.push({ goal: goal.name, failure }),
      },
    );
    a.goals.add(goal());
    a.goals.add(goal({ id: "t", name: "track" }));
    await run(a);

    // `track` recovered with its second plan, so only `ship` failed.
    expect(seen).toHaveLength(1);
    expect(seen[0].goal).toBe("ship");
    expect(seen[0].failure.reason).toBe("post closed");
    expect(seen[0].failure.attempts.map((t) => t.reason)).toEqual([
      "courier down",
      "post closed",
    ]);
  });

  it("replaces what the requester and goal:failed are told", async () => {
    const bus = new InMemoryMessageBus();
    const ui = requester(bus);
    const intentionReasons: string[] = [];
    const goalReasons: string[] = [];
    const boss = agent(
      bus,
      "boss",
      [
        plan("ship", "courier", () => ({ failure: { reason: "ECONNRESET" } })),
        plan("ship", "post", () => ({ failure: { reason: "HTTP 503" } })),
      ],
      {
        onGoalFailure: (_goal, _beliefs, { attempts }) => ({
          reason: `shipping unavailable (${attempts.length} ways tried)`,
        }),
      },
    );
    boss.on("intention:failed", (e) => intentionReasons.push(e.reason));
    boss.on("goal:failed", (e) => goalReasons.push(e.reason));
    await boss.start();

    await ui.request("ship");
    await run(boss);

    // A plan's failure keeps its own reason; the goal's is the hook's.
    expect(intentionReasons).toEqual(["ECONNRESET", "HTTP 503"]);
    expect(goalReasons).toEqual(["shipping unavailable (2 ways tried)"]);
    expect(ui.performatives()).toEqual(["agree", "failure"]);
    const content = JSON.stringify(ui.inbox[1].content);
    expect(content).toContain("shipping unavailable (2 ways tried)");
    expect(content).not.toContain("HTTP 503");
    await boss.stop();
  });

  it("applies its beliefs, and sends its messages in the goal's conversation", async () => {
    const bus = new InMemoryMessageBus();
    const ui = requester(bus);
    const ops: Message[] = [];
    bus.registerAgent("ops", (m) => ops.push(m));
    const boss = agent(
      bus,
      "boss",
      [plan("ship", "courier", () => ({}), { context: () => false })],
      {
        onGoalFailure: async (goal, _beliefs, failure) => ({
          beliefUpdates: [{ key: "status", value: "failed" }],
          messages: [
            {
              receiver: "ops",
              performative: "inform",
              content: { failed: goal.name, why: failure.reason },
            },
          ],
        }),
      },
    );
    await boss.start();

    await ui.request("ship");
    await run(boss);

    // No plan was applicable, so no plan ran: the hook still runs, with no
    // attempts, and its message still belongs to the request's conversation.
    expect(boss.beliefs.get("status")).toBe("failed");
    expect(ops).toHaveLength(1);
    expect(ops[0].content).toEqual({
      failed: "ship",
      why: 'no applicable plan for "ship"',
    });
    expect(ops[0].conversationId).toBe("conv-ui");
    expect(ui.performatives()).toEqual(["agree", "failure"]);
    await boss.stop();
  });

  it("is not run for a goal that was never taken on", async () => {
    const bus = new InMemoryMessageBus();
    let hooked = 0;
    const goals: GoalFailed[] = [];
    const a = agent(bus, "a", [plan("ship", "courier", () => ({}))], {
      maxGoals: 1,
      onGoalFailure: () => void hooked++,
    });
    a.on("goal:failed", (e) => goals.push(e));
    a.goals.add(goal({ id: "x", name: "fly" })); // no plan serves it
    await run(a, 2);
    a.goals.add(goal({ id: "g1" }));
    a.goals.add(goal({ id: "g2" })); // rejected: the queue is full

    expect(goals.map((g) => g.goal.id).sort()).toEqual(["g2", "x"]);
    expect(hooked).toBe(0);
  });

  it("does not stop the failure when it throws", async () => {
    const bus = new InMemoryMessageBus();
    const goals: GoalFailed[] = [];
    const a = agent(
      bus,
      "a",
      [
        plan("ship", "courier", () => ({
          failure: { reason: "courier down" },
        })),
      ],
      {
        onGoalFailure: () => {
          throw new Error("hook broke");
        },
      },
    );
    a.on("goal:failed", (e) => goals.push(e));
    a.goals.add(goal());
    await run(a);

    expect(goals).toHaveLength(1);
    expect(goals[0].reason).toBe("courier down");
    expect(goals[0].onGoalFailureError).toBe("hook broke");
    expect(a.goals.all()).toEqual([]);
  });

  it("runs for a failed sub-goal, whose replaced reason its parent sees", async () => {
    const bus = new InMemoryMessageBus();
    const seen: string[] = [];
    const parentReasons: PlanFailure[] = [];
    const a = agent(
      bus,
      "a",
      [
        plan("ship", "split", () => ({ delegations: [{ goal: "book" }] }), {
          onPlanFailure: (_i, _b, failure) => void parentReasons.push(failure),
        }),
        plan("book", "book", () => ({ failure: { reason: "no courier" } })),
      ],
      {
        onGoalFailure: (goal) => {
          seen.push(goal.name);
          return goal.name === "book" ? { reason: "booking failed" } : {};
        },
      },
    );
    a.goals.add(goal());
    await run(a);

    expect(seen).toEqual(["book", "ship"]);
    expect(parentReasons).toHaveLength(1);
    expect(parentReasons[0].reason).toContain("booking failed");
    expect(parentReasons[0].reason).not.toContain("no courier");
  });
});
