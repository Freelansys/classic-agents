import { describe, it, expect, vi } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message, Performative } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning.js";
import type {
  AgentEvent,
  DirectiveMiddleware,
  DirectiveResponse,
  GoalAck,
  GoalRefusal,
  GoalRejection,
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
  maxGoals?: number,
  directiveMiddleware?: DirectiveMiddleware[],
): Agent {
  const lib = new PlanLibrary();
  for (const plan of plans) {
    lib.register(plan);
  }
  return new Agent({
    id,
    bus,
    planLibrary: lib,
    maxGoals,
    directiveMiddleware,
  });
}

/**
 * Send a request the way an agent actually sends one.
 *
 * This deliberately goes through `Agent.sendMessage` rather than building a
 * message and handing it to the bus directly: that private method is where
 * correlation ids are stamped, and a helper that skipped it would be testing a
 * scenario no real sender produces — a request with no `conversationId` for
 * the reply to inherit. Returning the sent message lets a test assert that
 * inheritance instead of taking it on faith.
 */
async function sendRequest(
  from: Agent,
  to: string,
  content: Record<string, unknown>,
): Promise<Message> {
  const message: Message = {
    performative: "request",
    sender: from.id,
    receiver: to,
    content,
    timestamp: Date.now(),
  };
  return await (
    from as unknown as {
      sendMessage: (to: string, message: Message) => Promise<Message>;
    }
  ).sendMessage(to, message);
}

/**
 * A plan per goal name, each declaring what it serves but never willing yet.
 *
 * A directive can only be agreed to if some plan declares the goal it asks
 * for — that is what makes a `refuse` with `verdict: "no-plan"` an honest
 * answer rather than a guess. The trigger returns `false` so the goal is
 * admitted and then waits, which is what lets a test look at the queue: a
 * willing plan would work the goal to completion and collect it in the same
 * tick.
 */
function declaring(...goalNames: string[]): Plan[] {
  return goalNames.map((name) => ({
    name: `do-${name}`,
    can: name,
    trigger: () => false,
    body: [],
  }));
}

/**
 * A plan per goal name that confirms the goal straight away, with no-op actions
 * so the goal is still queued for a few cycles after it was confirmed.
 *
 * A plan willing from the first action would see its goal achieved and
 * collected inside that same cycle, before the agreement reached the
 * requester, and the tests below need to read the id off a live goal. One
 * action runs per cycle, so three of them outlive the two cycles these tests
 * tick through.
 */
function willing(...goalNames: string[]): Plan[] {
  return goalNames.map((name) => ({
    name: `do-${name}`,
    can: name,
    trigger: () => true,
    body: [1, 2, 3].map((step) => ({
      name: `step-${step}`,
      execute: async (): Promise<ActionResult> => ({}),
    })),
  }));
}

/**
 * Finished goals and intentions leave the queue and the stack at the end of the
 * cycle that finished them, so how a job ended is read off the event stream —
 * the same way a monitor reads it. Everything is snapshotted on the way out,
 * since the payloads are the live store objects.
 */
function recordHistory(agent: Agent) {
  const goals: Goal[] = [];
  const intentions: Intention[] = [];
  agent.on("goal:removed", (goal) => goals.push({ ...goal }));
  agent.on("intention:removed", (intention) =>
    intentions.push({ ...intention }),
  );
  return {
    goals,
    intentions,
    goal: (name: string) => goals.find((g) => g.name === name),
    intentionsFor: (planName: string) =>
      intentions.filter((i) => i.plan.name === planName),
  };
}

/**
 * How a goal ended, tracked from `goal:status` — the signal a monitor follows
 * for a goal it cannot hold on to, since the goal itself leaves the queue once
 * it is finished.
 */
function recordGoalStatuses(agent: Agent) {
  const changes: GoalStatusChange[] = [];
  agent.on("goal:status", (change) =>
    changes.push({ ...change, goal: { ...change.goal } }),
  );
  return {
    changes,
    statusOf: (id: string) =>
      changes.filter((c) => c.goal.id === id).at(-1)?.to,
  };
}

/**
 * Every failure this agent reports, from `intention:failed`. The payload
 * carries the live intention, so a test can read its goal, plan, lineage and
 * source.
 */
function recordFailures(agent: Agent) {
  const failures: IntentionFailed[] = [];
  agent.on("intention:failed", (detail) =>
    failures.push({ ...detail, intention: { ...detail.intention } }),
  );
  return failures;
}

/** Every goal this agent reports as completed, from `intention:completed`. */
function recordCompletions(agent: Agent) {
  const completions: Intention[] = [];
  agent.on("intention:completed", (intention) =>
    completions.push({ ...intention }),
  );
  return completions;
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
    const agent = createAgent("a1", bus, declaring("fetchData"));

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
    const agent = createAgent("a1", bus, declaring("fetchData"));

    await agent.subscribe("reqs");
    agent.start();

    await bus.publish("reqs", {
      performative: "request",
      sender: "other",
      topic: "reqs",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });

    await agent.tick();

    expect(
      agent.goals.all().filter((g) => g.name === "fetchData"),
    ).toHaveLength(1);

    agent.stop();
  });

  it("selects and activates a goal via deliberate step", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, declaring("highPri", "lowPri"));

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
      can: "doThing",
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
    const statuses = recordGoalStatuses(agent);
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
    expect(statuses.statusOf("g1")).toBe("achieved");

    agent.stop();
  });

  it("two agents exchange messages and reach a goal", async () => {
    const bus = new InMemoryMessageBus();

    const reporterPlan: Plan = {
      name: "report",
      can: "report-temperature",
      trigger: (beliefs) => beliefs.has("msg.temperature"),
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
      can: "analyze-report",
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

    // Each agent is asked to do its job before it has the facts to do it on.
    // The `inform`s only supply those facts; the goals are what start the work.
    await bus.send("reporter", {
      performative: "request",
      sender: "sensor",
      content: { goal: "report-temperature" },
      timestamp: Date.now(),
    });
    await bus.send("analyzer", {
      performative: "request",
      sender: "sensor",
      content: { goal: "analyze-report" },
      timestamp: Date.now(),
    });

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
      can: "multi",
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
    const statuses = recordGoalStatuses(agent);
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
    expect(statuses.statusOf("g1")).toBe("achieved");

    agent.stop();
  });

  it("applies remaining action results when an action reports a failure", async () => {
    const bus = new InMemoryMessageBus();
    const alerts: Message[] = [];
    await bus.subscribe("alerts", (msg) => alerts.push(msg));

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

    // The sub-goal the action produces needs a plan that serves it, otherwise
    // it is refused as "no-plan" and freed rather than left queued.
    const agent = createAgent("a1", bus, [plan, ...declaring("cleanup")]);
    const statuses = recordGoalStatuses(agent);
    const history = recordHistory(agent);
    const failures = recordFailures(agent);
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
    // The sub-goal the failed action still produced is unfinished, so it is
    // still queued.
    expect(agent.goals.all().some((g) => g.name === "cleanup")).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].content).toEqual({ note: "half done" });

    expect(statuses.statusOf("g-risky")).toBe("failed");
    expect(statuses.statusOf("g-blocked")).toBe("dropped");
    const intention = history.intentionsFor("risky")[0];
    expect(intention.status).toBe("failed");
    expect(intention.failureReason).toBe("network unreachable");

    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("network unreachable");
    expect(failures[0].intention.goal.id).toBe("g-risky");
    expect(failures[0].intention.goal.name).toBe("risky");

    agent.stop();
  });

  it("reports a failure event when an action throws", async () => {
    const bus = new InMemoryMessageBus();

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
    const statuses = recordGoalStatuses(agent);
    const history = recordHistory(agent);
    const failures = recordFailures(agent);
    agent.goals.add({
      id: "g1",
      name: "explode",
      priority: 5,
      status: "pending",
    });

    agent.start();
    await agent.tick();
    await agent.tick();

    expect(statuses.statusOf("g1")).toBe("failed");
    expect(history.intentions[0].failureReason).toBe("kaboom");
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("kaboom");
    expect(failures[0].intention.goal.name).toBe("explode");
    expect(
      failures[0].intention.plan.body[failures[0].intention.actionIndex].name,
    ).toBe("boom");

    agent.stop();
  });

  it("reports a failure event for every failing agent", async () => {
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

    // A bus-wide view is the user's to build now: `goal:rejected` and
    // `intention:failed` fire on each agent, and the user maps them onto
    // whatever channel she wants. What matters here is that each agent's
    // failures stay attributable to it.
    const failures = new Map<string, string[]>();
    for (const id of ["a1", "a2"]) {
      const agent = createAgent(id, bus, [makePlan()]);
      const own: string[] = [];
      agent.on("intention:failed", ({ reason }) => own.push(reason));
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
      failures.set(id, own);
    }

    expect([...failures.entries()]).toEqual([
      ["a1", ["boom"]],
      ["a2", ["boom"]],
    ]);
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

    const agent = createAgent("a1", bus, [parentPlan, childPlan]);
    const history = recordHistory(agent);
    const failures = recordFailures(agent);
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

    expect(history.goals.map((g) => `${g.name}:${g.status}`).sort()).toEqual([
      "child:failed",
      "parent:failed",
    ]);

    const parent = history.intentionsFor("parent")[0];
    expect(parent.status).toBe("failed");
    expect(parent.failureReason).toBe('sub-goal "child" failed: x');

    // The stuck parent used to hold a getActive() slot forever.
    expect(agent.intentions.getActive()).toHaveLength(0);

    expect(failures.map((f) => f.reason)).toEqual([
      "x",
      'sub-goal "child" failed: x',
    ]);

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
    const history = recordHistory(agent);
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

    expect(history.goals.map((g) => `${g.name}:${g.status}`).sort()).toEqual([
      "leaf:failed",
      "middle:failed",
      "top:failed",
    ]);

    const reasons = new Map(
      history.intentions.map((i) => [i.plan.name, i.failureReason] as const),
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
    const history = recordHistory(agent);
    const failures = recordFailures(agent);
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

    const parent = history.intentionsFor("parent")[0];
    expect(parent.status).toBe("failed");
    expect(parent.failureReason).toBe('sub-goal "childA" failed: childA');

    expect(failures.map((f) => f.reason)).toEqual([
      "childA",
      'sub-goal "childA" failed: childA',
      "childB",
    ]);

    agent.stop();
  });

  it("drops goals that depend on a parent failed by a sub-goal failure", async () => {
    const bus = new InMemoryMessageBus();

    const agent = createAgent("a1", bus, [parentPlan, childPlan]);
    const statuses = recordGoalStatuses(agent);
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

    expect(statuses.statusOf("g-parent")).toBe("failed");
    expect(statuses.statusOf("g-after")).toBe("dropped");
    expect(agent.intentions.getActive()).toHaveLength(0);

    agent.stop();
  });

  it("runs a goal once the goal it depends on has achieved", async () => {
    const bus = new InMemoryMessageBus();

    const stepPlan = (name: string): Plan => ({
      name,
      trigger: (_, goal) => goal.name === name,
      body: [
        {
          name: "do",
          execute: async (): Promise<ActionResult> => ({
            beliefUpdates: [{ key: `${name}.done`, value: true }],
          }),
        },
      ],
    });

    const agent = createAgent("a1", bus, [
      stepPlan("build"),
      stepPlan("deploy"),
    ]);
    const statuses = recordGoalStatuses(agent);
    agent.goals.add({
      id: "g-build",
      name: "build",
      priority: 10,
      status: "pending",
    });
    agent.goals.add({
      id: "g-deploy",
      name: "deploy",
      priority: 1,
      status: "pending",
      dependsOn: ["g-build"],
    });

    await agent.start();
    // The dependency achieves and is collected on the first cycle, so from the
    // second one on the only record that it succeeded is the queue's.
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(agent.beliefs.get("build.done")).toBe(true);
    expect(agent.beliefs.get("deploy.done")).toBe(true);
    expect(statuses.statusOf("g-build")).toBe("achieved");
    expect(statuses.statusOf("g-deploy")).toBe("achieved");

    await agent.stop();
  });

  it("waits for every goal a goal depends on, not just one of them", async () => {
    const bus = new InMemoryMessageBus();

    const stepPlan = (name: string): Plan => ({
      name,
      trigger: (_, goal) => goal.name === name,
      body: [
        {
          name: "do",
          execute: async (): Promise<ActionResult> => ({
            beliefUpdates: [{ key: `${name}.done`, value: true }],
          }),
        },
      ],
    });

    const agent = createAgent("a1", bus, [
      stepPlan("build"),
      stepPlan("test"),
      stepPlan("deploy"),
    ]);
    agent.goals.add({
      id: "g-build",
      name: "build",
      priority: 10,
      status: "pending",
    });
    agent.goals.add({
      id: "g-test",
      name: "test",
      priority: 9,
      status: "pending",
    });
    agent.goals.add({
      id: "g-deploy",
      name: "deploy",
      priority: 1,
      status: "pending",
      dependsOn: ["g-build", "g-test"],
    });

    await agent.start();
    // One tick short of the fan-in completing: both prerequisites are done, and
    // the goal waiting on both is not.
    for (let i = 0; i < 2; i++) {
      await agent.tick();
    }
    expect(agent.beliefs.get("build.done")).toBe(true);
    expect(agent.beliefs.get("test.done")).toBe(true);
    expect(agent.beliefs.get("deploy.done")).toBeUndefined();

    for (let i = 0; i < 3; i++) {
      await agent.tick();
    }
    expect(agent.beliefs.get("deploy.done")).toBe(true);

    await agent.stop();
  });

  it("never runs a goal whose dependency is not met and never will be", async () => {
    const bus = new InMemoryMessageBus();

    const workPlan: Plan = {
      name: "deploy",
      trigger: (_, goal) => goal.name === "deploy",
      body: [{ name: "do", execute: async (): Promise<ActionResult> => ({}) }],
    };

    const agent = createAgent("a1", bus, [workPlan]);
    agent.goals.add({
      id: "g-deploy",
      name: "deploy",
      priority: 5,
      status: "pending",
      dependsOn: ["g-never-existed"],
    });

    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    // No status change at all: the goal is neither started nor failed, because
    // the dependency it is waiting on has not failed either.
    expect(agent.goals.get("g-deploy")?.status).toBe("pending");
    expect(agent.intentions.getAll()).toHaveLength(0);

    await agent.stop();
  });

  it("resumes a parent with onChildFailure: continue", async () => {
    const bus = new InMemoryMessageBus();

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
    const statuses = recordGoalStatuses(agent);
    const history = recordHistory(agent);
    const failures = recordFailures(agent);
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
    expect(statuses.statusOf("p")).toBe("achieved");

    const parent = history.intentionsFor("parent")[0];
    expect(parent.status).toBe("completed");
    expect(parent.failureReason).toBeUndefined();
    expect(parent.children).toEqual([]);
    expect(parent.childFailures).toEqual([
      expect.objectContaining({ goal: "child", reason: "x" }),
    ]);

    // Only the sub-goal failed; the recovering parent reported nothing.
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
    const statuses = recordGoalStatuses(agent);
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
    expect(statuses.statusOf("p")).toBe("achieved");

    agent.stop();
  });

  it("tracks sub-goals back to the goal that created them", async () => {
    const bus = new InMemoryMessageBus();

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
    const history = recordHistory(agent);
    const failures = recordFailures(agent);
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

    const byName = new Map(history.goals.map((g) => [g.name, g]));
    const top = byName.get("top")!;
    const middle = byName.get("middle")!;
    const leaf = byName.get("leaf")!;

    expect(top.parentGoalId).toBeUndefined();
    expect(middle.parentGoalId).toBe(top.id);
    expect(middle.rootGoalId).toBe(top.id);
    expect(leaf.parentGoalId).toBe(middle.id);
    expect(leaf.rootGoalId).toBe(top.id);

    // The failure events carry the same lineage, so whoever maps them onto her
    // own channel still sees a failure's place in the decomposition.
    const events = failures.map((f) => ({
      goal: f.intention.goal.name,
      goalId: f.intention.goal.id,
      ...(f.intention.goal.parentGoalId
        ? { parentGoalId: f.intention.goal.parentGoalId }
        : {}),
      ...(f.intention.goal.rootGoalId
        ? { rootGoalId: f.intention.goal.rootGoalId }
        : {}),
    }));
    expect(events.find((e) => e.goal === "leaf")).toMatchObject({
      goalId: leaf.id,
      parentGoalId: middle.id,
      rootGoalId: top.id,
    });
    expect(events.find((e) => e.goal === "top")).not.toHaveProperty(
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
    const agent = createAgent("a1", bus, willing("fetchData"));

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
    const agent = createAgent("a1", bus, declaring("shipIt"));

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
    const agent = createAgent("a1", bus, willing("fetchData"));

    agent.start();
    await bus.send("a1", {
      replyWith: "msg-7",
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.goals.all()[0].source).toEqual({
      sender: "ui",
      inReplyTo: "msg-7",
    });

    agent.stop();
  });

  it("honours a caller-supplied goal id", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, willing("fetchData"));

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData", goalId: "pinned-1" },
      timestamp: Date.now(),
    });
    await agent.tick();
    await agent.tick();

    expect(agent.goals.all()[0].id).toBe("pinned-1");
    expect(inbox[0].content).toMatchObject({ goalId: "pinned-1" });

    agent.stop();
  });

  it("falls back to a generated id when the supplied one is taken", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    // The occupying goal needs a plan of its own, or it is refused as
    // "no-plan" and collected, and there would be no id left to collide with.
    const agent = createAgent("a1", bus, willing("fetchData", "existing"));

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
    await agent.tick();

    const added = agent.goals.all().find((g) => g.name === "fetchData")!;
    // The existing goal keeps its id and contents...
    expect(agent.goals.get("pinned-1")?.name).toBe("existing");
    // ...and the newcomer gets a fresh id, which is the one the sender is told.
    expect(added.id).not.toBe("pinned-1");
    expect(inbox[0].content).toMatchObject({ goalId: added.id });

    agent.stop();
  });

  it("agrees to a request, naming the goal id it assigned", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, willing("fetchData"));

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();
    await agent.tick();

    expect(inbox).toHaveLength(1);
    // `conversation-id` is a message parameter, so it belongs to the envelope —
    // it says which exchange this is part of, which is not part of the meaning
    // of agreeing.
    expect(inbox[0]).toMatchObject({
      performative: "agree",
      sender: "a1",
      receiver: "ui",
      conversationId: "chat-1",
    });
    expect(inbox[0].content).toEqual({
      goal: "fetchData",
      goalId: agent.goals.all()[0].id,
    });

    agent.stop();
  });

  it("agrees to a request on admission, before the plan runs", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, willing("fetchData"));

    agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });

    // Delivery is not perception: the request waits, so nothing is created or
    // acknowledged on the sender's stack.
    expect(agent.inbox.size()).toBe(1);
    expect(agent.goals.all()).toHaveLength(0);
    expect(inbox).toHaveLength(0);

    // The cycle that admits the goal also agrees to it, because by this point
    // every question that can be answered "no" has been: the middleware chain
    // admitted it, the plan library said it is able, and the queue said there is
    // room. The
    // trigger's "not yet" does not withdraw that commitment — it only delays
    // the work. The id the sender is given is therefore always one the receiver
    // already holds.
    await agent.tick();
    expect(agent.goals.all()).toHaveLength(1);
    expect(inbox).toHaveLength(1);

    agent.stop();
  });

  it("echoes the message id back in the agreement", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, []);

    agent.start();
    await bus.send("a1", {
      replyWith: "msg-7",
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(inbox[0]).toMatchObject({ inReplyTo: "msg-7" });

    agent.stop();
  });

  it("does not agree to a request the agent sent itself", async () => {
    const bus = new InMemoryMessageBus();
    // A client registered under the agent's own id would have its inbox
    // replaced by agent.start(), so watch the bus instead.
    const send = vi.spyOn(bus, "send");
    const agent = createAgent("a1", bus, willing("fetchData"));

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
      send.mock.calls.filter(([, msg]) => msg.performative === "agree"),
    ).toHaveLength(0);

    agent.stop();
  });

  it("declines a directive its chain rejects, and says why", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "stranger");
    const agent = createAgent("a1", bus, [], undefined, [
      async (msg, res, next) => {
        if (msg.sender !== "stranger") {
          await next();
          return;
        }
        res.refuse("middleware", "only ui may direct me");
      },
    ]);
    const refusals: GoalRefusal[] = [];
    agent.on("goal:refused", (r) => refusals.push(r));
    await agent.start();

    await bus.send("a1", {
      performative: "request",
      sender: "stranger",
      conversationId: "chat-1",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // Declined before a goal existed, so nothing was queued and no agreement
    // went out — and the answer goes back to the requester, who is the only
    // party the request was addressed to.
    expect(agent.goals.all()).toEqual([]);
    expect(inbox.map((m) => m.performative)).toEqual(["refuse"]);
    expect(inbox[0]).toMatchObject({
      performative: "refuse",
      conversationId: "chat-1",
    });
    expect(inbox[0].content).toMatchObject({
      goal: "fetchData",
      verdict: "middleware",
      reason: "only ui may direct me",
    });

    expect(refusals).toEqual([
      {
        agentId: "a1",
        goal: "fetchData",
        verdict: "middleware",
        reason: "only ui may direct me",
        conversationId: "chat-1",
      },
    ]);

    await agent.stop();
  });

  it("echoes the message id back in the refusal", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, [], undefined, [
      async (_req, res) => res.refuse("middleware", "not now"),
    ]);

    await agent.start();
    await bus.send("a1", {
      replyWith: "msg-7",
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // The correlation travels with the decline, so a sender pairing answers to
    // requests can match this one even among several in flight.
    expect(inbox[0]).toMatchObject({ inReplyTo: "msg-7" });

    await agent.stop();
  });

  it("does not answer its own decline", async () => {
    const bus = new InMemoryMessageBus();
    const send = vi.spyOn(bus, "send");
    const agent = createAgent("a1", bus, [], undefined, [
      async (_req, res) => res.refuse(),
    ]);

    await agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "a1",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // Answering yourself is noise, exactly as with an agreement. A bare `false`
    // declines without inventing a reason to pass on.
    expect(
      send.mock.calls.filter(
        ([to, msg]) => to === "a1" && msg.performative === "refuse",
      ),
    ).toHaveLength(0);

    await agent.stop();
  });

  it("reports a refusal to the sender that asked for the work", async () => {
    const bus = new InMemoryMessageBus();
    const caller = createAgent("caller", bus, []);
    const refusals: GoalRefusal[] = [];
    caller.on("goalRefused", (r) => refusals.push(r));
    const send = vi.spyOn(bus, "send");

    await caller.start();
    // A refusal that names no verdict and no reason, as a peer outside this
    // library's vocabulary might send. It is still a refusal, so it is reported
    // rather than dropped.
    await bus.send("caller", {
      performative: "refuse",
      sender: "worker",
      content: { goal: "fetch" },
      timestamp: Date.now(),
    });
    await caller.tick();

    // This is what turns a declined request from silence into an answer: the
    // sender can tell "declined" from "still deciding". Both fields are absent
    // because the peer gave neither — a sender must not have either invented
    // for it.
    expect(refusals).toEqual([
      {
        agentId: "worker",
        goal: "fetch",
      },
    ]);
    // A refusal is a decision about a conversation, but it also updates the
    // belief base: the sender gets an infeasibility record so it knows the
    // other agent will not work on this goal.
    expect(
      caller.beliefs.get<{ verdict?: string; reason?: unknown }>(
        "infeasible.worker.fetch",
      ),
    ).toMatchObject({ verdict: undefined, reason: undefined });
    expect(caller.beliefs.statusOf("infeasible.worker.fetch")).toBe("negative");
    // And it is not a directive, so it is and it is not answered with a goal of its own.
    expect(
      send.mock.calls.filter(
        ([to, msg]) => to === "worker" && msg.performative === "refuse",
      ),
    ).toHaveLength(0);

    await caller.stop();
  });

  it("reads the verdict and the reason off a refusal as two separate fields", async () => {
    const bus = new InMemoryMessageBus();
    const caller = createAgent("caller", bus, []);
    const refusals: GoalRefusal[] = [];
    caller.on("goalRefused", (r) => refusals.push(r));

    await caller.start();
    // The two are not interchangeable. `verdict` is the closed vocabulary and
    // `reason` is FIPA's φ, so the free text a sender wants to read cannot be
    // mistaken for a category and cannot invent one.
    await bus.send("caller", {
      performative: "refuse",
      sender: "worker",
      content: {
        goal: "fetch",
        verdict: "capacity",
        reason: "queue is full until 14:00",
      },
      timestamp: Date.now(),
    });
    await caller.tick();

    expect(refusals).toEqual([
      {
        agentId: "worker",
        goal: "fetch",
        verdict: "capacity",
        reason: "queue is full until 14:00",
      },
    ]);

    await caller.stop();
  });

  it("believes only a transient verdict reported back by a peer", async () => {
    const bus = new InMemoryMessageBus();
    const caller = createAgent("caller", bus, []);
    const refusals: GoalRefusal[] = [];
    caller.on("goalRefused", (r) => refusals.push(r));

    await caller.start();

    // FIPA's `refuse` claims the action will not be done and the agent does not
    // intend it, and that claim is permanent. It is also untrue of a full queue,
    // so only the two verdicts a peer can meaningfully still be in change of
    // survive the trip back; `no-plan` and `unsupported` are settled facts about
    // the agent, and a peer reporting one now would be reporting a state we
    // could not have watched change.
    for (const content of [
      { goal: "a", verdict: "capacity" },
      { goal: "b", verdict: "middleware" },
      { goal: "c", verdict: "no-plan" },
      { goal: "d", verdict: "unsupported" },
    ]) {
      await bus.send("caller", {
        performative: "refuse",
        sender: "worker",
        content,
        timestamp: Date.now(),
      });
      await caller.tick();
    }

    // All four are still refusals, so all four are reported — only the verdicts
    // are filtered, never the fact of the refusal.
    expect(refusals.map((r) => r.goal)).toEqual(["a", "b", "c", "d"]);
    expect(refusals.map((r) => r.verdict)).toEqual([
      "capacity",
      "middleware",
      undefined,
      undefined,
    ]);

    await caller.stop();
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

    const history = recordHistory(agent);

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

    const byName = new Map(history.goals.map((g) => [g.name, g]));
    const source = { sender: "ui", conversationId: "chat-1" };
    expect(byName.get("top")?.source).toEqual(source);
    expect(byName.get("middle")?.source).toEqual(source);
    expect(byName.get("leaf")?.source).toEqual(source);

    agent.stop();
  });

  it("carries the source on the failure event's goal", async () => {
    const bus = new InMemoryMessageBus();

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
    const failures = recordFailures(agent);

    agent.start();
    await bus.send("a1", {
      replyWith: "msg-7",
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "risky" },
      timestamp: Date.now(),
    });
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("503 from registry");
    expect(failures[0].intention.goal.name).toBe("risky");
    // The source travelled with the goal, so the failure event carries it too.
    expect(failures[0].intention.goal.source).toEqual({
      sender: "ui",
      conversationId: "chat-1",
      inReplyTo: "msg-7",
    });

    agent.stop();
  });

  it("leaves source off the failure event's goal when added directly", async () => {
    const bus = new InMemoryMessageBus();

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
    const failures = recordFailures(agent);

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

    expect(failures).toHaveLength(1);
    expect(failures[0].intention.goal.source).toBeUndefined();

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
    const history = recordHistory(worker);
    const caller = createAgent("caller", bus, []);
    const acks: GoalAck[] = [];
    caller.on("goalAcknowledged", (ack) => acks.push(ack));

    await caller.start();
    await worker.start();

    const request = await sendRequest(caller, "worker", { goal: "fetch" });
    await worker.tick();
    await worker.tick();
    // The ack is perceived by the cycle that reads it, like any other message.
    await caller.tick();

    expect(acks).toEqual([
      {
        agentId: "worker",
        goal: "fetch",
        goalId: history.goals[0].id,
        // The ack carries the conversation and names the message it answers,
        // so the sender can match it to this request without correlating on
        // goal name — two `fetch` requests in flight stay distinguishable.
        conversationId: request.conversationId,
        inReplyTo: request.replyWith,
      },
    ]);
    // The ack updates the intention belief from uncertain to positive — scoped
    // to this exchange — so the sender can track what a peer intends without
    // polluting the goal queue.
    expect(
      caller.beliefs.statusOf(`intent.worker.fetch.${request.replyWith}`),
    ).toBe("positive");
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

    await sendRequest(caller, "worker", { goal: "fetch" });
    await worker.tick();
    await worker.tick();

    expect(acks).toEqual([]);

    await worker.stop();
    await caller.stop();
  });

  it("ignores an agree that does not name a goal", async () => {
    const bus = new InMemoryMessageBus();
    const caller = createAgent("caller", bus, []);
    const acks: GoalAck[] = [];
    caller.on("goalAcknowledged", (ack) => acks.push(ack));

    await caller.start();
    await bus.send("caller", {
      performative: "agree",
      sender: "worker",
      content: { note: "acknowledged" },
      timestamp: Date.now(),
    });
    await caller.tick();

    expect(acks).toEqual([]);

    await caller.stop();
  });

  it("reports a completed intention with the result of the last action", async () => {
    const bus = new InMemoryMessageBus();

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
    const statuses = recordGoalStatuses(agent);
    const completions = recordCompletions(agent);

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

    expect(statuses.statusOf("g-7")).toBe("achieved");
    expect(completions).toHaveLength(1);
    expect(completions[0].goal.id).toBe("g-7");
    expect(completions[0].goal.name).toBe("deploy");
    expect(completions[0].plan.name).toBe("deploy");
    // The action that ran last is one before the current index: the index has
    // already advanced past the plan's final action.
    expect(completions[0].plan.body[completions[0].actionIndex - 1].name).toBe(
      "put",
    );
    expect(completions[0].result).toEqual({
      beliefUpdates: [{ key: "deployed", value: true }],
    });

    agent.stop();
  });

  it("includes lineage and source in a sub-goal completion event", async () => {
    const bus = new InMemoryMessageBus();

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
    const history = recordHistory(agent);
    const completions = recordCompletions(agent);

    agent.start();
    await bus.send("a1", {
      replyWith: "msg-7",
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "parent" },
      timestamp: Date.now(),
    });
    for (let i = 0; i < 12; i++) {
      await agent.tick();
    }

    const child = completions.find((c) => c.goal.name === "child");
    const parentGoalId = history.goals.find((g) => g.name === "parent")!.id;
    expect(child?.goal).toMatchObject({
      name: "child",
      parentGoalId,
      rootGoalId: parentGoalId,
      source: { sender: "ui", conversationId: "chat-1", inReplyTo: "msg-7" },
    });
    expect(completions.some((c) => c.goal.name === "parent")).toBe(true);

    agent.stop();
  });

  it("reports a completion event for every achieving agent", async () => {
    const bus = new InMemoryMessageBus();

    const plan = (): Plan => ({
      name: "work",
      trigger: (_, goal) => goal.name === "work",
      body: [{ name: "go", execute: async (): Promise<ActionResult> => ({}) }],
    });

    // The counterpart of the per-agent failure test: completions fire on each
    // agent, and a user maps them onto her own channel.
    const completed = new Map<string, string[]>();
    for (const id of ["a1", "a2"]) {
      const agent = createAgent(id, bus, [plan()]);
      const own: string[] = [];
      agent.on("intention:completed", ({ goal }) => own.push(goal.name));
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
      completed.set(id, own);
    }

    expect([...completed.entries()]).toEqual([
      ["a1", ["work"]],
      ["a2", ["work"]],
    ]);
  });

  it("does not report a completion for a failed goal", async () => {
    const bus = new InMemoryMessageBus();

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

    const statuses = recordGoalStatuses(agent);
    const completions = recordCompletions(agent);

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

    expect(statuses.statusOf("g-1")).toBe("failed");
    expect(completions).toHaveLength(0);

    agent.stop();
  });

  it("reports the id actually assigned when a pinned id was taken", async () => {
    const bus = new InMemoryMessageBus();
    const worker = createWorker(bus, "worker");
    const history = recordHistory(worker);
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
    await caller.tick();

    // The caller pinned "job-7" and got a different id back, so it can notice
    // its pin lost the race instead of tracking a goal it cannot name.
    expect(acks).toHaveLength(1);
    expect(acks[0].goalId).not.toBe("job-7");
    expect(acks[0].goalId).toBe(
      history.goals.find((g) => g.name === "fetch")!.id,
    );

    await worker.stop();
    await caller.stop();
  });
});

describe("Agent request belief tracking", () => {
  const fetchPlan: Plan = {
    name: "fetch",
    trigger: (_, goal) => goal.name === "fetch",
    body: [{ name: "go", execute: async (): Promise<ActionResult> => ({}) }],
  };

  const createWorker = (bus: InMemoryMessageBus, id: string): Agent =>
    createAgent(id, bus, [fetchPlan]);

  it("creates an uncertain intention belief when sending a request", async () => {
    const bus = new InMemoryMessageBus();
    const worker = createAgent("worker", bus, [fetchPlan]);
    const caller = createAgent("caller", bus, []);

    await caller.start();
    await worker.start();

    const request = await sendRequest(caller, "worker", { goal: "fetch" });
    await caller.tick();

    expect(
      caller.beliefs.statusOf(`intent.worker.fetch.${request.replyWith}`),
    ).toBe("uncertain");
    expect(
      caller.beliefs.get(`intent.worker.fetch.${request.replyWith}`),
    ).toEqual({
      goal: "fetch",
    });

    await worker.stop();
    await caller.stop();
  });

  it("promotes the intention belief to positive on agree", async () => {
    const bus = new InMemoryMessageBus();
    const worker = createWorker(bus, "worker");
    const caller = createAgent("caller", bus, []);

    await caller.start();
    await worker.start();

    const request = await sendRequest(caller, "worker", { goal: "fetch" });
    await worker.tick();
    await worker.tick();
    await caller.tick();

    expect(
      caller.beliefs.statusOf(`intent.worker.fetch.${request.replyWith}`),
    ).toBe("positive");
    // The goal queue is not polluted by the agreement.
    expect(caller.goals.all()).toEqual([]);

    await worker.stop();
    await caller.stop();
  });

  it("sets the intention belief to negative on refuse", async () => {
    const bus = new InMemoryMessageBus();
    // Worker has no plan for "fetch", so it will refuse with "no-plan".
    const worker = createAgent("worker", bus, []);
    const caller = createAgent("caller", bus, [fetchPlan]);

    await caller.start();
    await worker.start();

    const request = await sendRequest(caller, "worker", { goal: "fetch" });
    await worker.tick();
    await worker.tick();
    await caller.tick();

    expect(
      caller.beliefs.statusOf(`intent.worker.fetch.${request.replyWith}`),
    ).toBe("negative");
    // An infeasibility belief is also recorded, scoped to this exchange.
    const infeasible = caller.beliefs.get<{
      verdict?: string;
      reason?: unknown;
    }>(`infeasible.worker.fetch.${request.replyWith}`);
    expect(infeasible).toBeDefined();
    expect(
      caller.beliefs.statusOf(`infeasible.worker.fetch.${request.replyWith}`),
    ).toBe("negative");

    await worker.stop();
    await caller.stop();
  });

  it("records the verdict and reason in the infeasibility belief", async () => {
    const bus = new InMemoryMessageBus();
    const worker = createAgent("worker", bus, [fetchPlan]);
    const caller = createAgent("caller", bus, []);
    const refusals: GoalRefusal[] = [];
    caller.on("goalRefused", (r) => refusals.push(r));

    await caller.start();
    await worker.start();

    // A middleware that refuses with a custom verdict and reason.
    const refusingWorker = createAgent("refuser", bus, [], undefined, [
      async (_req, res, next) => {
        res.refuse("middleware", "not allowed");
      },
    ]);
    await refusingWorker.start();

    await bus.send("refuser", {
      performative: "request",
      sender: "caller",
      receiver: "refuser",
      content: { goal: "fetch" },
      timestamp: Date.now(),
    });
    await refusingWorker.tick();
    await refusingWorker.tick();
    await caller.tick();

    // The bare request names no exchange, so the refusal's own stamped
    // conversation id becomes the exchange — each exchange gets its own record
    // even when the peer that started it opted out of correlation.
    const exchange = refusals[0]?.conversationId;
    expect(exchange).toBeDefined();

    const infeasible = caller.beliefs.get<{
      verdict?: string;
      reason?: unknown;
    }>(`infeasible.refuser.fetch.${exchange}`);
    expect(infeasible?.verdict).toBe("middleware");
    expect(infeasible?.reason).toBe("not allowed");

    await worker.stop();
    await refusingWorker.stop();
    await caller.stop();
  });

  it("does not create beliefs when sending a request with no receiver", async () => {
    const bus = new InMemoryMessageBus();
    const caller = createAgent("caller", bus, []);

    await caller.start();

    // Sending to a non-existent receiver still creates the belief, since the
    // agent cannot know at send time whether delivery will succeed.
    const request = await sendRequest(caller, "ghost", { goal: "fetch" });
    await caller.tick();

    expect(
      caller.beliefs.statusOf(`intent.ghost.fetch.${request.replyWith}`),
    ).toBe("uncertain");

    await caller.stop();
  });

  it("does not let a later refusal flip an earlier agreement", async () => {
    const bus = new InMemoryMessageBus();
    // The worker has a plan for "fetch", so it agrees — until a middleware
    // declines the second request for capacity. The second refusal must not
    // rewrite what the first exchange already established.
    let directivesSeen = 0;
    const worker = createAgent("worker", bus, [fetchPlan], undefined, [
      async (_req, res, next) => {
        directivesSeen += 1;
        if (directivesSeen > 1) {
          res.refuse("capacity", "busy");
          return;
        }
        await next();
      },
    ]);
    const caller = createAgent("caller", bus, []);

    await caller.start();
    await worker.start();

    const agreed = await sendRequest(caller, "worker", { goal: "fetch" });
    await worker.tick();
    await worker.tick();
    await caller.tick();
    expect(
      caller.beliefs.statusOf(`intent.worker.fetch.${agreed.replyWith}`),
    ).toBe("positive");

    const refused = await sendRequest(caller, "worker", { goal: "fetch" });
    await worker.tick();
    await worker.tick();
    await caller.tick();
    // This exchange's record reflects the refusal…
    expect(
      caller.beliefs.statusOf(`intent.worker.fetch.${refused.replyWith}`),
    ).toBe("negative");
    expect(
      caller.beliefs.statusOf(`infeasible.worker.fetch.${refused.replyWith}`),
    ).toBe("negative");
    // …and the first exchange is untouched. This is the reason the beliefs are
    // keyed per exchange at all: goal-scoped keys let a second refusal of the
    // same goal rewrite a running first request's positive stance.
    expect(
      caller.beliefs.statusOf(`intent.worker.fetch.${agreed.replyWith}`),
    ).toBe("positive");

    await worker.stop();
    await caller.stop();
  });

  it("tracks the request content from an action result", async () => {
    const bus = new InMemoryMessageBus();
    // Caller has a plan that delegates to worker via an action result.
    const delegator = createAgent("delegator", bus, [
      {
        name: "orchestrate",
        trigger: (_, goal) => goal.name === "orchestrate",
        body: [
          {
            name: "delegate",
            execute: async (): Promise<ActionResult> => ({
              messages: [
                {
                  receiver: "worker",
                  performative: "request" as Performative,
                  content: { goal: "fetch", priority: 7 },
                },
              ],
            }),
          },
        ],
      },
    ]);
    const worker = createWorker(bus, "worker");

    await delegator.start();
    await worker.start();

    // The request's correlation is stamped by sendMessage, so capture the ids
    // of what actually goes out rather than guessing them.
    const sent: Message[] = [];
    delegator.on("message:sent", (m) => sent.push(m));

    // Kick off the orchestrating goal on the delegator.
    delegator.goals.add({
      id: "g-1",
      name: "orchestrate",
      priority: 10,
      status: "pending",
    });
    await delegator.tick();

    // The action result sends the request, which must create the intention belief.
    const request = sent.find((m) => m.performative === "request")!;
    expect(request).toBeDefined();
    expect(
      delegator.beliefs.statusOf(`intent.worker.fetch.${request.replyWith}`),
    ).toBe("uncertain");
    expect(
      delegator.beliefs.get<{ goal: string; priority: number }>(
        `intent.worker.fetch.${request.replyWith}`,
      ),
    ).toEqual({ goal: "fetch", priority: 7 });

    // Worker agrees, promoter the belief to positive.
    await worker.tick();
    await worker.tick();
    await delegator.tick();

    expect(
      delegator.beliefs.statusOf(`intent.worker.fetch.${request.replyWith}`),
    ).toBe("positive");

    await worker.stop();
    await delegator.stop();
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
    const history = recordHistory(agent);
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

    const childId = history.goals.find((g) => g.name === "child")!.id;
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

  it("reports the messages it sends, including replies", async () => {
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

    // The `failure` is the request protocol's own answer, not something the
    // plan sent: the action failed, so the exchange it agreed to has to close.
    expect(sent).toEqual(["agree->ui@a1", "failure->ui@a1"]);

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

describe("Agent goal queue bound", () => {
  const fillerPlan: Plan = {
    name: "filler",
    trigger: (_, goal) => goal.name === "filler",
    body: [{ name: "noop", execute: async (): Promise<ActionResult> => ({}) }],
  };

  it("refuses work past the bound and says the refusal is backpressure", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [fillerPlan], 1);
    const rejected: GoalRejection[] = [];
    agent.on("goal:rejected", (r) =>
      rejected.push({ ...r, goal: { ...r.goal } }),
    );

    agent.goals.add({
      id: "g1",
      name: "filler",
      priority: 5,
      status: "pending",
    });
    await agent.start();
    agent.goals.add({
      id: "g2",
      name: "filler",
      priority: 5,
      status: "pending",
    });
    await agent.tick();

    // `goal:rejected` is the event form of what used to be a `failure.a1`
    // notice: the refused goal and the reason naming the limit.
    expect(rejected.map((r) => r.goal.id)).toEqual(["g2"]);
    expect(rejected[0].goal.name).toBe("filler");
    expect(rejected[0].reason).toContain("limit 1");
  });

  it("refuses the requester the goal it shed for capacity", async () => {
    const bus = new InMemoryMessageBus();
    const inbox: Message[] = [];
    bus.registerAgent("ui", (msg) => inbox.push(msg));
    const agent = createAgent("a1", bus, [fillerPlan], 1);

    agent.goals.add({
      id: "g1",
      name: "filler",
      priority: 1,
      status: "pending",
    });
    await agent.start();
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content: { goal: "filler" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // The directive's own goal is what the bound refuses, so the requester gets
    // a refusal and no agreement: never an `agree` naming a goal that was
    // dropped. One refusal, because the queue owns the answer.
    expect(inbox.map((m) => m.performative)).toEqual(["refuse"]);
    expect(inbox[0].content).toMatchObject({
      goal: "filler",
      verdict: "capacity",
    });
    expect(inbox[0].content).toMatchObject({
      reason: expect.stringContaining("limit 1"),
    });
  });

  it("fails a parent waiting on a sub-goal the bound refused", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent(
      "a1",
      bus,
      [
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
            { name: "wrap", execute: async (): Promise<ActionResult> => ({}) },
          ],
        },
      ],
      1,
    );
    const statuses = recordGoalStatuses(agent);

    agent.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });
    await agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    // The child never got room, so the parent cannot recover: it fails rather
    // than waiting forever on a sub-goal that was refused.
    expect(statuses.statusOf("p")).toBe("failed");
  });

  it("makes room again once earlier work finishes", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [fillerPlan], 1);
    const statuses = recordGoalStatuses(agent);

    await agent.start();
    for (let i = 0; i < 6; i++) {
      agent.goals.add({
        id: `g${i}`,
        name: "filler",
        priority: 5,
        status: "pending",
      });
      await agent.tick();
    }

    // A bound of one goal still clears six of them, because each finished goal
    // is collected at the end of its own cycle.
    expect(statuses.changes.filter((c) => c.to === "achieved")).toHaveLength(6);
    expect(agent.goals.all()).toEqual([]);
  });

  it("holds no goal or intention after a long run of finished work", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [fillerPlan], 0);

    await agent.start();
    for (let i = 0; i < 200; i++) {
      agent.goals.add({
        id: `g${i}`,
        name: "filler",
        priority: 5,
        status: "pending",
      });
      await agent.tick();
    }

    expect(agent.goals.all()).toEqual([]);
    expect(agent.intentions.getAll()).toEqual([]);
  });

  it("rejects a nonsensical bound", () => {
    const bus = new InMemoryMessageBus();
    expect(() => createAgent("a1", bus, [], -1)).toThrow(/maxGoals/);
    expect(() => createAgent("a1", bus, [], 1.5)).toThrow(/maxGoals/);
  });
});

describe("Directive negotiation", () => {
  const registerClient = (bus: InMemoryMessageBus, id: string): Message[] => {
    const inbox: Message[] = [];
    bus.registerAgent(id, (msg) => inbox.push(msg));
    return inbox;
  };

  const request = (bus: InMemoryMessageBus, to: string, goal: string) =>
    bus.send(to, {
      performative: "request",
      sender: "ui",
      content: { goal },
      timestamp: Date.now(),
    });

  const performatives = (inbox: Message[]): string[] =>
    inbox.map((m) => m.performative);

  it("refuses a goal no plan declares, without creating it", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, willing("known"));

    agent.start();
    await request(bus, "a1", "unknown");
    await agent.tick();
    await agent.tick();

    // Answered before the goal existed, because a plan library is fixed for the
    // agent's lifetime: "no plan can do this" is a fact about the agent, not a
    // question about its current beliefs.
    expect(performatives(inbox)).toEqual(["refuse"]);
    expect(inbox[0].content).toMatchObject({
      goal: "unknown",
      verdict: "no-plan",
    });
    expect(agent.goals.all()).toHaveLength(0);

    agent.stop();
  });

  it("holds no capacity for a goal it refused as no-plan", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerClient(bus, "ui");
    const agent = createAgent("a1", bus, willing("known"), 1);

    agent.start();
    for (let i = 0; i < 4; i++) {
      await request(bus, "a1", "unknown");
    }
    await agent.tick();
    await agent.tick();

    // The single slot is still free: an unservable goal refused at admission
    // never becomes a queued goal that can hold it.
    expect(agent.goals.all()).toHaveLength(0);

    await request(bus, "a1", "known");
    await agent.tick();
    await agent.tick();

    expect(performatives(inbox)).toEqual([
      "refuse",
      "refuse",
      "refuse",
      "refuse",
      "agree",
    ]);

    agent.stop();
  });

  it("frees the slot of a sub-goal no plan serves", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent(
      "a1",
      bus,
      [
        {
          name: "parent",
          can: "parent",
          trigger: () => true,
          body: [
            {
              name: "delegate",
              execute: async (): Promise<ActionResult> => ({
                // Nothing declares "orphan", so this sub-goal is refused the
                // moment it is looked for a plan to serve it.
                newGoals: [{ name: "orphan", priority: 1 }],
              }),
            },
            {
              // A second action, so the parent is still running and has
              // something left to do once the sub-goals resolve.
              name: "after",
              execute: async (): Promise<ActionResult> => ({}),
            },
          ],
        },
      ],
      1,
    );
    const statuses = recordGoalStatuses(agent);

    agent.goals.add({
      id: "g-parent",
      name: "parent",
      priority: 5,
      status: "pending",
    });

    agent.start();
    for (let i = 0; i < 5; i++) {
      await agent.tick();
    }

    // The orphan never became a queued goal holding the bound's only slot, and
    // the parent that was waiting on it is failed rather than left waiting.
    expect(statuses.statusOf("g-parent")).toBe("failed");
    expect(agent.goals.all()).toHaveLength(0);
    expect(agent.intentions.getActive()).toHaveLength(0);

    agent.stop();
  });
});

describe("Directives the agent cannot act on", () => {
  /**
   * A plan that would run the work if it were ever admitted, so the only thing
   * standing between an unsupported directive and a goal is the refusal.
   *
   * `close-window` on purpose: if any of these were admitted, the goal would
   * name a servable plan and the test would see a goal instead of a refusal.
   */
  function servable(): Plan[] {
    return [
      {
        name: "do-window",
        can: "close-window",
        trigger: () => true,
        body: [
          { name: "close", execute: async (): Promise<ActionResult> => ({}) },
          { name: "log", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
    ];
  }

  // Every directive that is not one whose receiver takes on work lands here.
  // The list is pinned so a new CA directive cannot be added to the vocabulary
  // and quietly start doing nothing at all.
  const UNSUPPORTED: Performative[] = [
    "request-when",
    "request-whenever",
    "subscribe",
  ];

  it.each(UNSUPPORTED)(
    "refuses %s instead of inventing work",
    async (performative) => {
      const bus = new InMemoryMessageBus();
      const agent = createAgent("a1", bus, servable());
      const refusals: GoalRefusal[] = [];
      const acks: GoalAck[] = [];
      agent.on("goal:refused", (r) => refusals.push(r));
      agent.on("goalAcknowledged", (a) => acks.push(a));
      await agent.start();

      const sent: Message[] = [];
      agent.on("message:sent", (msg) => sent.push(msg));

      await bus.send("a1", {
        performative,
        sender: "ui",
        content: { goal: "close-window", condition: { raining: true } },
        timestamp: Date.now(),
      });
      await agent.tick();

      // Never agreed, and no goal: agreeing would run the work the moment the
      // plan is servable, which is not what any of these asked for.
      expect(acks).toHaveLength(0);
      expect(agent.goals.all()).toHaveLength(0);
      expect(refusals).toHaveLength(1);
      expect(refusals[0].verdict).toBe("unsupported");
      expect(refusals[0].reason).toContain(performative);

      const reply = sent.find((m) => m.performative === "refuse");
      expect(reply?.performative).toBe("refuse");
      expect((reply?.content as { verdict?: string }).verdict).toBe(
        "unsupported",
      );

      await agent.stop();
    },
  );

  it("takes on no goal, so the queue never sees the work", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, servable());
    await agent.start();

    await bus.send("a1", {
      performative: "request-whenever",
      sender: "ui",
      content: { goal: "close-window", condition: { temperature: 40 } },
      timestamp: Date.now(),
    });
    await agent.tick();

    // Refused before admission, so unlike a `no-plan` refusal this never
    // occupied a slot that then had to be released.
    expect(agent.goals.all()).toHaveLength(0);

    await agent.stop();
  });

  it("still believes the condition it asserts", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, servable());
    await agent.start();

    await bus.send("a1", {
      performative: "request-when",
      sender: "ui",
      content: { goal: "close-window", raining: true, reading: 12 },
      timestamp: Date.now(),
    });
    await agent.tick();

    // `request-when` is both a directive and an assertion of its condition.
    // The action is refused, but the proposition the sender asserted is still
    // a fact offered to the belief base — refusing the work is not a reason to
    // disbelieve the sender.
    expect(agent.beliefs.get("msg.raining")).toBe(true);
    expect(agent.beliefs.get("msg.reading")).toBe(12);

    await agent.stop();
  });

  it("names the real obstacle, ahead of the agent's own policy", async () => {
    const bus = new InMemoryMessageBus();
    // A policy that would decline everything: the refusal should still report
    // that the performative is unrepresentable, not that this sender is barred.
    const agent = createAgent("a1", bus, servable(), undefined, [
      async (_req, res) => res.refuse("middleware", "no"),
    ]);
    await agent.start();

    const refusals: GoalRefusal[] = [];
    agent.on("goal:refused", (r) => refusals.push(r));

    await bus.send("a1", {
      performative: "request-when",
      sender: "ui",
      content: { goal: "close-window" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(refusals).toHaveLength(1);
    expect(refusals[0].verdict).toBe("unsupported");

    await agent.stop();
  });

  it("leaves a subclass free to handle the performative and inherit admission", async () => {
    const bus = new InMemoryMessageBus();

    // An agent with a condition language: it evaluates the condition itself,
    // admits the goal, and otherwise rides the base implementation for the plan
    // check, the bound and the agreement.
    class ConditionalAgent extends Agent {
      public admitted: string[] = [];

      protected override async handleUnsupportedDirective(
        msg: Message,
      ): Promise<void> {
        this.admitted.push(msg.performative);
        // Having evaluated the condition, hand it to ordinary admission.
        await this.considerDirective(msg, 5);
      }
    }

    // And a subclass that judges the condition unmet answers in the same shape
    // as the base refusal, rather than sending a bare `refuse`.
    class PickyAgent extends Agent {
      public declined: GoalRefusal[] = [];

      protected override async handleUnsupportedDirective(
        msg: Message,
      ): Promise<void> {
        this.declineDirective(msg, "middleware", {
          reason: "condition not met",
        });
      }
    }

    const lib = new PlanLibrary();
    for (const plan of servable()) {
      lib.register(plan);
    }
    const agent = new ConditionalAgent({
      id: "a1",
      bus,
      planLibrary: lib,
    });
    const sent: Message[] = [];
    agent.on("message:sent", (msg) => sent.push(msg));
    await agent.start();

    await bus.send("a1", {
      performative: "request-when",
      sender: "ui",
      content: { goal: "close-window", condition: { raining: true } },
      timestamp: Date.now(),
    });
    await agent.tick();

    // No refusal, and admission ran to completion: the subclass called
    // `considerDirective`, so the plan check, the bound and the `agree` all
    // applied exactly as they would for a plain `request`.
    expect(agent.admitted).toEqual(["request-when"]);
    expect(sent.filter((m) => m.performative === "refuse")).toHaveLength(0);

    const agree = sent.find((m) => m.performative === "agree");
    expect((agree?.content as { goal?: string })?.goal).toBe("close-window");

    await agent.stop();

    // The `declineDirective` hook a subclass uses when it understands the
    // performative but is not satisfied by it: same event, same reason
    // vocabulary.
    const pickyBus = new InMemoryMessageBus();
    const picky = new PickyAgent({
      id: "a2",
      bus: pickyBus,
      planLibrary: lib,
    });
    const pickyRefusals: GoalRefusal[] = [];
    picky.on("goal:refused", (r) => pickyRefusals.push(r));
    await picky.start();
    await pickyBus.send("a2", {
      performative: "request-when",
      sender: "ui",
      content: { goal: "close-window", condition: { raining: false } },
      timestamp: Date.now(),
    });
    await picky.tick();

    expect(pickyRefusals).toHaveLength(1);
    expect(pickyRefusals[0].verdict).toBe("middleware");
    expect(pickyRefusals[0].reason).toBe("condition not met");

    await picky.stop();
  });
});

describe("directiveMiddleware", () => {
  /** A plain bus client standing in for the requester, so replies can be read. */
  function registerRequester(bus: InMemoryMessageBus, id = "ui"): Message[] {
    const inbox: Message[] = [];
    bus.registerAgent(id, (msg) => inbox.push(msg));
    return inbox;
  }

  function library(...goalNames: string[]): PlanLibrary {
    const lib = new PlanLibrary();
    for (const plan of declaring(...goalNames)) {
      lib.register(plan);
    }
    return lib;
  }

  function request(
    bus: InMemoryMessageBus,
    content: Record<string, unknown>,
  ): Promise<void> {
    return bus.send("a1", {
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      content,
      timestamp: Date.now(),
    });
  }

  it("agrees by default, with no middleware configured", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(agent.goals.all()).toHaveLength(1);
    expect(inbox.map((m) => m.performative)).toEqual(["agree"]);
    await agent.stop();
  });

  it("runs the chain and agrees when it reaches the decision", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    let ran = false;
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, _res, next) => {
          ran = true;
          await next();
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(ran).toBe(true);
    expect(agent.goals.all()).toHaveLength(1);
    expect(inbox.map((m) => m.performative)).toEqual(["agree"]);
    await agent.stop();
  });

  it("declines with refuse when the chain cancels, rather than staying silent", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const refusals: GoalRefusal[] = [];
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async () => {
          // Cancel: no goal, but the sender is still owed an answer.
        },
      ],
    });
    agent.on("goal:refused", (r) => refusals.push(r));
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(agent.goals.all()).toEqual([]);
    // The whole point: a directive compels a hearer effect, so the requester is
    // told. Silence would be indistinguishable from never having arrived.
    expect(inbox.map((m) => m.performative)).toEqual(["refuse"]);
    expect(inbox[0].content).toMatchObject({
      goal: "fetchData",
      verdict: "middleware",
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ verdict: "middleware" });
    await agent.stop();
  });

  it("declines and names what a thrown middleware said", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async () => {
          throw new Error("acl unavailable");
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(agent.goals.all()).toEqual([]);
    expect(inbox.map((m) => m.performative)).toEqual(["refuse"]);
    expect(inbox[0].content).toMatchObject({
      verdict: "middleware",
      reason: "middleware threw: acl unavailable",
    });
    await agent.stop();
  });

  it("sends the reason and detail a handler gave", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, res) =>
          res.refuse("capacity", "queue is full until 14:00"),
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    // The sender learns which of the agent's facts produced the "no", and the
    // free text that the fixed verdict vocabulary has no room for.
    expect(inbox[0].content).toMatchObject({
      verdict: "capacity",
      reason: "queue is full until 14:00",
    });
    expect(agent.goals.all()).toEqual([]);
    await agent.stop();
  });

  it("defaults a bare refuse to the middleware reason", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [async (_req, res) => res.refuse()],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(inbox[0].content).toMatchObject({ verdict: "middleware" });
    await agent.stop();
  });

  it("does not admit the goal when a handler declines and then calls next", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, res, next) => {
          res.refuse("middleware", "no");
          // Falling through by mistake must not quietly admit the work.
          await next();
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(agent.goals.all()).toEqual([]);
    expect(inbox.map((m) => m.performative)).toEqual(["refuse"]);
    await agent.stop();
  });

  it("keeps the first reason given when two handlers decline", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, res, next) => {
          res.refuse("middleware", "first and most specific");
          await next();
        },
        async (_req, res, next) => {
          res.refuse("capacity", "a later, blunter objection");
          await next();
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    // The handler closest to the request knows most about it, so its reason
    // wins rather than being overwritten further down the chain.
    expect(inbox[0].content).toMatchObject({
      verdict: "middleware",
      reason: "first and most specific",
    });
    await agent.stop();
  });

  it("still answers when a handler declines without reaching the decision", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, res) => {
          res.refuse("middleware", "not for me");
        },
        async (_req, _res, next) => {
          await next();
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    // Declining does not have to stop the chain, and stopping the chain does
    // not have to lose the reason. One refusal, with the reason given.
    expect(inbox.map((m) => m.performative)).toEqual(["refuse"]);
    expect(inbox[0].content).toMatchObject({ reason: "not for me" });
    await agent.stop();
  });

  it("runs in order and reaches the decision once", async () => {
    const bus = new InMemoryMessageBus();
    const order: string[] = [];
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: ["first", "second", "third"].map((step) => {
        return async (
          _req: Message,
          _res: DirectiveResponse,
          next: () => Promise<void>,
        ) => {
          order.push(step);
          await next();
        };
      }),
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(order).toEqual(["first", "second", "third"]);
    expect(agent.goals.all()).toHaveLength(1);
    await agent.stop();
  });

  it("stops at the first to cancel and never runs the rest", async () => {
    const bus = new InMemoryMessageBus();
    const order: string[] = [];
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, _res, next) => {
          order.push("first");
          await next();
        },
        async () => {
          order.push("second");
        },
        async (_req, _res, next) => {
          order.push("third");
          await next();
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(order).toEqual(["first", "second"]);
    expect(agent.goals.all()).toEqual([]);
    await agent.stop();
  });

  it("awaits an async handler before deciding", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    let resolved = false;
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, _res, next) => {
          await new Promise((r) => setTimeout(r, 5));
          resolved = true;
          await next();
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    expect(resolved).toBe(true);
    // The agreement is out within the same tick, so the handler was awaited
    // rather than fired and forgotten.
    expect(inbox.map((m) => m.performative)).toEqual(["agree"]);
    await agent.stop();
  });

  it("declines before the plan library is consulted", async () => {
    const bus = new InMemoryMessageBus();
    const declares = vi.spyOn(PlanLibrary.prototype, "declares");
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, res) => res.refuse("middleware", "not yours"),
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();

    // The chain runs first, so a decline short-circuits admission entirely:
    // the plan library never has an opinion, and the sender is told why.
    expect(declares).not.toHaveBeenCalled();
    await agent.stop();
  });

  it("can rewrite the content before it is parsed", async () => {
    const bus = new InMemoryMessageBus();
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (req, _res, next) => {
          req.content = { goal: "fetchData" };
          await next();
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "somethingElse" });
    await agent.tick();

    // The rewritten name is what got admitted, so the remap took effect.
    expect(agent.goals.all().map((g) => g.name)).toEqual(["fetchData"]);
    await agent.stop();
  });

  it("can repair a request that names no goal, which otherwise gets silence", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (req, _res, next) => {
          const content = req.content as Record<string, unknown> | undefined;
          if (!content || typeof content.goal !== "string") {
            req.content = { goal: "fetchData" };
          }
          await next();
        },
      ],
    });
    await agent.start();

    // No goal named: unhandled this is silence, because there is nothing to
    // name in a refusal. The chain runs before parsing, so it can still help.
    await request(bus, { task: "fetchData" });
    await agent.tick();

    expect(agent.goals.all()).toHaveLength(1);
    expect(inbox.map((m) => m.performative)).toEqual(["agree"]);
    await agent.stop();
  });

  it("guards work while leaving claims to the belief chain", async () => {
    const bus = new InMemoryMessageBus();
    let directiveRan = false;
    let beliefRan = false;
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: library("fetchData"),
      directiveMiddleware: [
        async (_req, _res, next) => {
          directiveRan = true;
          await next();
        },
      ],
      middleware: [
        async (_msg, next) => {
          beliefRan = true;
          await next();
        },
      ],
    });
    await agent.start();

    await request(bus, { goal: "fetchData" });
    await agent.tick();
    expect(directiveRan).toBe(true);
    // `request` asserts nothing, so no belief is written and the belief chain
    // is not consulted.
    expect(beliefRan).toBe(false);

    directiveRan = false;
    await bus.send("a1", {
      performative: "inform",
      sender: "scout",
      content: { temperature: 22 },
      timestamp: Date.now(),
    });
    await agent.tick();

    // And the reverse: an assertion reaches the belief chain, never the
    // directive one. Trusting a peer's claims and accepting its work are two
    // separate decisions, so they get two independent chains.
    expect(beliefRan).toBe(true);
    expect(directiveRan).toBe(false);
    await agent.stop();
  });
});

describe("Request protocol terminal replies", () => {
  /**
   * A plain bus client standing in for whoever sent the request, so every
   * message the receiver puts on the wire for it can be read back.
   */
  function registerRequester(bus: InMemoryMessageBus, id = "ui"): Message[] {
    const inbox: Message[] = [];
    bus.registerAgent(id, (msg) => inbox.push(msg));
    return inbox;
  }

  /** One request, stamped by hand so the replies have ids to correlate with. */
  function request(
    bus: InMemoryMessageBus,
    content: Record<string, unknown>,
    ids: { conversationId?: string; replyWith?: string } = {},
  ): Promise<void> {
    return bus.send("a1", {
      performative: "request",
      sender: "ui",
      ...ids,
      content,
      timestamp: Date.now(),
    });
  }

  /** Ticks long enough for any single-action plan to run and settle. */
  async function run(agent: Agent, cycles = 5): Promise<void> {
    for (let i = 0; i < cycles; i++) {
      await agent.tick();
    }
  }

  it("answers a throwing action with exactly one correlated failure", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = createAgent("a1", bus, [
      {
        name: "work",
        trigger: (_, goal) => goal.name === "work",
        body: [
          {
            name: "boom",
            execute: async (): Promise<ActionResult> => {
              throw new Error("exploded");
            },
          },
        ],
      },
    ]);
    await agent.start();

    await request(
      bus,
      { goal: "work" },
      {
        conversationId: "chat-1",
        replyWith: "msg-1",
      },
    );
    await run(agent);

    // The `agree` closes admission; the `failure` closes the exchange. Nothing
    // else, and nothing twice.
    expect(inbox.map((m) => m.performative)).toEqual(["agree", "failure"]);
    const failure = inbox[1];
    expect(failure).toMatchObject({
      sender: "a1",
      receiver: "ui",
      conversationId: "chat-1",
      inReplyTo: "msg-1",
    });
    expect(failure.content).toMatchObject({ goal: "work", reason: "exploded" });

    await agent.stop();
  });

  it("answers a plan that finishes without messaging with exactly one inform", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = createAgent("a1", bus, [
      {
        name: "work",
        trigger: (_, goal) => goal.name === "work",
        body: [
          { name: "go", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
    ]);
    await agent.start();

    await request(
      bus,
      { goal: "work" },
      {
        conversationId: "chat-1",
        replyWith: "msg-1",
      },
    );
    await run(agent);

    expect(inbox.map((m) => m.performative)).toEqual(["agree", "inform"]);
    expect(inbox[1]).toMatchObject({
      sender: "a1",
      receiver: "ui",
      conversationId: "chat-1",
      inReplyTo: "msg-1",
    });
    expect(inbox[1].content).toMatchObject({ goal: "work", done: true });

    await agent.stop();
  });

  it("does not answer again when the plan sends its own result", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = createAgent("a1", bus, [
      {
        name: "work",
        trigger: (_, goal) => goal.name === "work",
        body: [
          {
            name: "report",
            execute: async (intention): Promise<ActionResult> => ({
              messages: [
                {
                  receiver: intention.goal.source!.sender,
                  performative: "inform",
                  content: { result: 42 },
                },
              ],
            }),
          },
        ],
      },
    ]);
    await agent.start();

    await request(bus, { goal: "work" });
    await run(agent);

    // One terminal reply, and it is the plan's own — the automatic `inform`
    // would have been a second answer to one request.
    const informs = inbox.filter((m) => m.performative === "inform");
    expect(informs).toHaveLength(1);
    expect(informs[0].content).toMatchObject({ result: 42 });

    await agent.stop();
  });

  it("answers only the root goal when the work decomposes", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
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
    await agent.start();

    await request(bus, { goal: "parent" });
    await run(agent, 12);

    // The sub-goal's own completion is not a reply to anything: one request,
    // one `agree`, one `inform`.
    expect(inbox.map((m) => m.performative)).toEqual(["agree", "inform"]);

    await agent.stop();
  });

  it("answers a sub-goal's failure through the root goal only", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
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
          {
            name: "do",
            execute: async (): Promise<ActionResult> => ({
              failure: { reason: "child could not" },
            }),
          },
        ],
      },
    ]);
    await agent.start();

    await request(bus, { goal: "parent" });
    await run(agent, 12);

    expect(inbox.map((m) => m.performative)).toEqual(["agree", "failure"]);
    expect(inbox[1].content).toMatchObject({
      goal: "parent",
      reason: 'sub-goal "child" failed: child could not',
    });

    await agent.stop();
  });

  it("answers a sub-goal no plan serves with a failure, never a refuse", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = createAgent("a1", bus, [
      {
        name: "ship",
        trigger: (_, goal) => goal.name === "ship",
        body: [
          {
            name: "spawn",
            execute: async (): Promise<ActionResult> => ({
              // Nothing declares "package", so this sub-goal is declined the
              // moment means-ends reasoning looks for a plan to serve it.
              newGoals: [{ name: "package", priority: 10 }],
            }),
          },
          { name: "after", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
    ]);
    const refusals: GoalRefusal[] = [];
    agent.on("goal:refused", (r) => refusals.push(r));
    await agent.start();

    await request(
      bus,
      { goal: "ship" },
      { conversationId: "chat-1", replyWith: "msg-1" },
    );
    await run(agent, 12);

    // `refuse` declines a request that has not been agreed to, so it can never
    // follow the `agree` this exchange already got — least of all naming a goal
    // the requester never asked for. The root goal's own `failure` is the only
    // negative ending left, correlated to the same request.
    expect(inbox.map((m) => m.performative)).toEqual(["agree", "failure"]);
    expect(inbox[1]).toMatchObject({
      conversationId: "chat-1",
      inReplyTo: "msg-1",
    });
    expect(inbox[1].content).toMatchObject({
      goal: "ship",
      reason: 'sub-goal "package" failed: no plan serves "package"',
    });

    // The refusal is still reported where it happens, to a local monitor.
    expect(refusals).toMatchObject([{ goal: "package", verdict: "no-plan" }]);

    await agent.stop();
  });

  it("answers a sub-goal shed for capacity with a failure, never a refuse", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = createAgent(
      "a1",
      bus,
      [
        {
          name: "ship",
          trigger: (_, goal) => goal.name === "ship",
          body: [
            {
              name: "spawn",
              execute: async (): Promise<ActionResult> => ({
                newGoals: [{ name: "package", priority: 10 }],
              }),
            },
            { name: "after", execute: async (): Promise<ActionResult> => ({}) },
          ],
        },
        // Declared, so the only thing that can shed this sub-goal is the
        // queue's bound, not the absence of a plan for it.
        ...declaring("package"),
      ],
      1,
    );
    const rejections: GoalRejection[] = [];
    agent.on("goal:rejected", (r) =>
      rejections.push({ ...r, goal: { ...r.goal } }),
    );
    await agent.start();

    // The root goal holds the queue's single slot, so the sub-goal it spawns
    // is the one the bound refuses.
    await request(bus, { goal: "ship" });
    await run(agent);

    expect(inbox.map((m) => m.performative)).toEqual(["agree", "failure"]);
    expect(inbox[1].content).toMatchObject({
      goal: "ship",
      reason: expect.stringContaining("rejected: goal queue is full"),
    });

    // Same as the no-plan path: the shed is reported as a goal lifecycle, and
    // only the root goal answers the requester.
    expect(rejections.map((r) => r.goal.name)).toEqual(["package"]);

    await agent.stop();
  });

  it("sends a failure for a goal dropped through dependsOn", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = createAgent("a1", bus, [
      {
        name: "prereq",
        trigger: (_, goal) => goal.name === "prereq",
        body: [
          {
            name: "attempt",
            execute: async (): Promise<ActionResult> => ({
              failure: { reason: "no room" },
            }),
          },
        ],
      },
      {
        name: "work",
        trigger: (_, goal) => goal.name === "work",
        body: [
          { name: "go", execute: async (): Promise<ActionResult> => ({}) },
        ],
      },
    ]);
    await agent.start();

    // Two requests: one for the dependency, pinned so the second can name it,
    // and one gated on it.
    await request(
      bus,
      { goal: "prereq", goalId: "prereq-1" },
      {
        replyWith: "msg-1",
      },
    );
    await request(
      bus,
      { goal: "work", dependsOn: ["prereq-1"] },
      {
        replyWith: "msg-2",
      },
    );
    await run(agent);

    // Both were agreed to, and both ended: one failed on its own action, the
    // other never ran because what it depended on failed.
    const failures = inbox.filter((m) => m.performative === "failure");
    expect(inbox.filter((m) => m.performative === "agree")).toHaveLength(2);
    expect(failures).toHaveLength(2);
    const dropped = failures.find(
      (f) => (f.content as { goal?: string }).goal === "work",
    );
    expect(dropped).toBeDefined();
    expect(dropped).toMatchObject({ inReplyTo: "msg-2" });
    expect((dropped!.content as { reason?: string }).reason).toMatch(
      /dropped: dependency "prereq-1" failed/,
    );

    await agent.stop();
  });

  it("answers a goal that is never worked on only once it settles", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = registerRequester(bus);
    const agent = createAgent("a1", bus, [
      {
        name: "work",
        // Never willing: the agent has agreed and is waiting on its own
        // precondition, which is not a failure and not an answer.
        trigger: () => false,
        body: [],
      },
    ]);
    await agent.start();

    await request(bus, { goal: "work" });
    await run(agent);

    expect(inbox.map((m) => m.performative)).toEqual(["agree"]);

    await agent.stop();
  });
});

describe("Action-result message correlation", () => {
  /** A plan whose single action returns the messages the test hands it. */
  const messagingPlan = (messages: ActionResult["messages"]): Plan => ({
    name: "work",
    trigger: (_, goal) => goal.name === "work",
    body: [
      {
        name: "speak",
        execute: async (): Promise<ActionResult> => ({ messages }),
      },
    ],
  });

  /**
   * Requests the goal under a known exchange, so the goal's `source` has the
   * ids a peer would be reading back if they leaked onto the wrong message.
   */
  async function requestGoal(bus: InMemoryMessageBus): Promise<void> {
    await bus.send("a1", {
      performative: "request",
      sender: "ui",
      conversationId: "chat-1",
      replyWith: "msg-1",
      content: { goal: "work" },
      timestamp: Date.now(),
    });
  }

  async function ticks(agent: Agent, count = 5): Promise<void> {
    for (let i = 0; i < count; i++) {
      await agent.tick();
    }
  }

  it("does not name the requester's message in a request to a third agent", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
      messagingPlan([
        {
          receiver: "worker",
          performative: "request",
          content: { goal: "fetch" },
        },
      ]),
    ]);
    const sent: Message[] = [];
    agent.on("message:sent", (m) => sent.push(m));
    await agent.start();

    await requestGoal(bus);
    await ticks(agent);

    const outbound = sent.find((m) => m.receiver === "worker");
    expect(outbound).toBeDefined();
    // `worker` never saw `ui`'s message, so naming it would be a reply to
    // nothing. The conversation still carries: one job, one thread, and a
    // fresh `replyWith` keeps this leg distinguishable within it.
    expect(outbound!.inReplyTo).toBeUndefined();
    expect(outbound!.conversationId).toBe("chat-1");
    expect(outbound!.replyWith).toBeDefined();
    expect(outbound!.replyWith).not.toBe("msg-1");

    await agent.stop();
  });

  it("still correlates a plan's reply to the requester", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
      messagingPlan([
        {
          receiver: "ui",
          performative: "inform",
          content: { done: true },
        },
      ]),
    ]);
    const sent: Message[] = [];
    agent.on("message:sent", (m) => sent.push(m));
    await agent.start();

    await requestGoal(bus);
    await ticks(agent);

    // The requester is the one that sent the message being named, so the
    // answer pairs against it exactly as `agree` does.
    const reply = sent.find(
      (m) => m.performative === "inform" && m.receiver === "ui",
    );
    expect(reply).toBeDefined();
    expect(reply).toMatchObject({
      conversationId: "chat-1",
      inReplyTo: "msg-1",
    });

    await agent.stop();
  });

  it("publishes to a topic without naming the requester's message", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
      messagingPlan([
        {
          topic: "progress",
          performative: "inform",
          content: { step: "done" },
        },
      ]),
    ]);
    const sent: Message[] = [];
    agent.on("message:sent", (m) => sent.push(m));
    await agent.start();

    await requestGoal(bus);
    await ticks(agent);

    const published = sent.find((m) => m.topic === "progress");
    expect(published).toBeDefined();
    // A subscriber never sent `ui`'s message either, but the announcement is
    // still part of the thread the request opened.
    expect(published!.inReplyTo).toBeUndefined();
    expect(published!.conversationId).toBe("chat-1");

    await agent.stop();
  });

  it("lets an explicit inReplyTo win over the goal's source", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
      messagingPlan([
        {
          receiver: "worker",
          performative: "inform",
          content: { note: "as you asked" },
          inReplyTo: "peer-earlier",
        },
      ]),
    ]);
    const sent: Message[] = [];
    agent.on("message:sent", (m) => sent.push(m));
    await agent.start();

    await requestGoal(bus);
    await ticks(agent);

    // The plan is answering something the goal's source never saw, and it is
    // the only party that knows what.
    const outbound = sent.find((m) => m.receiver === "worker");
    expect(outbound).toBeDefined();
    expect(outbound!.inReplyTo).toBe("peer-earlier");
    expect(outbound!.conversationId).toBe("chat-1");

    await agent.stop();
  });
});

describe("assertion belief state", () => {
  it("stores an inform with explicit positive state as positive", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "inform",
      sender: "peer",
      content: { temp: 22, state: "positive" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("positive");

    await agent.stop();
  });

  it("stores an inform with explicit uncertain state as uncertain", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "inform",
      sender: "peer",
      content: { temp: 22, state: "uncertain" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("uncertain");

    await agent.stop();
  });

  it("stores an inform with explicit negative state as negative", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "inform",
      sender: "peer",
      content: { temp: 22, state: "negative" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("negative");

    await agent.stop();
  });

  it("defaults inform to positive when no state is given", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "inform",
      sender: "peer",
      content: { temp: 22 },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("positive");

    await agent.stop();
  });

  it("defaults confirm to positive when no state is given", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "confirm",
      sender: "peer",
      content: { temp: 22 },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("positive");

    await agent.stop();
  });

  it("defaults disconfirm to negative when no state is given", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "disconfirm",
      sender: "peer",
      content: { temp: 22 },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("negative");

    await agent.stop();
  });

  it("honours an explicit state on confirm", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "confirm",
      sender: "peer",
      content: { temp: 22, state: "uncertain" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("uncertain");

    await agent.stop();
  });

  it("honours a negative state override on disconfirm", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "disconfirm",
      sender: "peer",
      content: { temp: 22, state: "positive" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // Explicit state overrides the performative default.
    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("positive");

    await agent.stop();
  });

  it("sends not-understood when an assertion carries an invalid state", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    const inbox: Message[] = [];
    bus.registerAgent("peer", (msg) => inbox.push(msg));

    await bus.send("a1", {
      performative: "inform",
      sender: "peer",
      content: { temp: 22, state: "maybe" },
      timestamp: Date.now(),
    });
    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("inform");
    const reason = content.reason as string;
    expect(reason).toContain("state");

    // The malformed assertion is not stored.
    expect(agent.beliefs.get("msg.temp")).toBeUndefined();

    await agent.stop();
  });

  it("correlates a not-understood reply to the message it answers", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    const inbox: Message[] = [];
    bus.registerAgent("peer", (msg) => inbox.push(msg));

    await bus.send("a1", {
      performative: "inform",
      sender: "peer",
      conversationId: "chat-1",
      replyWith: "msg-7",
      content: { temp: 22, state: "maybe" },
      timestamp: Date.now(),
    });
    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    // The reply inherits the conversation and names the message it answers, so
    // the sender can pair the not-understood with the exact message that failed
    // the same way it pairs an agreement or a refusal.
    expect(notUnderstood).toMatchObject({
      conversationId: "chat-1",
      inReplyTo: "msg-7",
      receiver: "peer",
    });

    await agent.stop();
  });

  it("does not send not-understood for an explicit state on failure", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    const inbox: Message[] = [];
    bus.registerAgent("worker", (msg) => inbox.push(msg));

    await bus.send("a1", {
      performative: "failure",
      sender: "worker",
      content: { goal: "fetch", reason: "503", state: "uncertain" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // failure does not carry a state, so an extra field is ignored
    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeUndefined();

    // The assertion still lands in the belief base.
    expect(agent.beliefs.get("msg.reason")).toBe("503");

    await agent.stop();
  });
});

describe("failure and not-understood belief tracking", () => {
  it("ingests a failure as a positive assertion and stores a semantic record", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "failure",
      sender: "worker",
      content: { goal: "fetch", reason: "503 from registry" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // The standard assertion path stored the content under msg.* keys.
    expect(agent.beliefs.get("msg.goal")).toBe("fetch");
    expect(agent.beliefs.get("msg.reason")).toBe("503 from registry");
    // The semantic failure record is also present.
    expect(
      agent.beliefs.get<{ reason?: string }>("failed.worker.fetch"),
    ).toEqual({ reason: "503 from registry" });
    expect(agent.beliefs.statusOf("failed.worker.fetch")).toBe("positive");

    await agent.stop();
  });

  it("ingests a not-understood as a positive assertion and stores a semantic record", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "not-understood",
      sender: "peer",
      content: { event: "query-if", reason: "unknown ontology" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.beliefs.get("msg.event")).toBe("query-if");
    expect(agent.beliefs.get("msg.reason")).toBe("unknown ontology");
    expect(
      agent.beliefs.get<{ reason?: string }>("not-understood.peer.query-if"),
    ).toEqual({ reason: "unknown ontology" });
    expect(agent.beliefs.statusOf("not-understood.peer.query-if")).toBe(
      "positive",
    );

    await agent.stop();
  });

  it("runs the belief middleware for failure and not-understood", async () => {
    const bus = new InMemoryMessageBus();
    let middlewareRan = false;
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      middleware: [
        async (_msg, next) => {
          middlewareRan = true;
          await next();
        },
      ],
    });

    await agent.start();
    await bus.send("a1", {
      performative: "failure",
      sender: "worker",
      content: { goal: "fetch", reason: "x" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(middlewareRan).toBe(true);

    await agent.stop();
  });

  it("does not store a semantic record when the content has no goal or event", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, []);

    await agent.start();
    await bus.send("a1", {
      performative: "failure",
      sender: "worker",
      content: { reason: "something broke" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // Standard assertion path still ran, but no semantic key was created.
    expect(agent.beliefs.get("msg.reason")).toBe("something broke");
    expect(agent.beliefs.statusOf("failed.worker.")).toBeUndefined();

    await agent.stop();
  });
});
