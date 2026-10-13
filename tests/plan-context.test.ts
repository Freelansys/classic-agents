import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  GoalReplanned,
  IntentionFailed,
} from "../src/core/reasoning/index.js";
import { InMemoryBeliefBase } from "../src/core/beliefs.js";
import { PlanLibrary } from "../src/core/plans.js";
import type {
  ActionResult,
  ContextCondition,
  Plan,
} from "../src/core/plans.js";
import type { Goal } from "../src/core/goals.js";

function agent(bus: InMemoryMessageBus, id: string, plans: Plan[]): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library });
}

async function run(a: Agent, cycles = 20): Promise<void> {
  for (let i = 0; i < cycles; i++) await a.tick();
}

/** A one-action plan for `name`, recording its label in `log` when it runs. */
function plan(
  name: string,
  label: string,
  log: string[],
  execute: () => ActionResult,
  context?: ContextCondition,
): Plan {
  return {
    name,
    ...(context ? { context } : {}),
    body: [
      {
        name: label,
        execute: async () => {
          log.push(label);
          return execute();
        },
      },
    ],
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

describe("PlanLibrary.applicable", () => {
  it("keeps the plans whose context holds, in registration order", () => {
    const lib = new PlanLibrary();
    const a: Plan = { name: "ship", body: [], context: () => false };
    const b: Plan = { name: "ship", body: [] };
    const c: Plan = { name: "ship", body: [], context: () => true };
    const other: Plan = { name: "other", body: [] };
    for (const p of [a, b, c, other]) lib.register(p);

    expect(lib.applicable(new InMemoryBeliefBase(), goal())).toEqual([b, c]);
  });

  it("passes the beliefs and the goal to the context", () => {
    const lib = new PlanLibrary();
    const beliefs = new InMemoryBeliefBase();
    beliefs.set("courier.up", true);
    const p: Plan = {
      name: "ship",
      body: [],
      context: (bb, g) =>
        bb.get("courier.up") === true &&
        (g.data as { express?: boolean })?.express === true,
    };
    lib.register(p);

    expect(lib.applicable(beliefs, goal({ data: { express: true } }))).toEqual([
      p,
    ]);
    expect(lib.applicable(beliefs, goal({ data: {} }))).toEqual([]);
  });

  it("leaves out excluded plans and plans whose context throws", () => {
    const lib = new PlanLibrary();
    const a: Plan = { name: "ship", body: [] };
    const b: Plan = {
      name: "ship",
      body: [],
      context: () => {
        throw new Error("boom");
      },
    };
    const c: Plan = { name: "ship", body: [] };
    for (const p of [a, b, c]) lib.register(p);

    expect(
      lib.applicable(new InMemoryBeliefBase(), goal(), new Set([a])),
    ).toEqual([c]);
  });

  it("still matches by name alone, ignoring context", () => {
    const lib = new PlanLibrary();
    const p: Plan = { name: "ship", body: [], context: () => false };
    lib.register(p);

    expect(lib.match(goal())).toBe(p);
    expect(lib.declares("ship")).toBe(true);
  });
});

describe("Plan selection by context", () => {
  it("runs the first plan whose context holds", async () => {
    const bus = new InMemoryMessageBus();
    const log: string[] = [];
    const a = agent(bus, "a", [
      plan(
        "ship",
        "courier",
        log,
        () => ({}),
        (b) => b.get("courier.up") === true,
      ),
      plan("ship", "post", log, () => ({})),
    ]);
    a.goals.add(goal());
    await run(a);

    expect(log).toEqual(["post"]);
    expect(a.goals.all()).toEqual([]);
  });

  it("agrees by name, then fails at once when no plan is applicable", async () => {
    const bus = new InMemoryMessageBus();
    const log: string[] = [];
    const ui = requester(bus);
    const boss = agent(bus, "boss", [
      plan(
        "ship",
        "courier",
        log,
        () => ({}),
        () => false,
      ),
    ]);
    await boss.start();

    await ui.request("ship");
    await run(boss, 5);

    // Admission is static, so the request is agreed to; a context never
    // makes a goal wait, so it then fails rather than sitting in the queue.
    expect(log).toEqual([]);
    expect(ui.performatives()).toEqual(["agree", "failure"]);
    expect(JSON.stringify(ui.inbox[1].content)).toContain(
      'no applicable plan for \\"ship\\"',
    );
    expect(boss.goals.all()).toEqual([]);
    await boss.stop();
  });
});

describe("Alternative-plan fallback", () => {
  it("hands a failed goal to the next applicable plan and answers once", async () => {
    const bus = new InMemoryMessageBus();
    const log: string[] = [];
    const ui = requester(bus);
    const boss = agent(bus, "boss", [
      plan("ship", "courier", log, () => ({
        failure: { reason: "courier down" },
      })),
      plan("ship", "post", log, () => ({ result: "posted" })),
    ]);
    const failed: IntentionFailed[] = [];
    const replanned: GoalReplanned[] = [];
    const order: string[] = [];
    boss.on("intention:failed", (e) => {
      failed.push(e);
      order.push("intention:failed");
    });
    boss.on("goal:replanned", (e) => {
      replanned.push({ ...e, goal: { ...e.goal } });
      order.push("goal:replanned");
    });
    boss.on("intention:started", () => order.push("intention:started"));
    await boss.start();

    await ui.request("ship");
    await run(boss);

    expect(log).toEqual(["courier", "post"]);
    expect(ui.performatives()).toEqual(["agree", "inform"]);
    expect(ui.inbox[1].content).toMatchObject({
      goal: "ship",
      done: true,
      result: "posted",
    });
    expect(failed.map((f) => f.reason)).toEqual(["courier down"]);
    expect(replanned).toHaveLength(1);
    expect(replanned[0].goal.status).toBe("active");
    expect(replanned[0].reason).toBe("courier down");
    expect(replanned[0].intention.plan.body[0].name).toBe("post");
    expect(order).toEqual([
      "intention:started",
      "intention:failed",
      "goal:replanned",
      "intention:started",
    ]);
    await boss.stop();
  });

  it("fails the goal with the last reason once every plan has failed", async () => {
    const bus = new InMemoryMessageBus();
    const log: string[] = [];
    const ui = requester(bus);
    const boss = agent(bus, "boss", [
      plan("ship", "courier", log, () => ({
        failure: { reason: "courier down" },
      })),
      plan("ship", "post", log, () => {
        throw new Error("post office closed");
      }),
    ]);
    await boss.start();

    await ui.request("ship");
    await run(boss);

    // Each plan is tried once: a failed plan is not retried for the goal.
    expect(log).toEqual(["courier", "post"]);
    expect(ui.performatives()).toEqual(["agree", "failure"]);
    expect(JSON.stringify(ui.inbox[1].content)).toContain("post office closed");
    expect(boss.goals.all()).toEqual([]);
    await boss.stop();
  });

  it("re-evaluates contexts against the beliefs the failure left", async () => {
    const bus = new InMemoryMessageBus();
    const log: string[] = [];
    const a = agent(bus, "a", [
      plan("ship", "courier", log, () => ({
        beliefUpdates: [{ key: "courier.up", value: false }],
        failure: { reason: "courier down" },
      })),
      // Applicable only while the courier is believed up: skipped after the
      // first plan's failure says otherwise.
      plan(
        "ship",
        "courier-retry",
        log,
        () => ({}),
        (b) => b.get("courier.up") !== false,
      ),
      plan("ship", "post", log, () => ({})),
    ]);
    a.goals.add(goal());
    await run(a);

    expect(log).toEqual(["courier", "post"]);
    expect(a.goals.all()).toEqual([]);
  });

  it("replans a parent whose required sub-goal failed", async () => {
    const bus = new InMemoryMessageBus();
    const log: string[] = [];
    const a = agent(bus, "a", [
      {
        name: "ship",
        body: [
          {
            name: "via-courier",
            execute: async () => {
              log.push("via-courier");
              return { delegations: [{ goal: "book-courier" }] };
            },
          },
        ],
      },
      plan("ship", "post", log, () => ({})),
      plan("book-courier", "book", log, () => ({
        failure: { reason: "no courier" },
      })),
    ]);
    a.goals.add(goal());
    await run(a);

    expect(log).toEqual(["via-courier", "book", "post"]);
    expect(a.goals.all()).toEqual([]);
  });

  it("tries plans afresh after a continueWith hand-off", async () => {
    const bus = new InMemoryMessageBus();
    const log: string[] = [];
    let steps = 0;
    const a = agent(bus, "a", [
      plan("step", "fast", log, () => ({ failure: { reason: "too fast" } })),
      plan("step", "slow", log, () =>
        ++steps < 2 ? { continueWith: { goal: "step" } } : {},
      ),
    ]);
    a.goals.add(goal({ name: "step" }));
    await run(a, 30);

    expect(log).toEqual(["fast", "slow", "fast", "slow"]);
    expect(a.goals.all()).toEqual([]);
  });
});
