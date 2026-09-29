import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent, FAILURE_TOPIC } from "../src/core/reasoning.js";
import { PlanLibrary } from "../src/core/plans.js";
import { InMemoryBeliefBase } from "../src/core/beliefs.js";
import { resetIntentionCounter } from "../src/core/intentions.js";
import type { Action, ActionResult, Plan } from "../src/core/plans.js";

function createAgent(
  id: string,
  bus: InMemoryMessageBus,
  plans: Plan[],
): Agent {
  const lib = new PlanLibrary();
  for (const plan of plans) {
    lib.register(plan);
  }
  return new Agent({ id, bus, planLibrary: lib });
}

describe("Agent reasoning cycle", () => {
  it("processes messages into beliefs", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      performative: "inform",
      sender: "a2",
      content: { temperature: 22 },
      timestamp: Date.now(),
    });

    await agent.tick();
    expect(agent.beliefs.get("msg.temperature")).toBe(22);

    agent.stop();
  });

  it("uses an injected belief store", async () => {
    const bus = new InMemoryMessageBus();
    const store = new InMemoryBeliefBase();
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      beliefs: store,
    });

    agent.start();
    await bus.send("a1", {
      performative: "inform",
      sender: "a2",
      content: { temperature: 18 },
      timestamp: Date.now(),
    });

    await agent.tick();
    expect(agent.beliefs).toBe(store);
    expect(store.get("msg.temperature")).toBe(18);

    agent.stop();
  });

  it("creates goals from request messages", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "a2",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });

    await agent.tick();
    const allGoals = agent.goals.all();
    expect(allGoals.some((g) => g.name === "fetchData")).toBe(true);

    agent.stop();
  });

  it("receives published messages through a subscribed topic", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.start();
    await agent.subscribe("weather");
    await bus.publish("weather", {
      performative: "inform",
      sender: "station",
      topic: "weather",
      content: { temperature: 24 },
      timestamp: Date.now(),
    });

    await agent.tick();
    expect(agent.beliefs.get("msg.temperature")).toBe(24);

    agent.stop();
  });

  it("unsubscribe stops topic delivery", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.start();
    const unsub = await agent.subscribe("events");
    unsub();
    await bus.publish("events", {
      performative: "inform",
      sender: "other",
      topic: "events",
      content: { ping: true },
      timestamp: Date.now(),
    });

    await agent.tick();
    expect(agent.beliefs.has("msg.ping")).toBe(false);

    agent.stop();
  });

  it("keeps topic subscriptions across stop and restart", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.start();
    await agent.subscribe("telemetry");
    agent.stop();

    agent.start();
    await bus.publish("telemetry", {
      performative: "inform",
      sender: "sensor",
      topic: "telemetry",
      content: { voltage: 12.5 },
      timestamp: Date.now(),
    });

    await agent.tick();
    expect(agent.beliefs.get("msg.voltage")).toBe(12.5);

    agent.stop();
  });

  it("subscribing before start does not double-deliver messages", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.subscribe("reqs");
    agent.start();

    await bus.publish("reqs", {
      performative: "request",
      sender: "other",
      topic: "reqs",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });

    expect(
      agent.goals.all().filter((g) => g.name === "fetchData"),
    ).toHaveLength(1);

    agent.stop();
  });

  it("selects and activates a goal via deliberate step", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.goals.add({
      id: "g1",
      name: "highPri",
      priority: 10,
      status: "pending",
    });
    agent.goals.add({
      id: "g2",
      name: "lowPri",
      priority: 1,
      status: "pending",
    });

    agent.start();
    await agent.tick();

    const active = agent.goals.getByStatus("active");
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("highPri");

    agent.stop();
  });

  it("executes an intention through completion", async () => {
    const bus = new InMemoryMessageBus();
    let actionExecuted = false;

    const plan: Plan = {
      name: "do-thing",
      trigger: (_, goal) => goal.name === "doThing",
      body: [
        {
          name: "step1",
          execute: async (): Promise<ActionResult> => {
            actionExecuted = true;
            return { beliefUpdates: [{ key: "done", value: true }] };
          },
        },
      ],
    };

    const agent = createAgent("a1", bus, [plan]);
    agent.goals.add({
      id: "g1",
      name: "doThing",
      priority: 5,
      status: "pending",
    });

    agent.start();
    await agent.tick();
    await agent.tick();

    expect(actionExecuted).toBe(true);
    expect(agent.beliefs.get("done")).toBe(true);
    expect(agent.goals.get("g1")?.status).toBe("achieved");

    agent.stop();
  });

  it("two agents exchange messages and reach a goal", async () => {
    const bus = new InMemoryMessageBus();

    const reporterPlan: Plan = {
      name: "report",
      trigger: (beliefs) => !beliefs.has("reported"),
      body: [
        {
          name: "send-report",
          execute: async (_intention, beliefs): Promise<ActionResult> => {
            const temp = beliefs.get<number>("msg.temperature");
            return {
              beliefUpdates: [{ key: "reported", value: true }],
              messages: [
                {
                  receiver: "analyzer",
                  performative: "inform",
                  content: { analysis: `Temp is ${temp}` },
                },
              ],
            };
          },
        },
      ],
    };

    const analyzerPlan: Plan = {
      name: "analyze",
      trigger: (beliefs) => beliefs.has("msg.analysis"),
      body: [
        {
          name: "record",
          execute: async (_intention, beliefs): Promise<ActionResult> => {
            const analysis = beliefs.get<string>("msg.analysis");
            return {
              beliefUpdates: [{ key: "analysisResult", value: analysis }],
            };
          },
        },
      ],
    };

    const reporter = createAgent("reporter", bus, [reporterPlan]);
    const analyzer = createAgent("analyzer", bus, [analyzerPlan]);

    reporter.start();
    analyzer.start();

    await bus.send("reporter", {
      performative: "inform",
      sender: "sensor",
      content: { temperature: 30 },
      timestamp: Date.now(),
    });

    // Run several ticks to let the cycle propagate
    for (let i = 0; i < 5; i++) {
      await reporter.tick();
      await analyzer.tick();
    }

    expect(reporter.beliefs.get("reported")).toBe(true);
    expect(analyzer.beliefs.get("analysisResult")).toBe("Temp is 30");

    reporter.stop();
    analyzer.stop();
  });

  it("handles multi-step plans", async () => {
    const bus = new InMemoryMessageBus();
    const steps: string[] = [];

    const plan: Plan = {
      name: "multi-step",
      trigger: (_, goal) => goal.name === "multi",
      body: [
        {
          name: "step1",
          execute: async (): Promise<ActionResult> => {
            steps.push("step1");
            return { beliefUpdates: [{ key: "s1done", value: true }] };
          },
        },
        {
          name: "step2",
          execute: async (): Promise<ActionResult> => {
            steps.push("step2");
            return { beliefUpdates: [{ key: "s2done", value: true }] };
          },
        },
        {
          name: "step3",
          execute: async (): Promise<ActionResult> => {
            steps.push("step3");
            return {};
          },
        },
      ],
    };

    const agent = createAgent("a1", bus, [plan]);
    agent.goals.add({
      id: "g1",
      name: "multi",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(steps).toEqual(["step1", "step2", "step3"]);
    expect(agent.goals.get("g1")?.status).toBe("achieved");

    agent.stop();
  });

  it("applies remaining action results when an action reports a failure", async () => {
    const bus = new InMemoryMessageBus();
    const alerts: Message[] = [];
    const failures: Message[] = [];
    await bus.subscribe("alerts", (msg) => alerts.push(msg));
    await bus.subscribe(FAILURE_TOPIC, (msg) => failures.push(msg));

    const plan: Plan = {
      name: "risky",
      trigger: (_, goal) => goal.name === "risky",
      body: [
        {
          name: "attempt",
          execute: async (): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "partial", value: true }],
            beliefRemovals: ["stale"],
            newGoals: [{ name: "cleanup", priority: 4 }],
            messages: [
              {
                topic: "alerts",
                performative: "inform",
                content: { note: "half done" },
              },
            ],
            failure: { reason: "network unreachable" },
          }),
        },
      ],
    };

    const agent = createAgent("a1", bus, [plan]);
    agent.beliefs.set("stale", true);
    agent.goals.add({
      id: "g-risky",
      name: "risky",
      priority: 5,
      status: "pending",
    });
    agent.goals.add({
      id: "g-blocked",
      name: "blocked",
      priority: 1,
      status: "pending",
      dependsOn: ["g-risky"],
    });

    agent.start();
    await agent.tick();
    await agent.tick();

    expect(agent.beliefs.get("partial")).toBe(true);
    expect(agent.beliefs.has("stale")).toBe(false);
    expect(agent.goals.all().some((g) => g.name === "cleanup")).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].content).toEqual({ note: "half done" });

    expect(agent.goals.get("g-risky")?.status).toBe("failed");
    expect(agent.goals.get("g-blocked")?.status).toBe("dropped");
    const intention = agent.intentions.getAll()[0];
    expect(intention.status).toBe("failed");
    expect(intention.failureReason).toBe("network unreachable");

    expect(failures).toHaveLength(1);
    expect(failures[0].sender).toBe("a1");
    expect(failures[0].topic).toBe(FAILURE_TOPIC);
    expect(failures[0].content).toEqual({
      "failure.a1": {
        agentId: "a1",
        intentionId: intention.id,
        goalId: "g-risky",
        goal: "risky",
        plan: "risky",
        action: "attempt",
        reason: "network unreachable",
      },
    });

    agent.stop();
  });

  it("publishes a failure message when an action throws", async () => {
    const bus = new InMemoryMessageBus();
    const failures: Message[] = [];
    await bus.subscribe(FAILURE_TOPIC, (msg) => failures.push(msg));

    const plan: Plan = {
      name: "explode",
      trigger: (_, goal) => goal.name === "explode",
      body: [
        {
          name: "boom",
          execute: async (): Promise<ActionResult> => {
            throw new Error("kaboom");
          },
        },
      ],
    };

    const agent = createAgent("a1", bus, [plan]);
    agent.goals.add({
      id: "g1",
      name: "explode",
      priority: 5,
      status: "pending",
    });

    agent.start();
    await agent.tick();
    await agent.tick();

    expect(agent.goals.get("g1")?.status).toBe("failed");
    expect(agent.intentions.getAll()[0].failureReason).toBe("kaboom");
    expect(failures).toHaveLength(1);
    expect(failures[0].content).toMatchObject({
      "failure.a1": { agentId: "a1", reason: "kaboom", action: "boom" },
    });

    agent.stop();
  });

  it("keeps each agent's failure as a separate belief for monitors", async () => {
    const bus = new InMemoryMessageBus();

    const makePlan = (): Plan => ({
      name: "explode",
      trigger: (_, goal) => goal.name === "explode",
      body: [
        {
          name: "boom",
          execute: async (): Promise<ActionResult> => {
            throw new Error("boom");
          },
        },
      ],
    });

    const monitor = createAgent("monitor", bus, []);
    await monitor.subscribe(FAILURE_TOPIC);
    monitor.start();

    for (const id of ["a1", "a2"]) {
      const agent = createAgent(id, bus, [makePlan()]);
      agent.goals.add({
        id: `g-${id}`,
        name: "explode",
        priority: 5,
        status: "pending",
      });
      agent.start();
      await agent.tick();
      await agent.tick();
      agent.stop();
    }

    await monitor.tick();

    expect(
      monitor.beliefs
        .queryByPrefix("msg.failure.")
        .map(({ key }) => key)
        .sort(),
    ).toEqual(["msg.failure.a1", "msg.failure.a2"]);
    expect(
      monitor.beliefs.get<{ reason: string }>("msg.failure.a1")?.reason,
    ).toBe("boom");

    monitor.stop();
  });
});

describe("Agent sub-goal failures", () => {
  const parentPlan: Plan = {
    name: "parent",
    trigger: (_, goal) => goal.name === "parent",
    body: [
      {
        name: "spawn",
        execute: async (): Promise<ActionResult> => ({
          newGoals: [{ name: "child", priority: 10 }],
        }),
      },
      { name: "after", execute: async (): Promise<ActionResult> => ({}) },
    ],
  };

  const childPlan: Plan = {
    name: "child",
    trigger: (_, goal) => goal.name === "child",
    body: [
      {
        name: "boom",
        execute: async (): Promise<ActionResult> => ({
          failure: { reason: "x" },
        }),
      },
    ],
  };

  it("fails the waiting parent instead of leaving it waiting forever", async () => {
    const bus = new InMemoryMessageBus();
    const failures: Message[] = [];
    await bus.subscribe(FAILURE_TOPIC, (msg) => failures.push(msg));

    const agent = createAgent("a1", bus, [parentPlan, childPlan]);
    agent.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 30; i++) {
      await agent.tick();
    }

    expect(
      agent.goals
        .all()
        .map((g) => `${g.name}:${g.status}`)
        .sort(),
    ).toEqual(["child:failed", "parent:failed"]);

    const parent = agent.intentions
      .getAll()
      .find((i) => i.plan.name === "parent")!;
    expect(parent.status).toBe("failed");
    expect(parent.failureReason).toBe('sub-goal "child" failed: x');

    // The stuck parent used to hold a getActive() slot forever.
    expect(agent.intentions.getActive()).toHaveLength(0);

    expect(
      failures.map(
        (m) =>
          (m.content as Record<string, { reason: string }>)["failure.a1"]!
            .reason,
      ),
    ).toEqual(["x", 'sub-goal "child" failed: x']);

    agent.stop();
  });

  it("cascades a sub-goal failure up through waiting ancestors", async () => {
    const bus = new InMemoryMessageBus();

    const plans: Plan[] = [
      {
        name: "top",
        trigger: (_, goal) => goal.name === "top",
        body: [
          {
            name: "spawn",
            execute: async (): Promise<ActionResult> => ({
              newGoals: [{ name: "middle", priority: 10 }],
            }),
          },
          { name: "after", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
      {
        name: "middle",
        trigger: (_, goal) => goal.name === "middle",
        body: [
          {
            name: "spawn",
            execute: async (): Promise<ActionResult> => ({
              newGoals: [{ name: "leaf", priority: 10 }],
            }),
          },
          { name: "after", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
      {
        name: "leaf",
        trigger: (_, goal) => goal.name === "leaf",
        body: [
          {
            name: "boom",
            execute: async (): Promise<ActionResult> => {
              throw new Error("deep");
            },
          },
        ],
      },
    ];

    const agent = createAgent("a1", bus, plans);
    agent.goals.add({
      id: "g-top",
      name: "top",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 30; i++) {
      await agent.tick();
    }

    expect(
      agent.goals
        .all()
        .map((g) => `${g.name}:${g.status}`)
        .sort(),
    ).toEqual(["leaf:failed", "middle:failed", "top:failed"]);

    const reasons = new Map(
      agent.intentions
        .getAll()
        .map((i) => [i.plan.name, i.failureReason] as const),
    );
    expect(reasons.get("leaf")).toBe("deep");
    expect(reasons.get("middle")).toBe('sub-goal "leaf" failed: deep');
    expect(reasons.get("top")).toBe(
      'sub-goal "middle" failed: sub-goal "leaf" failed: deep',
    );
    expect(agent.intentions.getActive()).toHaveLength(0);

    agent.stop();
  });

  it("fails a parent only once when several sub-goals fail", async () => {
    const bus = new InMemoryMessageBus();
    const failures: Message[] = [];
    await bus.subscribe(FAILURE_TOPIC, (msg) => failures.push(msg));

    const twoChildren: Plan = {
      name: "parent",
      trigger: (_, goal) => goal.name === "parent",
      body: [
        {
          name: "spawn",
          execute: async (): Promise<ActionResult> => ({
            newGoals: [
              { name: "childA", priority: 10 },
              { name: "childB", priority: 9 },
            ],
          }),
        },
        { name: "after", execute: async (): Promise<ActionResult> => ({}) },
      ],
    };

    const failing = (name: string): Plan => ({
      name,
      trigger: (_, goal) => goal.name === name,
      body: [
        {
          name: "boom",
          execute: async (): Promise<ActionResult> => ({
            failure: { reason: name },
          }),
        },
      ],
    });

    const agent = createAgent("a1", bus, [
      twoChildren,
      failing("childA"),
      failing("childB"),
    ]);
    agent.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 30; i++) {
      await agent.tick();
    }

    const parent = agent.intentions
      .getAll()
      .find((i) => i.plan.name === "parent")!;
    expect(parent.status).toBe("failed");
    expect(parent.failureReason).toBe('sub-goal "childA" failed: childA');

    expect(
      failures.map(
        (m) =>
          (m.content as Record<string, { reason: string }>)["failure.a1"]!
            .reason,
      ),
    ).toEqual(["childA", 'sub-goal "childA" failed: childA', "childB"]);

    agent.stop();
  });

  it("drops goals that depend on a parent failed by a sub-goal failure", async () => {
    const bus = new InMemoryMessageBus();

    const agent = createAgent("a1", bus, [parentPlan, childPlan]);
    agent.goals.add({
      id: "g-parent",
      name: "parent",
      priority: 5,
      status: "pending",
    });
    agent.goals.add({
      id: "g-after",
      name: "afterwards",
      priority: 1,
      status: "pending",
      dependsOn: ["g-parent"],
    });

    agent.start();
    for (let i = 0; i < 10; i++) {
      await agent.tick();
    }

    expect(agent.goals.get("g-parent")?.status).toBe("failed");
    expect(agent.goals.get("g-after")?.status).toBe("dropped");
    expect(agent.intentions.getActive()).toHaveLength(0);

    agent.stop();
  });

  it("resumes a parent with onChildFailure: continue", async () => {
    const bus = new InMemoryMessageBus();
    const failures: Message[] = [];
    await bus.subscribe(FAILURE_TOPIC, (msg) => failures.push(msg));

    const recovering: Plan = {
      name: "parent",
      onChildFailure: "continue",
      trigger: (_, goal) => goal.name === "parent",
      body: [
        {
          name: "spawn",
          execute: async (): Promise<ActionResult> => ({
            newGoals: [{ name: "child", priority: 10 }],
          }),
        },
        {
          name: "recover",
          execute: async (intention): Promise<ActionResult> => ({
            beliefUpdates: [
              {
                key: "recoveredFrom",
                value: intention.childFailures[0].reason,
              },
            ],
          }),
        },
      ],
    };

    const agent = createAgent("a1", bus, [recovering, childPlan]);
    agent.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 30; i++) {
      await agent.tick();
    }

    expect(agent.beliefs.get("recoveredFrom")).toBe("x");
    expect(agent.goals.get("p")?.status).toBe("achieved");

    const parent = agent.intentions
      .getAll()
      .find((i) => i.plan.name === "parent")!;
    expect(parent.status).toBe("completed");
    expect(parent.failureReason).toBeUndefined();
    expect(parent.children).toEqual([]);
    expect(parent.childFailures).toEqual([
      expect.objectContaining({ goal: "child", reason: "x" }),
    ]);

    // Only the sub-goal failed; the recovering parent published nothing.
    expect(failures).toHaveLength(1);

    agent.stop();
  });

  it("keeps a recovering parent waiting for its remaining sub-goals", async () => {
    const bus = new InMemoryMessageBus();
    const order: string[] = [];

    const recovering: Plan = {
      name: "parent",
      onChildFailure: "continue",
      trigger: (_, goal) => goal.name === "parent",
      body: [
        {
          name: "spawn",
          execute: async (): Promise<ActionResult> => ({
            newGoals: [
              { name: "child", priority: 10 },
              { name: "sibling", priority: 9 },
            ],
          }),
        },
        {
          name: "recover",
          execute: async (): Promise<ActionResult> => {
            order.push("recover");
            return {};
          },
        },
      ],
    };

    const siblingPlan: Plan = {
      name: "sibling",
      trigger: (_, goal) => goal.name === "sibling",
      body: [
        {
          name: "run",
          execute: async (): Promise<ActionResult> => {
            order.push("sibling");
            return {};
          },
        },
      ],
    };

    const agent = createAgent("a1", bus, [recovering, childPlan, siblingPlan]);
    agent.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });

    agent.start();
    // Enough ticks for the failing child to fail but before the sibling is done.
    for (let i = 0; i < 2; i++) {
      await agent.tick();
    }
    expect(order).toEqual([]);

    for (let i = 0; i < 10; i++) {
      await agent.tick();
    }

    expect(order).toEqual(["sibling", "recover"]);
    expect(agent.goals.get("p")?.status).toBe("achieved");

    agent.stop();
  });
});
