import { afterEach, describe, it, expect, vi } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  DesireError,
  DesireRetracted,
  DesireTriggered,
} from "../src/core/reasoning/index.js";
import { DesireLibrary } from "../src/core/desires.js";
import type { Desire } from "../src/core/desires.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";

/** A plan of one action that records its run in `log` and returns `result`. */
function plan(goal: string, log: string[], result: ActionResult = {}): Plan {
  return {
    name: goal,
    goal,
    body: [
      {
        name: `${goal}-act`,
        execute: async (): Promise<ActionResult> => {
          log.push(goal);
          return result;
        },
      },
    ],
  };
}

/** A desire that always asks for `goal`. */
function always(name: string, goal: string): Desire {
  return { name, intend: () => ({ goal }) };
}

/** An agent serving `plans` from `desires`, plus a `ui` peer watching the wire. */
function setup(
  options: {
    plans?: Plan[];
    desires?: Desire[];
    maxGoals?: number;
    maxConcurrentIntentions?: number;
  } = {},
) {
  const bus = new InMemoryMessageBus();
  const notified: Message[] = [];
  bus.registerAgent("ui", (m) => notified.push(m));

  const planLibrary = new PlanLibrary();
  for (const p of options.plans ?? []) planLibrary.register(p);

  const desires = new DesireLibrary();
  for (const d of options.desires ?? []) desires.register(d);

  const agent = new Agent({
    id: "a1",
    bus,
    planLibrary,
    desires,
    ...(options.maxGoals !== undefined ? { maxGoals: options.maxGoals } : {}),
    ...(options.maxConcurrentIntentions !== undefined
      ? { maxConcurrentIntentions: options.maxConcurrentIntentions }
      : {}),
  });

  const triggered: DesireTriggered[] = [];
  agent.on("desire:triggered", (e) => triggered.push(e));
  const errors: DesireError[] = [];
  agent.on("desire:error", (e) => errors.push(e));

  return { bus, agent, notified, triggered, errors };
}

async function run(agent: Agent, cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) await agent.tick();
}

describe("DesireLibrary", () => {
  const desire: Desire = always("d", "g");

  it("registers, lists and declares desires", () => {
    const library = new DesireLibrary();
    expect(library.all()).toEqual([]);
    expect(library.declares("d")).toBe(false);

    library.register(desire);

    expect(library.declares("d")).toBe(true);
    expect(library.declares("other")).toBe(false);
    expect(library.all()).toEqual([desire]);
  });

  it("refuses two desires of the same name", () => {
    const library = new DesireLibrary();
    library.register(desire);
    expect(() => library.register(always("d", "g"))).toThrow(
      /already registered/,
    );
  });

  it("hands out a copy of its list, not its own", () => {
    const library = new DesireLibrary();
    library.register(desire);
    library.all().push(always("x", "x"));
    expect(library.all()).toHaveLength(1);
  });
});

describe("desires: generating goals from beliefs", () => {
  it("generates and works a goal when it asks, and reports why", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [plan("cool", runs)],
      desires: [
        {
          name: "be-cool",
          intend: (beliefs) =>
            beliefs.get("hot") === true ? { goal: "cool" } : undefined,
        },
      ],
    });

    // Not asking: nothing to do, no goal, no event.
    await run(t.agent, 3);
    expect(runs).toEqual([]);
    expect(t.triggered).toEqual([]);

    t.agent.beliefs.set("hot", true);
    await run(t.agent, 3);

    expect(runs).toEqual(["cool"]);
    expect(t.triggered).toHaveLength(1);
    const { desire, goal } = t.triggered[0];
    expect(desire.name).toBe("be-cool");
    expect(goal.name).toBe("cool");
    expect(goal.desire).toBe("be-cool");
  });

  it("gives a generated goal no source, so it owes nobody a reply", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [plan("cool", runs)],
      desires: [
        {
          name: "be-cool",
          intend: (beliefs) =>
            beliefs.get("hot") ? { goal: "cool" } : undefined,
        },
      ],
    });
    t.agent.beliefs.set("hot", true);

    await run(t.agent, 5);

    expect(runs).toEqual(["cool"]);
    // No requester, so no agree, no terminal inform: the wire stays quiet.
    expect(t.notified).toEqual([]);
    expect(t.triggered[0].goal.source).toBeUndefined();
  });

  it("fires once on the rising edge of its asking by default", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [plan("cool", runs)],
      desires: [
        {
          name: "be-cool",
          intend: (beliefs) =>
            beliefs.get("hot") === true ? { goal: "cool" } : undefined,
        },
      ],
    });
    t.agent.beliefs.set("hot", true);

    // It keeps asking after the goal is achieved: it must not fire again.
    await run(t.agent, 6);
    expect(runs).toEqual(["cool"]);
    expect(t.triggered).toHaveLength(1);

    // It stops asking and asks once more: now it is a new occurrence.
    t.agent.beliefs.set("hot", false);
    await run(t.agent, 1);
    t.agent.beliefs.set("hot", true);
    await run(t.agent, 4);

    expect(runs).toEqual(["cool", "cool"]);
    expect(t.triggered).toHaveLength(2);
  });

  it("refires whenever it asks when its trigger is `level`", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [plan("tick", runs)],
      desires: [
        {
          name: "keep-ticking",
          trigger: "level",
          intend: (beliefs) =>
            beliefs.get("on") ? { goal: "tick" } : undefined,
        },
      ],
    });
    t.agent.beliefs.set("on", true);

    await run(t.agent, 9);

    expect(runs.length).toBeGreaterThan(1);
    expect(t.triggered.length).toBe(runs.length);
  });

  it("keeps only one goal in flight per desire", async () => {
    const bus = new InMemoryMessageBus();
    // A peer that never answers, so a delegation to it stays open and the
    // desire's goal stays in flight for as long as the test runs.
    const received: Message[] = [];
    bus.registerAgent("slow", (m) => received.push(m));

    const plans = new PlanLibrary();
    plans.register({
      goal: "handoff",
      body: [
        {
          name: "handoff-act",
          execute: async (): Promise<ActionResult> => ({
            delegations: [{ receiver: "slow", goal: "remote" }],
          }),
        },
      ],
    });
    const desires = new DesireLibrary();
    desires.register({
      name: "go",
      trigger: "level",
      intend: () => ({ goal: "handoff" }),
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: plans,
      desires,
      delegationTimeoutMs: 0,
    });
    const triggered: DesireTriggered[] = [];
    agent.on("desire:triggered", (e) => triggered.push(e));
    await agent.start();

    for (let i = 0; i < 12; i++) await agent.tick();

    // The goal is still waiting on the peer, so the `level` desire never gets
    // to start a second.
    expect(received).toHaveLength(1);
    expect(triggered).toHaveLength(1);
  });

  it("reports one that throws, once, and generates nothing", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [plan("cool", runs)],
      desires: [
        {
          name: "broken",
          intend: () => {
            throw new Error("sensor offline");
          },
        },
      ],
    });

    await run(t.agent, 5);
    expect(runs).toEqual([]);
    expect(t.triggered).toEqual([]);
    expect(t.errors.map((e) => [e.desire.name, e.reason])).toEqual([
      ["broken", "intend threw: sensor offline"],
    ]);
  });

  it("does not take a throw for a fall, so a flaky intend does not refire", async () => {
    const runs: string[] = [];
    let flaky = false;
    const t = setup({
      plans: [plan("cool", runs)],
      desires: [
        {
          name: "be-cool",
          intend: () => {
            if (flaky) throw new Error("sensor glitch");
            return { goal: "cool" };
          },
        },
      ],
    });

    await run(t.agent, 3);
    expect(runs).toEqual(["cool"]);

    // A glitch while it keeps asking says nothing about whether it is asking:
    // it must not count as stopping and starting again.
    flaky = true;
    await run(t.agent, 1);
    flaky = false;
    await run(t.agent, 3);

    expect(runs).toEqual(["cool"]);
    expect(t.triggered).toHaveLength(1);
    expect(t.errors).toHaveLength(1);
  });
});

describe("desires: the goal they ask for", () => {
  it("shapes goal, priority and data from the situation", async () => {
    const seen: Array<{ name: string; data: unknown }> = [];
    const capture: Plan = {
      name: "cool",
      goal: "cool",
      body: [
        {
          name: "capture",
          execute: async (intention): Promise<ActionResult> => {
            seen.push({ name: intention.goal.name, data: intention.goal.data });
            return {};
          },
        },
      ],
    };
    const t = setup({
      plans: [capture, { ...capture, name: "cool-fast", goal: "cool-fast" }],
      desires: [
        {
          name: "weather-driven",
          intend: (beliefs) => {
            const temperature = beliefs.get<number>("temp") ?? 0;
            if (temperature <= 30) return undefined;
            return {
              // The situation decides the goal, its priority and its data.
              goal: temperature > 40 ? "cool-fast" : "cool",
              priority: temperature > 40 ? 10 : 5,
              data: { at: beliefs.get("room") },
            };
          },
        },
      ],
    });
    t.agent.beliefs.set("room", "kitchen");

    t.agent.beliefs.set("temp", 35);
    await run(t.agent, 3);

    expect(t.triggered[0].goal.name).toBe("cool");
    expect(t.triggered[0].goal.priority).toBe(5);
    expect(seen).toEqual([{ name: "cool", data: { at: "kitchen" } }]);

    // A new, hotter situation, and the desire asks for something else.
    t.agent.beliefs.set("temp", 20);
    await run(t.agent, 1);
    t.agent.beliefs.set("temp", 45);
    await run(t.agent, 3);

    expect(t.triggered[1].goal.name).toBe("cool-fast");
    expect(t.triggered[1].goal.priority).toBe(10);
  });

  it("carries a static data value as-is", async () => {
    const t = setup({
      plans: [plan("cool", [])],
      desires: [
        {
          name: "d",
          intend: () => ({ goal: "cool", data: { fan: "high" } }),
        },
      ],
    });
    await run(t.agent, 2);
    expect(t.triggered[0].goal.data).toEqual({ fan: "high" });
  });

  it("defaults priority to 5, like a self-delegated sub-goal", async () => {
    const t = setup({
      plans: [plan("cool", [])],
      desires: [always("d", "cool")],
    });
    await run(t.agent, 2);
    expect(t.triggered[0].goal.priority).toBe(5);
  });

  it("forwards dependsOn, so the goal waits on its dependencies", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [plan("cool", runs)],
      desires: [
        {
          name: "d",
          intend: () => ({
            goal: "cool",
            dependsOn: ["goal-that-never-finishes"],
          }),
        },
      ],
    });

    await run(t.agent, 5);

    expect(t.triggered).toHaveLength(1);
    expect(t.triggered[0].goal.dependsOn).toEqual(["goal-that-never-finishes"]);
    // Its dependency is unmet, so the plan never runs.
    expect(runs).toEqual([]);
  });

  it("treats the goal as any other: its plan may spawn further goals", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [
        plan("parent", [], { spawn: [{ name: "child", priority: 5 }] }),
        plan("child", runs),
      ],
      desires: [always("d", "parent")],
    });

    await run(t.agent, 6);

    expect(runs).toEqual(["child"]);
  });
});

describe("desires: the goal bound", () => {
  it("waits for room instead of generating a goal the queue would reject", async () => {
    const runs: string[] = [];
    const t = setup({
      maxGoals: 1,
      plans: [plan("first", runs), plan("second", runs)],
      desires: [always("one", "first"), always("two", "second")],
    });

    // Both ask, but only one goal fits. The first desire takes the slot; the
    // second holds off rather than being rejected.
    await run(t.agent, 1);
    expect(t.triggered.map((e) => e.desire.name)).toEqual(["one"]);

    // With `once`, the first does not refire; once it finishes and the queue
    // has room, the second fires.
    await run(t.agent, 6);
    expect(t.triggered.map((e) => e.desire.name)).toEqual(["one", "two"]);
    expect(runs).toEqual(["first", "second"]);
  });
});

describe("desires: across the bus", () => {
  it("drives a desire-generated goal to delegate to another agent", async () => {
    const bus = new InMemoryMessageBus();

    const workerRuns: string[] = [];
    const workerPlans = new PlanLibrary();
    workerPlans.register({
      goal: "work",
      body: [
        {
          name: "work-act",
          execute: async (): Promise<ActionResult> => {
            workerRuns.push("work");
            return {};
          },
        },
      ],
    });
    const worker = new Agent({ id: "b", bus, planLibrary: workerPlans });

    const delegating: Plan = {
      name: "get-it",
      goal: "get-it",
      body: [
        {
          name: "delegate",
          execute: async (): Promise<ActionResult> => ({
            delegations: [{ receiver: "b", goal: "work" }],
          }),
        },
      ],
    };
    const desires = new DesireLibrary();
    desires.register({
      name: "need-it",
      intend: (beliefs) =>
        beliefs.get("needs") ? { goal: "get-it" } : undefined,
    });
    const plans = new PlanLibrary();
    plans.register(delegating);
    const manager = new Agent({
      id: "a",
      bus,
      planLibrary: plans,
      desires,
    });

    const completed: string[] = [];
    manager.on("intention:completed", (i) => completed.push(i.goal.name));

    await manager.start();
    await worker.start();
    manager.beliefs.set("needs", true);

    for (let i = 0; i < 20; i++) {
      await manager.tick();
      await worker.tick();
    }

    expect(workerRuns).toEqual(["work"]);
    expect(completed).toEqual(["get-it"]);
  });
});

/** A plan of one action that fails, recording each attempt in `log`. */
function failing(goal: string, log: string[]): Plan {
  return {
    name: goal,
    goal,
    body: [
      {
        name: `${goal}-act`,
        execute: async (): Promise<ActionResult> => {
          log.push(goal);
          return { failure: { reason: "cannot" } };
        },
      },
    ],
  };
}

describe("desires: a goal no plan serves", () => {
  it("is not generated, and the desire is reported once", async () => {
    const t = setup({ desires: [always("wish", "fly")] });

    await run(t.agent, 5);

    expect(t.agent.goals.all()).toEqual([]);
    expect(t.triggered).toEqual([]);
    expect(t.errors.map((e) => e.reason)).toEqual(['no plan serves "fly"']);
  });

  it("fires once a plan for it is registered", async () => {
    const runs: string[] = [];
    const t = setup({ desires: [always("wish", "fly")] });
    await run(t.agent, 2);

    t.agent.planLibrary.register(plan("fly", runs));
    await run(t.agent, 3);

    expect(runs).toEqual(["fly"]);
    expect(t.triggered).toHaveLength(1);
  });
});

describe("desires: retrying a goal that failed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits retryAfterMs before a level desire fires again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const runs: string[] = [];
    const t = setup({
      plans: [failing("poll", runs)],
      desires: [
        {
          name: "keep-polling",
          trigger: "level",
          retryAfterMs: 5_000,
          intend: () => ({ goal: "poll" }),
        },
      ],
    });

    await run(t.agent, 10);
    expect(runs).toEqual(["poll"]);

    vi.advanceTimersByTime(5_000);
    await run(t.agent, 3);
    expect(runs).toEqual(["poll", "poll"]);
  });

  it("defaults to a delay, so a failing goal is not re-run every cycle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const runs: string[] = [];
    const t = setup({
      plans: [failing("poll", runs)],
      desires: [
        {
          name: "keep-polling",
          trigger: "level",
          intend: () => ({ goal: "poll" }),
        },
      ],
    });

    await run(t.agent, 10);
    expect(runs).toEqual(["poll"]);

    vi.advanceTimersByTime(1_000);
    await run(t.agent, 3);
    expect(runs).toEqual(["poll", "poll"]);
  });

  it("retries at once with retryAfterMs 0", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [failing("poll", runs)],
      desires: [
        {
          name: "keep-polling",
          trigger: "level",
          retryAfterMs: 0,
          intend: () => ({ goal: "poll" }),
        },
      ],
    });

    await run(t.agent, 6);
    expect(runs.length).toBeGreaterThan(2);
  });

  it("does not delay a goal that was achieved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const runs: string[] = [];
    const t = setup({
      plans: [plan("tick", runs)],
      desires: [
        {
          name: "keep-ticking",
          trigger: "level",
          retryAfterMs: 60_000,
          intend: () => ({ goal: "tick" }),
        },
      ],
    });

    await run(t.agent, 6);
    expect(runs.length).toBeGreaterThan(2);
  });
});

describe("desires: retracting", () => {
  /** An agent whose desire `go` hands off to a peer that never answers. */
  function handoff(options: {
    onRetract?: "keep" | "withdraw";
    cancellable?: boolean;
  }) {
    const bus = new InMemoryMessageBus();
    const received: Message[] = [];
    bus.registerAgent("slow", (m) => received.push(m));

    const plans = new PlanLibrary();
    plans.register({
      goal: "handoff",
      ...(options.cancellable ? { cancellable: true } : {}),
      body: [
        {
          name: "handoff-act",
          execute: async (): Promise<ActionResult> => ({
            delegations: [{ receiver: "slow", goal: "remote" }],
          }),
        },
      ],
    });
    const desires = new DesireLibrary();
    desires.register({
      name: "go",
      ...(options.onRetract ? { onRetract: options.onRetract } : {}),
      intend: (beliefs) =>
        beliefs.get("wanted") === true ? { goal: "handoff" } : undefined,
    });
    const agent = new Agent({ id: "a1", bus, planLibrary: plans, desires });
    const retracted: DesireRetracted[] = [];
    agent.on("desire:retracted", (e) => retracted.push(e));
    return { agent, received, retracted };
  }

  it("keeps the goal in flight by default when the desire stops asking", async () => {
    const t = handoff({ cancellable: true });
    await t.agent.start();
    t.agent.beliefs.set("wanted", true);
    await run(t.agent, 3);
    const [goal] = t.agent.goals.getUnfinished();
    expect(goal?.desire).toBe("go");

    t.agent.beliefs.set("wanted", false);
    await run(t.agent, 3);

    expect(t.agent.goals.get(goal!.id)?.status).toBe("active");
    expect(t.retracted).toEqual([]);
  });

  it("withdraws the goal in flight with onRetract `withdraw`", async () => {
    const t = handoff({ onRetract: "withdraw", cancellable: true });
    await t.agent.start();
    t.agent.beliefs.set("wanted", true);
    await run(t.agent, 3);
    const [goal] = t.agent.goals.getUnfinished();

    t.agent.beliefs.set("wanted", false);
    await run(t.agent, 2);

    expect(t.agent.goals.get(goal!.id)).toBeUndefined();
    expect(t.retracted).toHaveLength(1);
    expect(t.retracted[0].withdrawn).toBe(true);
    expect(t.retracted[0].goal.id).toBe(goal!.id);
    // The delegate is told the work is no longer wanted.
    expect(t.received.map((m) => m.performative)).toContain("cancel");
  });

  it("lets started work that is not cancellable carry on", async () => {
    const t = handoff({ onRetract: "withdraw" });
    await t.agent.start();
    t.agent.beliefs.set("wanted", true);
    await run(t.agent, 3);
    const [goal] = t.agent.goals.getUnfinished();

    t.agent.beliefs.set("wanted", false);
    await run(t.agent, 2);

    expect(t.agent.goals.get(goal!.id)?.status).toBe("active");
    expect(t.retracted).toHaveLength(1);
    expect(t.retracted[0].withdrawn).toBe(false);
    expect(t.retracted[0].reason).toMatch(/not cancellable/);
  });
});

describe("desires: competing for room", () => {
  it("fires the higher-priority goal first when only one fits", async () => {
    const runs: string[] = [];
    const t = setup({
      maxGoals: 1,
      plans: [plan("low", runs), plan("high", runs)],
      desires: [
        { name: "first", intend: () => ({ goal: "low", priority: 1 }) },
        { name: "second", intend: () => ({ goal: "high", priority: 9 }) },
      ],
    });

    await run(t.agent, 6);

    expect(runs).toEqual(["high", "low"]);
  });
});

describe("desires: fanning out per item", () => {
  interface Lead {
    id: string;
    score?: number;
  }

  /** A plan for `qualify` that records which lead it ran for. */
  function qualify(log: string[]): Plan {
    return {
      goal: "qualify",
      body: [
        {
          name: "qualify-act",
          execute: async (intention): Promise<ActionResult> => {
            log.push((intention.goal.data as Lead).id);
            return {};
          },
        },
      ],
    };
  }

  /** One `qualify` goal per lead in `leads`, keyed by lead id. */
  function perLead(extra: Partial<Desire> = {}): Desire {
    return {
      name: "qualify-leads",
      intend: (beliefs) =>
        (beliefs.get<Lead[]>("leads") ?? []).map((lead) => ({
          goal: "qualify",
          key: lead.id,
          data: lead,
        })),
      ...extra,
    };
  }

  /** An agent whose `qualify` plan hands off to a peer that never answers. */
  function handoff(onRetract?: "keep" | "withdraw") {
    const bus = new InMemoryMessageBus();
    bus.registerAgent("slow", () => {});
    const plans = new PlanLibrary();
    plans.register({
      goal: "qualify",
      cancellable: true,
      body: [
        {
          name: "qualify-act",
          execute: async (): Promise<ActionResult> => ({
            delegations: [{ receiver: "slow", goal: "research" }],
          }),
        },
      ],
    });
    const desires = new DesireLibrary();
    desires.register(perLead(onRetract ? { onRetract } : {}));
    const agent = new Agent({ id: "a1", bus, planLibrary: plans, desires });
    const retracted: DesireRetracted[] = [];
    agent.on("desire:retracted", (e) => retracted.push(e));
    return { agent, retracted };
  }

  it("fires a goal per item, and runs them side by side", async () => {
    const t = handoff();
    await t.agent.start();
    t.agent.beliefs.set("leads", [{ id: "a" }, { id: "b" }, { id: "c" }]);
    await run(t.agent, 6);

    const goals = t.agent.goals.getUnfinished();
    expect(goals.map((g) => g.key).sort()).toEqual(["a", "b", "c"]);
    // Same goal name, different leads: all three are worked at once.
    expect(goals.every((g) => g.status === "active")).toBe(true);
    expect(goals.every((g) => g.desire === "qualify-leads")).toBe(true);
  });

  it("fires once per item, and for a new item when it appears", async () => {
    const log: string[] = [];
    const t = setup({ plans: [qualify(log)], desires: [perLead()] });
    t.agent.beliefs.set("leads", [{ id: "a" }, { id: "b" }]);
    await run(t.agent, 6);
    expect(log.sort()).toEqual(["a", "b"]);

    t.agent.beliefs.set("leads", [{ id: "a" }, { id: "b" }, { id: "c" }]);
    await run(t.agent, 6);

    expect(log.sort()).toEqual(["a", "b", "c"]);
    expect(t.triggered).toHaveLength(3);
  });

  it("fires again for an item that left and came back", async () => {
    const log: string[] = [];
    const t = setup({ plans: [qualify(log)], desires: [perLead()] });
    t.agent.beliefs.set("leads", [{ id: "a" }, { id: "b" }]);
    await run(t.agent, 6);

    t.agent.beliefs.set("leads", [{ id: "b" }]);
    await run(t.agent, 2);
    t.agent.beliefs.set("leads", [{ id: "a" }, { id: "b" }]);
    await run(t.agent, 6);

    expect(log.sort()).toEqual(["a", "a", "b"]);
  });

  it("takes an item whose data changes under the same key as the same item", async () => {
    const log: string[] = [];
    const t = setup({ plans: [qualify(log)], desires: [perLead()] });
    t.agent.beliefs.set("leads", [{ id: "a", score: 1 }]);
    await run(t.agent, 6);

    t.agent.beliefs.set("leads", [{ id: "a", score: 2 }]);
    await run(t.agent, 6);

    expect(log).toEqual(["a"]);
  });

  it("tells items without a key apart by their data", async () => {
    const log: string[] = [];
    const t = setup({
      plans: [qualify(log)],
      desires: [
        {
          name: "qualify-leads",
          intend: () => [
            { goal: "qualify", data: { id: "a" } },
            { goal: "qualify", data: { id: "b" } },
          ],
        },
      ],
    });

    await run(t.agent, 6);

    expect(log.sort()).toEqual(["a", "b"]);
    expect(t.errors).toEqual([]);
  });

  it("reports two items with one key, once, and fires the first", async () => {
    const log: string[] = [];
    const t = setup({
      plans: [qualify(log)],
      desires: [
        {
          name: "qualify-leads",
          intend: () => [
            { goal: "qualify", key: "a", data: { id: "first" } },
            { goal: "qualify", key: "a", data: { id: "second" } },
          ],
        },
      ],
    });

    await run(t.agent, 6);

    expect(log).toEqual(["first"]);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].reason).toMatch(/twice for key "a"/);
  });

  it("is not asking when it returns an empty list", async () => {
    const log: string[] = [];
    const t = setup({ plans: [qualify(log)], desires: [perLead()] });
    t.agent.beliefs.set("leads", []);
    await run(t.agent, 3);
    expect(log).toEqual([]);
    expect(t.triggered).toEqual([]);
  });

  it("withdraws only the goal of the item that dropped out", async () => {
    const t = handoff("withdraw");
    await t.agent.start();
    t.agent.beliefs.set("leads", [{ id: "a" }, { id: "b" }]);
    await run(t.agent, 6);
    const byKey = new Map(t.agent.goals.getUnfinished().map((g) => [g.key, g]));

    t.agent.beliefs.set("leads", [{ id: "b" }]);
    await run(t.agent, 2);

    expect(t.retracted).toHaveLength(1);
    expect(t.retracted[0].goal.id).toBe(byKey.get("a")!.id);
    expect(t.agent.goals.get(byKey.get("a")!.id)).toBeUndefined();
    expect(t.agent.goals.get(byKey.get("b")!.id)?.status).toBe("active");
  });

  it("forgets an item once it has left and its goal is done", async () => {
    const log: string[] = [];
    const t = setup({ plans: [qualify(log)], desires: [perLead()] });
    const states = (
      t.agent as unknown as {
        desireStates: Map<string, { items: Map<string, unknown> }>;
      }
    ).desireStates;
    t.agent.beliefs.set("leads", [{ id: "a" }, { id: "b" }]);
    await run(t.agent, 6);
    expect(states.get("qualify-leads")?.items.size).toBe(2);

    t.agent.beliefs.set("leads", []);
    await run(t.agent, 2);

    expect(states.get("qualify-leads")?.items.size).toBe(0);
  });
});
