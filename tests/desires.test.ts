import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type { DesireTriggered } from "../src/core/reasoning/index.js";
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
  });

  const triggered: DesireTriggered[] = [];
  agent.on("desire:triggered", (e) => triggered.push(e));

  return { bus, agent, notified, triggered };
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

  it("refires whenever it asks when repeat is `always`", async () => {
    const runs: string[] = [];
    const t = setup({
      plans: [plan("tick", runs)],
      desires: [
        {
          name: "keep-ticking",
          repeat: "always",
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
      repeat: "always",
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

    // The goal is still waiting on the peer, so the `always` desire never gets
    // to start a second.
    expect(received).toHaveLength(1);
    expect(triggered).toHaveLength(1);
  });

  it("treats one that throws as asking for nothing", async () => {
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
      plans: [capture],
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
