import { describe, it, expect, vi } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import {
  Agent,
  FAILURE_TOPIC,
  GOAL_ACHIEVED_TOPIC,
} from "../src/core/reasoning.js";
import type {
  AgentEvent,
  GoalAck,
  GoalStatusChange,
  IntentionAdvanced,
  IntentionFailed,
  IntentionWaiting,
} from "../src/core/reasoning.js";
import { PlanLibrary } from "../src/core/plans.js";
import { InMemoryBeliefBase } from "../src/core/beliefs.js";
import { resetIntentionCounter } from "../src/core/intentions.js";
import type { Intention } from "../src/core/intentions.js";
import type { Goal } from "../src/core/goals.js";
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

  it("tracks sub-goals back to the goal that created them", async () => {
    const bus = new InMemoryMessageBus();
    const failures: Message[] = [];
    await bus.subscribe(FAILURE_TOPIC, (msg) => failures.push(msg));

    const spawner = (name: string, childName: string): Plan => ({
      name,
      trigger: (_, goal) => goal.name === name,
      body: [
        {
          name: "spawn",
          execute: async (): Promise<ActionResult> => ({
            newGoals: [{ name: childName, priority: 10 }],
          }),
        },
        { name: "after", execute: async (): Promise<ActionResult> => ({}) },
      ],
    });

    const agent = createAgent("a1", bus, [
      spawner("top", "middle"),
      spawner("middle", "leaf"),
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
    ]);
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

    const byName = new Map(agent.goals.all().map((g) => [g.name, g]));
    const top = byName.get("top")!;
    const middle = byName.get("middle")!;
    const leaf = byName.get("leaf")!;

    expect(top.parentGoalId).toBeUndefined();
    expect(middle.parentGoalId).toBe(top.id);
    expect(middle.rootGoalId).toBe(top.id);
    expect(leaf.parentGoalId).toBe(middle.id);
    expect(leaf.rootGoalId).toBe(top.id);

    const notices = failures.map(
      (m) =>
        (m.content as Record<string, Record<string, unknown>>)["failure.a1"]!,
    );
    expect(notices.find((n) => n.goal === "leaf")).toMatchObject({
      goalId: leaf.id,
      parentGoalId: middle.id,
      rootGoalId: top.id,
    });
    expect(notices.find((n) => n.goal === "top")).not.toHaveProperty(
      "parentGoalId",
    );

    agent.stop();
  });
});

describe("Agent goal provenance", () => {
  /** A plain bus client standing in for a UI/coordinator that sent a request. */
  const registerClient = (bus: InMemoryMessageBus, id: string): Message[] => {
    const inbox: Message[] = [];
    bus.registerAgent(id, (msg) => inbox.push(msg));
    return inbox;
  };

  it("records the message a request goal came from", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.goals.all()[0].source).toEqual({
      sender: "ui",
      conversationId: "chat-1",
    });

    agent.stop();
  });

  it("records the message an achieve goal came from", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      performative: "achieve",
      sender: "ui",
      content: { goal: "shipIt" },
      timestamp: Date.now(),
    });
    await agent.tick();

    const goal = agent.goals.all()[0];
    expect(goal.source).toEqual({ sender: "ui" });
    expect(goal.priority).toBe(8);

    agent.stop();
  });

  it("records a sender-stamped message id", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      id: "msg-7",
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.goals.all()[0].source).toEqual({
      sender: "ui",
      messageId: "msg-7",
    });

    agent.stop();
  });

  it("honours a caller-supplied goal id", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData", goalId: "pinned-1" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.goals.all()[0].id).toBe("pinned-1");
    expect(inbox[0].content).toMatchObject({ goalId: "pinned-1" });

    agent.stop();
  });

  it("falls back to a generated id when the supplied one is taken", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, []);

    agent.goals.add({
      id: "pinned-1",
      name: "existing",
      priority: 1,
      status: "pending",
    });

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData", goalId: "pinned-1" },
      timestamp: Date.now(),
    });
    await agent.tick();

    const added = agent.goals.all().find((g) => g.name === "fetchData")!;
    // The existing goal keeps its id and contents...
    expect(agent.goals.get("pinned-1")?.name).toBe("existing");
    // ...and the newcomer gets a fresh id, which is the one the sender is told.
    expect(added.id).not.toBe("pinned-1");
    expect(inbox[0].content).toMatchObject({ goalId: added.id });

    agent.stop();
  });

  it("acknowledges the assigned goal id to the sender", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      performative: "confirm",
      sender: "a1",
      receiver: "ui",
    });
    expect(inbox[0].content).toEqual({
      goal: "fetchData",
      goalId: agent.goals.all()[0].id,
      conversationId: "chat-1",
    });

    agent.stop();
  });

  it("queues the acknowledgement until the next tick", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });

    expect(agent.goals.all()).toHaveLength(1);
    expect(inbox).toHaveLength(0);

    await agent.tick();
    expect(inbox).toHaveLength(1);

    agent.stop();
  });

  it("echoes the message id back in the acknowledgement", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      id: "msg-7",
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(inbox[0].content).toMatchObject({ messageId: "msg-7" });

    agent.stop();
  });

  it("does not acknowledge a request the agent sent itself", async () => {
    const bus = new InMemoryMessageBus();
    // A client registered under the agent's own id would have its inbox
    // replaced by agent.start(), so watch the bus instead.
    const send = vi.spyOn(bus, "send");
    const agent = createAgent("a1", bus, []);

    agent.start();
    await agent.subscribe("jobs");
    await bus.publish("jobs", {
      performative: "request",
      sender: "a1",
      topic: "jobs",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.goals.all()).toHaveLength(1);
    expect(
      send.mock.calls.filter(([, msg]) => msg.performative === "confirm"),
    ).toHaveLength(0);

    agent.stop();
  });

  it("passes the source down to sub-goals", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
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
          { name: "done", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
    ]);

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "top" },
      timestamp: Date.now(),
    });
    for (let i = 0; i < 12; i++) {
      await agent.tick();
    }

    const byName = new Map(agent.goals.all().map((g) => [g.name, g]));
    const source = { sender: "ui", conversationId: "chat-1" };
    expect(byName.get("top")?.source).toEqual(source);
    expect(byName.get("middle")?.source).toEqual(source);
    expect(byName.get("leaf")?.source).toEqual(source);

    agent.stop();
  });

  it("includes the source in a failure notice", async () => {
    const bus = new InMemoryMessageBus();
    const failures: Message[] = [];
    await bus.subscribe(FAILURE_TOPIC, (msg) => failures.push(msg));

    const agent = createAgent("a1", bus, [
      {
        name: "risky",
        trigger: (_, goal) => goal.name === "risky",
        body: [
          {
            name: "attempt",
            execute: async (): Promise<ActionResult> => ({
              failure: { reason: "503 from registry" },
            }),
          },
        ],
      },
    ]);

    agent.start();
    await bus.send("a1", {
      id: "msg-7",
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "risky" },
      timestamp: Date.now(),
    });
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    const notice = (failures[0].content as Record<string, unknown>)[
      "failure.a1"
    ] as Record<string, unknown>;
    expect(notice).toMatchObject({
      goal: "risky",
      reason: "503 from registry",
      source: { sender: "ui", conversationId: "chat-1", messageId: "msg-7" },
    });

    agent.stop();
  });

  it("omits source from failure notices for directly added goals", async () => {
    const bus = new InMemoryMessageBus();
    const failures: Message[] = [];
    await bus.subscribe(FAILURE_TOPIC, (msg) => failures.push(msg));

    const agent = createAgent("a1", bus, [
      {
        name: "risky",
        trigger: (_, goal) => goal.name === "risky",
        body: [
          {
            name: "attempt",
            execute: async (): Promise<ActionResult> => {
              throw new Error("nope");
            },
          },
        ],
      },
    ]);

    agent.goals.add({
      id: "g-1",
      name: "risky",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    const notice = (failures[0].content as Record<string, unknown>)[
      "failure.a1"
    ] as Record<string, unknown>;
    expect(notice).not.toHaveProperty("source");

    agent.stop();
  });

  /** A worker that turns a "fetch" goal into a job and acks it. */
  const createWorker = (bus: InMemoryMessageBus, id: string): Agent =>
    createAgent(id, bus, [
      {
        name: "fetch",
        trigger: (_, goal) => goal.name === "fetch",
        body: [
          { name: "go", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
    ]);

  it("hands the acknowledgement to listeners, not to the reasoning cycle", async () => {
    const bus = new InMemoryMessageBus();
    const worker = createWorker(bus, "worker");
    const caller = createAgent("caller", bus, []);
    const acks: GoalAck[] = [];
    caller.on("goalAcknowledged", (ack) => acks.push(ack));

    await caller.start();
    await worker.start();

    await bus.send("worker", {
      id: "msg-7",
      performative: "request",
      sender: "caller",
      conversationId: "chat-1",
      content: { goal: "fetch" },
      timestamp: Date.now(),
    });
    await worker.tick();
    await worker.tick();

    expect(acks).toEqual([
      {
        agentId: "worker",
        goal: "fetch",
        goalId: worker.goals.all()[0].id,
        conversationId: "chat-1",
        messageId: "msg-7",
      },
    ]);
    // The ack is bookkeeping, not world state: it must not reach the beliefs
    // that plan triggers are evaluated against, nor the goal queue.
    expect(caller.beliefs.all()).toEqual({});
    expect(caller.goals.all()).toEqual([]);

    await worker.stop();
    await caller.stop();
  });

  it("stops delivering acknowledgements after unsubscribe", async () => {
    const bus = new InMemoryMessageBus();
    const worker = createWorker(bus, "worker");
    const caller = createAgent("caller", bus, []);
    const acks: GoalAck[] = [];
    const unsub = caller.on("goalAcknowledged", (ack) => acks.push(ack));

    await caller.start();
    await worker.start();
    unsub();

    await bus.send("worker", {
      performative: "request",
      sender: "caller",
      content: { goal: "fetch" },
      timestamp: Date.now(),
    });
    await worker.tick();
    await worker.tick();

    expect(acks).toEqual([]);

    await worker.stop();
    await caller.stop();
  });

  it("ignores a confirm that does not name a goal", async () => {
    const bus = new InMemoryMessageBus();
    const caller = createAgent("caller", bus, []);
    const acks: GoalAck[] = [];
    caller.on("goalAcknowledged", (ack) => acks.push(ack));

    await caller.start();
    await bus.send("caller", {
      performative: "confirm",
      sender: "worker",
      content: { note: "acknowledged" },
      timestamp: Date.now(),
    });

    expect(acks).toEqual([]);

    await caller.stop();
  });

  it("publishes an achieved notice with the result of the last action", async () => {
    const bus = new InMemoryMessageBus();
    const achieved: Message[] = [];
    await bus.subscribe(GOAL_ACHIEVED_TOPIC, (msg) => achieved.push(msg));

    const agent = createAgent("a1", bus, [
      {
        name: "deploy",
        trigger: (_, goal) => goal.name === "deploy",
        body: [
          { name: "build", execute: async (): Promise<ActionResult> => ({}) },
          {
            name: "put",
            execute: async (): Promise<ActionResult> => ({
              beliefUpdates: [{ key: "deployed", value: true }],
            }),
          },
        ],
      },
    ]);

    agent.goals.add({
      id: "g-7",
      name: "deploy",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(agent.goals.get("g-7")?.status).toBe("achieved");
    expect(achieved).toHaveLength(1);
    expect(achieved[0].sender).toBe("a1");
    expect(achieved[0].topic).toBe(GOAL_ACHIEVED_TOPIC);
    expect(achieved[0].content).toEqual({
      "achieved.a1": {
        agentId: "a1",
        intentionId: agent.intentions.getAll()[0].id,
        goalId: "g-7",
        goal: "deploy",
        plan: "deploy",
        action: "put",
        status: "achieved",
        result: { beliefUpdates: [{ key: "deployed", value: true }] },
      },
    });

    agent.stop();
  });

  it("includes lineage and source in a sub-goal achieved notice", async () => {
    const bus = new InMemoryMessageBus();
    const achieved: Message[] = [];
    await bus.subscribe(GOAL_ACHIEVED_TOPIC, (msg) => achieved.push(msg));

    const agent = createAgent("a1", bus, [
      {
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
      },
      {
        name: "child",
        trigger: (_, goal) => goal.name === "child",
        body: [
          { name: "do", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
    ]);

    agent.start();
    await bus.send("a1", {
      id: "msg-7",
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "parent" },
      timestamp: Date.now(),
    });
    for (let i = 0; i < 12; i++) {
      await agent.tick();
    }

    const notices = achieved.map(
      (msg) =>
        (msg.content as Record<string, unknown>)["achieved.a1"] as Record<
          string,
          unknown
        >,
    );
    const childNotice = notices.find((n) => n.goal === "child");
    expect(childNotice).toMatchObject({
      goal: "child",
      parentGoalId: agent.goals.all().find((g) => g.name === "parent")!.id,
      rootGoalId: agent.goals.all().find((g) => g.name === "parent")!.id,
      source: { sender: "ui", conversationId: "chat-1", messageId: "msg-7" },
    });
    expect(notices.some((n) => n.goal === "parent")).toBe(true);

    agent.stop();
  });

  it("lets a monitor hold one belief per achieving agent", async () => {
    const bus = new InMemoryMessageBus();

    const plan = (): Plan => ({
      name: "work",
      trigger: (_, goal) => goal.name === "work",
      body: [{ name: "go", execute: async (): Promise<ActionResult> => ({}) }],
    });

    const monitor = createAgent("monitor", bus, []);
    await monitor.subscribe(GOAL_ACHIEVED_TOPIC);
    monitor.start();

    for (const id of ["a1", "a2"]) {
      const agent = createAgent(id, bus, [plan()]);
      agent.goals.add({
        id: `g-${id}`,
        name: "work",
        priority: 5,
        status: "pending",
      });
      agent.start();
      for (let i = 0; i < 5; i++) {
        await agent.tick();
      }
      agent.stop();
    }

    await monitor.tick();

    expect(
      monitor.beliefs
        .queryByPrefix("msg.achieved.")
        .map(({ key }) => key)
        .sort(),
    ).toEqual(["msg.achieved.a1", "msg.achieved.a2"]);

    monitor.stop();
  });

  it("does not publish an achieved notice for a failed goal", async () => {
    const bus = new InMemoryMessageBus();
    const achieved: Message[] = [];
    await bus.subscribe(GOAL_ACHIEVED_TOPIC, (msg) => achieved.push(msg));

    const agent = createAgent("a1", bus, [
      {
        name: "risky",
        trigger: (_, goal) => goal.name === "risky",
        body: [
          {
            name: "attempt",
            execute: async (): Promise<ActionResult> => ({
              failure: { reason: "nope" },
            }),
          },
        ],
      },
    ]);

    agent.goals.add({
      id: "g-1",
      name: "risky",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(agent.goals.get("g-1")?.status).toBe("failed");
    expect(achieved).toHaveLength(0);

    agent.stop();
  });

  it("reports the id actually assigned when a pinned id was taken", async () => {
    const bus = new InMemoryMessageBus();
    const worker = createWorker(bus, "worker");
    const caller = createAgent("caller", bus, []);
    const acks: GoalAck[] = [];
    caller.on("goalAcknowledged", (ack) => acks.push(ack));

    worker.goals.add({
      id: "job-7",
      name: "somethingElse",
      priority: 1,
      status: "pending",
    });

    await caller.start();
    await worker.start();

    await bus.send("worker", {
      performative: "request",
      sender: "caller",
      content: { goal: "fetch", goalId: "job-7" },
      timestamp: Date.now(),
    });
    await worker.tick();
    await worker.tick();

    // The caller pinned "job-7" and got a different id back, so it can notice
    // its pin lost the race instead of tracking a goal it cannot name.
    expect(acks).toHaveLength(1);
    expect(acks[0].goalId).not.toBe("job-7");
    expect(acks[0].goalId).toBe(
      worker.goals.all().find((g) => g.name === "fetch")!.id,
    );

    await worker.stop();
    await caller.stop();
  });
});

describe("Agent events", () => {
  const workPlan: Plan = {
    name: "work",
    trigger: (_, goal) => goal.name === "work",
    body: [{ name: "do", execute: async (): Promise<ActionResult> => ({}) }],
  };

  const twoStepPlan: Plan = {
    name: "work",
    trigger: (_, goal) => goal.name === "work",
    body: [
      {
        name: "step1",
        execute: async (): Promise<ActionResult> => ({
          beliefUpdates: [{ key: "s1", value: true }],
        }),
      },
      {
        name: "step2",
        execute: async (): Promise<ActionResult> => ({
          beliefUpdates: [{ key: "s2", value: true }],
        }),
      },
    ],
  };

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
    body: [{ name: "do", execute: async (): Promise<ActionResult> => ({}) }],
  };

  const failingPlan: Plan = {
    name: "work",
    trigger: (_, goal) => goal.name === "work",
    body: [
      {
        name: "attempt",
        execute: async (): Promise<ActionResult> => ({
          failure: { reason: "503 from registry" },
        }),
      },
    ],
  };

  /** The stack holds the live intention, so keep a copy of what we saw. */
  const snapshotIntention = (intention: Intention): Intention => ({
    ...intention,
    children: [...intention.children],
  });

  it("reports a goal added to its queue, before it even starts", () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);
    const added: Goal[] = [];
    agent.on("goal:added", (goal) => added.push({ ...goal }));

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    expect(added).toEqual([
      { id: "g1", name: "work", priority: 5, status: "pending" },
    ]);
  });

  it("reports the goal a request message created, with its source", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [workPlan]);
    const added: Goal[] = [];
    agent.on("goal:added", (goal) => added.push({ ...goal }));

    await agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "work" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: "work",
      status: "pending",
      source: { sender: "ui", conversationId: "chat-1" },
    });

    await agent.stop();
  });

  it("reports the sub-goals a decomposed plan created", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [parentPlan, childPlan]);
    const added: Goal[] = [];
    agent.on("goal:added", (goal) => added.push({ ...goal }));

    agent.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 10; i++) {
      await agent.tick();
    }

    const child = added.find((g) => g.name === "child");
    expect(child).toMatchObject({ parentGoalId: "p", rootGoalId: "p" });

    await agent.stop();
  });

  it("reports the status a goal moved from and to", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [workPlan]);
    const changes: GoalStatusChange[] = [];
    agent.on("goal:status", (change) =>
      changes.push({ ...change, goal: { ...change.goal } }),
    );

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(changes.map((c) => `${c.from}->${c.to}`)).toEqual([
      "pending->active",
      "active->achieved",
    ]);
    expect(changes[0].goal.id).toBe("g1");

    await agent.stop();
  });

  it("reports a goal dropped because the goal it depends on failed", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [failingPlan]);
    const changes: GoalStatusChange[] = [];
    agent.on("goal:status", (change) =>
      changes.push({ ...change, goal: { ...change.goal } }),
    );

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });
    agent.goals.add({
      id: "g2",
      name: "work",
      priority: 1,
      status: "pending",
      dependsOn: ["g1"],
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(changes.at(-1)).toMatchObject({
      from: "pending",
      to: "dropped",
      goal: { id: "g2" },
    });
  });

  it("reports an intention as soon as means-ends reasoning starts it", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [workPlan]);
    const started: Intention[] = [];
    agent.on("intention:started", (intention) =>
      started.push(snapshotIntention(intention)),
    );

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    await agent.tick();

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      actionIndex: 0,
      status: "executing",
      goal: { id: "g1" },
      plan: { name: "work" },
    });

    await agent.stop();
  });

  it("reports every action an intention runs, with the result it returned", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [twoStepPlan]);
    const advanced: IntentionAdvanced[] = [];
    agent.on("intention:advanced", (detail) =>
      advanced.push({
        intention: snapshotIntention(detail.intention),
        action: detail.action,
        result: detail.result,
      }),
    );

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(advanced.map((d) => d.action.name)).toEqual(["step1", "step2"]);
    // The index has already moved on past the action that was reported.
    expect(advanced.map((d) => d.intention.actionIndex)).toEqual([1, 2]);
    expect(advanced[0].result).toEqual({
      beliefUpdates: [{ key: "s1", value: true }],
    });

    await agent.stop();
  });

  it("reports an intention waiting for the sub-goals it created", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [parentPlan, childPlan]);
    const waiting: IntentionWaiting[] = [];
    agent.on("intention:waiting", (detail) =>
      waiting.push({
        intention: snapshotIntention(detail.intention),
        children: [...detail.children],
      }),
    );

    agent.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 10; i++) {
      await agent.tick();
    }

    const childId = agent.goals.all().find((g) => g.name === "child")!.id;
    expect(waiting).toHaveLength(1);
    expect(waiting[0].intention.status).toBe("waiting");
    expect(waiting[0].children).toEqual([childId]);

    await agent.stop();
  });

  it("reports a completed intention, after its goal is already achieved", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [workPlan]);
    const completed: Intention[] = [];
    const goalStatusAtCompletion: (string | undefined)[] = [];
    agent.on("intention:completed", (intention) => {
      completed.push(snapshotIntention(intention));
      goalStatusAtCompletion.push(agent.goals.get(intention.goal.id)?.status);
    });

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "completed" });
    expect(goalStatusAtCompletion).toEqual(["achieved"]);

    await agent.stop();
  });

  it("reports a failed intention with the reason the action reported", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [failingPlan]);
    const failed: IntentionFailed[] = [];
    agent.on("intention:failed", (detail) =>
      failed.push({
        intention: snapshotIntention(detail.intention),
        reason: detail.reason,
      }),
    );

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe("503 from registry");
    expect(failed[0].intention).toMatchObject({
      status: "failed",
      failureReason: "503 from registry",
    });

    await agent.stop();
  });

  it("reports a thrown action as a failure with the error message", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
      {
        name: "work",
        trigger: (_, goal) => goal.name === "work",
        body: [
          {
            name: "attempt",
            execute: async (): Promise<ActionResult> => {
              throw new Error("connection reset");
            },
          },
        ],
      },
    ]);
    const reasons: string[] = [];
    agent.on("intention:failed", ({ reason }) => reasons.push(reason));

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(reasons).toEqual(["connection reset"]);

    await agent.stop();
  });

  it("reports the cascade when a sub-goal an intention waited for failed", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
      parentPlan,
      {
        name: "child",
        trigger: (_, goal) => goal.name === "child",
        body: [
          {
            name: "attempt",
            execute: async (): Promise<ActionResult> => ({
              failure: { reason: "build broke" },
            }),
          },
        ],
      },
    ]);
    const failed: { goal: string; reason: string }[] = [];
    agent.on("intention:failed", ({ intention, reason }) =>
      failed.push({ goal: intention.goal.name, reason }),
    );

    agent.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 10; i++) {
      await agent.tick();
    }

    expect(failed).toEqual([
      { goal: "child", reason: "build broke" },
      { goal: "parent", reason: 'sub-goal "child" failed: build broke' },
    ]);

    await agent.stop();
  });

  it("does not report an advance for an action that failed", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [failingPlan]);
    const advanced: string[] = [];
    agent.on("intention:advanced", (d) => advanced.push(d.action.name));

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(advanced).toEqual([]);

    await agent.stop();
  });

  it("reports every message it receives, point-to-point or on a topic", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);
    const received: Message[] = [];
    agent.on("message:received", (msg) => received.push(msg));

    await agent.start();
    await agent.subscribe("weather");
    await bus.send("a1", {
      performative: "inform",
      sender: "sensor",
      content: { temperature: 24 },
      timestamp: Date.now(),
    });
    await bus.publish("weather", {
      performative: "inform",
      sender: "station",
      topic: "weather",
      content: { temperature: 30 },
      timestamp: Date.now(),
    });
    // A performative the agent does not process is still traffic a monitor
    // may want to account for.
    await bus.send("a1", {
      performative: "query",
      sender: "ui",
      content: { question: "status?" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(received.map((m) => [m.sender, m.performative])).toEqual([
      ["sensor", "inform"],
      ["station", "inform"],
      ["ui", "query"],
    ]);

    await agent.stop();
  });

  it("reports the messages it sends, including its own notices", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [failingPlan]);
    const sent: string[] = [];
    agent.on("message:sent", (msg) =>
      sent.push(
        `${msg.performative}->${msg.receiver ?? msg.topic}@${msg.sender}`,
      ),
    );

    await agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "work" },
      timestamp: Date.now(),
    });
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(sent).toEqual(["confirm->ui@a1", `inform->${FAILURE_TOPIC}@a1`]);

    await agent.stop();
  });

  it("reports the message an action result asked it to send", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
      {
        name: "work",
        trigger: (_, goal) => goal.name === "work",
        body: [
          {
            name: "report",
            execute: async (): Promise<ActionResult> => ({
              messages: [
                {
                  receiver: "analyzer",
                  performative: "inform",
                  content: { done: true },
                },
                {
                  topic: "progress",
                  performative: "inform",
                  content: { step: "report" },
                },
              ],
            }),
          },
        ],
      },
    ]);
    const sent: Message[] = [];
    agent.on("message:sent", (msg) => sent.push(msg));

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(
      sent.map((m) => [m.performative, m.receiver, m.topic, m.content]),
    ).toEqual([
      ["inform", "analyzer", undefined, { done: true }],
      ["inform", undefined, "progress", { step: "report" }],
      ["inform", undefined, GOAL_ACHIEVED_TOPIC, expect.any(Object)],
    ]);

    await agent.stop();
  });

  it("lets a monitor follow a plan without polling the agent", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [twoStepPlan]);
    const timeline: string[] = [];

    agent.on("goal:added", (goal) => timeline.push(`goal:added ${goal.name}`));
    agent.on("goal:status", (change) =>
      timeline.push(
        `goal:status ${change.goal.name} ${change.from}->${change.to}`,
      ),
    );
    agent.on("intention:started", (intention) =>
      timeline.push(`intention:started ${intention.goal.name}`),
    );
    agent.on("intention:advanced", (detail) =>
      timeline.push(`intention:advanced ${detail.action.name}`),
    );
    agent.on("intention:completed", (intention) =>
      timeline.push(`intention:completed ${intention.goal.name}`),
    );

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(timeline).toEqual([
      "goal:added work",
      "goal:status work pending->active",
      "intention:started work",
      "intention:advanced step1",
      "intention:advanced step2",
      "goal:status work active->achieved",
      "intention:completed work",
    ]);

    await agent.stop();
  });

  it("keeps reporting goal events across a stop and restart", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [workPlan]);
    const added: string[] = [];
    agent.on("goal:added", (goal) => added.push(goal.id));

    await agent.start();
    await agent.stop();
    await agent.start();
    agent.goals.add({ id: "g1", name: "work", priority: 5, status: "pending" });
    await agent.stop();

    expect(added).toEqual(["g1"]);
  });

  it("stops delivering events after unsubscribe", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [workPlan]);
    const events: string[] = [];
    const track = (event: AgentEvent): (() => void) =>
      agent.on(event, () => events.push(event));

    const unsubs = [
      track("goal:added"),
      track("goal:status"),
      track("intention:started"),
      track("intention:completed"),
    ];

    agent.goals.add({
      id: "g1",
      name: "work",
      priority: 5,
      status: "pending",
    });
    for (const unsub of unsubs) {
      unsub();
    }

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    // Only the goal added while the listeners were still attached.
    expect(events).toEqual(["goal:added"]);

    await agent.stop();
  });
});
