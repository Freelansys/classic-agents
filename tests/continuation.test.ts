import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  GoalContinued,
  IntentionFailed,
} from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";
import { defaultGoalSelection, type Goal } from "../src/core/goals.js";

function agent(bus: InMemoryMessageBus, id: string, plans: Plan[]): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library });
}

async function run(a: Agent, cycles = 30): Promise<void> {
  for (let i = 0; i < cycles; i++) await a.tick();
}

function step(
  name: string,
  execute: () => ActionResult | Promise<ActionResult>,
): Plan {
  return {
    name,
    body: [{ name: `${name}-step`, execute: async () => execute() }],
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

describe("Goal selection and recursive sub-goals", () => {
  it("activates a sub-goal that shares its waiting ancestor's name", () => {
    const parent: Goal = {
      id: "p",
      name: "count",
      priority: 5,
      status: "active",
    };
    const child: Goal = {
      id: "c",
      name: "count",
      priority: 5,
      status: "pending",
      parentGoalId: "p",
      rootGoalId: "p",
    };
    expect(defaultGoalSelection([child], [parent])?.id).toBe("c");
  });

  it("still holds back an unrelated goal of an active goal's name", () => {
    const running: Goal = {
      id: "a",
      name: "count",
      priority: 5,
      status: "active",
    };
    const other: Goal = {
      id: "b",
      name: "count",
      priority: 5,
      status: "pending",
    };
    const otherChild: Goal = {
      id: "c",
      name: "count",
      priority: 5,
      status: "pending",
      parentGoalId: "x",
      rootGoalId: "x",
    };
    expect(
      defaultGoalSelection([other, otherChild], [running]),
    ).toBeUndefined();
  });

  it("runs a bounded recursive plan to the end (issue reproduction)", async () => {
    const bus = new InMemoryMessageBus();
    let runs = 0;
    const a = agent(bus, "a", [
      step("count", () =>
        ++runs < 3 ? { delegations: [{ goal: "count", priority: 5 }] } : {},
      ),
    ]);
    await a.start();
    a.goals.add({ id: "g", name: "count", priority: 5, status: "pending" });
    await run(a, 50);

    expect(runs).toBe(3);
    expect(a.goals.all()).toEqual([]);
    expect(a.intentions.getAll()).toEqual([]);
    await a.stop();
  });
});

describe("continueWith", () => {
  it("loops inside one request and answers it once, at the end", async () => {
    const bus = new InMemoryMessageBus();
    let runs = 0;
    const ui = requester(bus);
    const boss = agent(bus, "boss", [
      step("count", () =>
        ++runs < 3
          ? { continueWith: { goal: "count" }, result: runs }
          : { result: runs },
      ),
    ]);
    const continued: GoalContinued[] = [];
    boss.on("goal:continued", (e) =>
      continued.push({ ...e, goal: { ...e.goal } }),
    );
    await boss.start();

    await ui.request("count");
    await run(boss);

    expect(runs).toBe(3);
    expect(continued).toHaveLength(2);
    expect(ui.performatives()).toEqual(["agree", "inform"]);
    const done = ui.inbox[1];
    expect(done.inReplyTo).toBe("req-ui");
    expect(done.content).toMatchObject({
      goal: "count",
      done: true,
      result: 3,
    });
    expect(boss.goals.all()).toEqual([]);
    await boss.stop();
  });

  it("keeps depth and intention count constant across hand-offs", async () => {
    const bus = new InMemoryMessageBus();
    let pages = 0;
    let maxIntentions = 0;
    const a = agent(bus, "a", [
      step("plan", () =>
        pages < 5 ? { continueWith: { goal: "page", data: { n: pages } } } : {},
      ),
      step("page", () => {
        pages++;
        return { continueWith: { goal: "plan" } };
      }),
    ]);
    a.on("intention:started", () => {
      maxIntentions = Math.max(maxIntentions, a.intentions.getActive().length);
    });
    await a.start();
    a.goals.add({ id: "g", name: "plan", priority: 5, status: "pending" });
    await run(a, 60);

    expect(pages).toBe(5);
    expect(maxIntentions).toBe(1);
    expect(a.goals.all()).toEqual([]);
    await a.stop();
  });

  it("lets a waiting parent wait on the continuation", async () => {
    const bus = new InMemoryMessageBus();
    let seen: unknown;
    const a = agent(bus, "a", [
      {
        name: "parent",
        body: [
          {
            name: "ask",
            execute: async () => ({ delegations: [{ goal: "first" }] }),
          },
          {
            name: "read",
            execute: async (intention) => {
              seen = intention.delegations[0].result;
              return {};
            },
          },
        ],
      },
      step("first", () => ({ continueWith: { goal: "second" } })),
      step("second", () => ({ result: "from second" })),
    ]);
    await a.start();
    a.goals.add({ id: "g", name: "parent", priority: 5, status: "pending" });
    await run(a);

    expect(seen).toBe("from second");
    expect(a.goals.all()).toEqual([]);
    await a.stop();
  });

  it("answers failure when the chain fails later on", async () => {
    const bus = new InMemoryMessageBus();
    const ui = requester(bus);
    const boss = agent(bus, "boss", [
      step("first", () => ({ continueWith: { goal: "second" } })),
      step("second", () => ({ failure: { reason: "page 2 broke" } })),
    ]);
    await boss.start();
    await ui.request("first");
    await run(boss);

    expect(ui.performatives()).toEqual(["agree", "failure"]);
    expect(JSON.stringify(ui.inbox[1].content)).toContain("page 2 broke");
    await boss.stop();
  });

  it("answers under the name the requester asked for, not the continued one", async () => {
    const bus = new InMemoryMessageBus();
    const ui = requester(bus);
    const boss = agent(bus, "boss", [
      step("fetch", () => ({ continueWith: { goal: "fetch-page" } })),
      step("fetch-page", () => ({ result: "page" })),
    ]);
    await boss.start();
    await ui.request("fetch");
    await run(boss);

    expect(ui.performatives()).toEqual(["agree", "inform"]);
    expect(ui.inbox[1].content).toMatchObject({
      goal: "fetch",
      done: true,
      result: "page",
    });
    await boss.stop();
  });

  it("names the requested goal in a failure after a hand-off", async () => {
    const bus = new InMemoryMessageBus();
    const ui = requester(bus);
    const boss = agent(bus, "boss", [
      step("fetch", () => ({ continueWith: { goal: "fetch-page" } })),
      step("fetch-page", () => ({ failure: { reason: "offline" } })),
    ]);
    await boss.start();
    await ui.request("fetch");
    await run(boss);

    expect(ui.performatives()).toEqual(["agree", "failure"]);
    expect(ui.inbox[1].content).toMatchObject({ goal: "fetch" });
    await boss.stop();
  });

  it("names the requested goal when a continued request is cancelled", async () => {
    const bus = new InMemoryMessageBus();
    const ui = requester(bus);
    const boss = agent(bus, "boss", [
      step("fetch", () => ({ continueWith: { goal: "fetch-page" } })),
      {
        ...step("fetch-page", () => ({ continueWith: { goal: "fetch-page" } })),
        cancellable: true,
      },
    ]);
    let continued = false;
    boss.on("goal:continued", () => (continued = true));
    await boss.start();
    await ui.request("fetch");
    for (let i = 0; i < 30 && !continued; i++) await boss.tick();
    expect(continued).toBe(true);

    await bus.send("boss", {
      performative: "cancel",
      sender: "ui",
      receiver: "boss",
      content: {},
      inReplyTo: "req-ui",
      conversationId: "conv-ui",
      replyWith: "cancel-ui",
      timestamp: Date.now(),
    });
    await run(boss, 5);

    const reply = ui.inbox.find((m) => m.inReplyTo === "cancel-ui");
    expect(reply?.performative).toBe("inform");
    expect(reply?.content).toMatchObject({
      cancelled: "request",
      goal: "fetch",
    });
    expect(boss.goals.all()).toEqual([]);
    await boss.stop();
  });

  it("fails the intention when used before the last action", async () => {
    const bus = new InMemoryMessageBus();
    let after = false;
    const a = agent(bus, "a", [
      {
        name: "early",
        body: [
          {
            name: "hand-off",
            execute: async () => ({ continueWith: { goal: "x" } }),
          },
          { name: "after", execute: async () => ((after = true), {}) },
        ],
      },
    ]);
    const failures: string[] = [];
    a.on("intention:failed", (e: IntentionFailed) => failures.push(e.reason));
    await a.start();
    a.goals.add({ id: "g", name: "early", priority: 5, status: "pending" });
    await run(a);

    expect(after).toBe(false);
    expect(failures).toEqual([
      'continueWith "x" is only valid from the last action of plan "early"',
    ]);
    await a.stop();
  });

  it("fails the intention when combined with delegations, starting none", async () => {
    const bus = new InMemoryMessageBus();
    let delegated = false;
    const a = agent(bus, "a", [
      step("mixed", () => ({
        delegations: [{ goal: "side" }],
        continueWith: { goal: "x" },
      })),
      step("side", () => ((delegated = true), {})),
    ]);
    const failures: string[] = [];
    a.on("intention:failed", (e: IntentionFailed) => failures.push(e.reason));
    await a.start();
    a.goals.add({ id: "g", name: "mixed", priority: 5, status: "pending" });
    await run(a);

    expect(delegated).toBe(false);
    expect(failures).toEqual([
      'continueWith "x" cannot be combined with delegations, calls or awards',
    ]);
    await a.stop();
  });
});
