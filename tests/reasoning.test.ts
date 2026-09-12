import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning.js";
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
  return new Agent({ id, bus, planLibrary: lib, tickIntervalMs: 10 });
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
      tickIntervalMs: 10,
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
    agent.subscribe("weather");
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
    const unsub = agent.subscribe("events");
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
    agent.subscribe("telemetry");
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

    agent.subscribe("reqs");
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
});
