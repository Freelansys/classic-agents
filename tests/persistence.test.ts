import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import { DesireLibrary } from "../src/core/desires.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";
import { AGENT_STATE_PREFIX, InMemoryBeliefBase } from "../src/core/beliefs.js";
import type { BeliefBase } from "../src/core/beliefs.js";

/** An agent over `store`, as a restarted process would build it again. */
function agent(store: BeliefBase, plans: Plan[]): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  const a = new Agent({
    id: "a",
    bus: new InMemoryMessageBus(),
    planLibrary: library,
    beliefs: store,
  });
  a.propositionLibrary.register({
    name: "ready",
    evaluate: (beliefs) => beliefs.get("ready") === true,
  });
  return a;
}

function plan(goal: string, ran: string[], extra: Partial<Plan> = {}): Plan {
  return {
    goal,
    body: [
      {
        name: goal,
        execute: async (): Promise<ActionResult> => {
          ran.push(goal);
          return {};
        },
      },
    ],
    ...extra,
  };
}

async function ticks(a: Agent, n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await a.tick();
}

function agentKeys(store: BeliefBase): string[] {
  return store.queryByPrefix(AGENT_STATE_PREFIX).map((r) => r.key);
}

describe("Goals kept in the belief base", () => {
  it("brings a goal waiting on a condition back after a restart", async () => {
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = agent(store, [plan("go", ran)]);
    await first.start();
    first.goals.add({
      id: "g",
      name: "go",
      priority: 5,
      status: "pending",
      data: { n: 1 },
      when: "ready",
    });
    await ticks(first);
    first.stop();
    expect(ran).toEqual([]);

    const second = agent(store, [plan("go", ran)]);
    await second.start();
    expect(second.goals.get("g")).toMatchObject({
      status: "pending",
      data: { n: 1 },
      when: "ready",
    });
    second.beliefs.set("ready", true);
    await ticks(second);
    expect(ran).toEqual(["go"]);
    expect(agentKeys(store)).toEqual([]);
    second.stop();
  });

  it("works a goal that was active again from its first action", async () => {
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const waiting: Plan = {
      goal: "job",
      body: [
        {
          name: "wait",
          execute: async (): Promise<ActionResult> => ({
            delegations: [{ goal: "step", when: "ready", timeoutMs: null }],
          }),
        },
      ],
    };
    const first = agent(store, [waiting, plan("step", ran)]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(first, 2);
    expect(first.goals.get("j")?.status).toBe("active");
    first.stop();

    const second = agent(store, [plan("job", ran)]);
    await second.start();
    expect(second.goals.get("j")?.status).toBe("pending");
    await ticks(second);
    expect(ran).toEqual(["job"]);
    second.stop();
  });

  it("keeps a dependency met before the restart met after it", async () => {
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = agent(store, [plan("form", ran), plan("task", ran)]);
    await first.start();
    first.goals.add({
      id: "t",
      name: "task",
      priority: 5,
      status: "pending",
      dependsOn: ["f"],
      when: "ready",
    });
    first.goals.add({ id: "f", name: "form", priority: 5, status: "pending" });
    await ticks(first);
    expect(ran).toEqual(["form"]);
    expect(agentKeys(store)).toContain(`${AGENT_STATE_PREFIX}achieved.f`);
    first.stop();

    const second = agent(store, [plan("form", ran), plan("task", ran)]);
    await second.start();
    second.beliefs.set("ready", true);
    await ticks(second);
    expect(ran).toEqual(["form", "task"]);
    expect(agentKeys(store)).toEqual([]);
    second.stop();
  });

  it("does not keep sub-goals, which the restored plan makes again", async () => {
    const store = new InMemoryBeliefBase();
    const parent: Plan = {
      goal: "parent",
      body: [
        {
          name: "delegate",
          execute: async (): Promise<ActionResult> => ({
            delegations: [{ goal: "child", when: "ready", timeoutMs: null }],
          }),
        },
      ],
    };
    const a = agent(store, [parent, plan("child", [])]);
    await a.start();
    a.goals.add({ id: "p", name: "parent", priority: 5, status: "pending" });
    await ticks(a);
    expect(
      a.goals
        .all()
        .map((g) => g.name)
        .sort(),
    ).toEqual(["child", "parent"]);
    expect(agentKeys(store)).toEqual([`${AGENT_STATE_PREFIX}goal.p`]);
    a.stop();
  });

  it("hides its records from what plans and peers see", async () => {
    const store = new InMemoryBeliefBase();
    const a = agent(store, []);
    await a.start();
    a.goals.add({
      id: "g",
      name: "go",
      priority: 5,
      status: "pending",
      when: "ready",
    });
    expect(store.has(`${AGENT_STATE_PREFIX}goal.g`)).toBe(true);
    expect(a.beliefs.all()).toEqual({});
    a.stop();
  });
});

describe("Conversations kept in the belief base", () => {
  /** An agent `a1` on `bus` over `store`, with a `temp` expression and a `hot` proposition. */
  function server(
    bus: InMemoryMessageBus,
    store: BeliefBase,
    plans: Plan[] = [],
  ) {
    const library = new PlanLibrary();
    for (const plan of plans) library.register(plan);
    const a = new Agent({
      id: "a1",
      bus,
      planLibrary: library,
      beliefs: store,
    });
    a.expressionLibrary.register({
      name: "temp",
      evaluate: (beliefs) => beliefs.get("temp"),
    });
    a.propositionLibrary.register({
      name: "hot",
      evaluate: (beliefs) => (beliefs.get<number>("temp") ?? 0) > 30,
    });
    return a;
  }

  function inbox(bus: InMemoryMessageBus, id: string): Message[] {
    const received: Message[] = [];
    bus.registerAgent(id, (m) => received.push(m));
    return received;
  }

  it("keeps a subscription, and reports only a value that changed", async () => {
    const bus = new InMemoryMessageBus();
    const ui = inbox(bus, "ui");
    const store = new InMemoryBeliefBase();
    store.set("temp", 20);
    const first = server(bus, store);
    await first.start();
    await bus.send("a1", {
      performative: "subscribe",
      sender: "ui",
      content: { name: "temp" },
      timestamp: Date.now(),
    });
    await ticks(first, 3);
    await first.stop();
    expect(ui.map((m) => m.content)).toEqual([
      expect.anything(),
      { name: "temp", result: 20 },
    ]);

    const second = server(bus, store);
    await second.start();
    await ticks(second, 3);
    expect(ui).toHaveLength(2);
    second.beliefs.set("temp", 21);
    await ticks(second, 3);
    expect(ui.map((m) => m.content).slice(2)).toEqual([
      { name: "temp", result: 21 },
    ]);
    await second.stop();
  });

  it("keeps a request-whenever, which does not fire again for a condition that held", async () => {
    const bus = new InMemoryMessageBus();
    inbox(bus, "ui");
    const store = new InMemoryBeliefBase();
    store.set("temp", 35);
    const ran: string[] = [];
    const first = server(bus, store, [plan("cool", ran)]);
    await first.start();
    await bus.send("a1", {
      performative: "request-whenever",
      sender: "ui",
      content: { goal: "cool", when: "hot" },
      timestamp: Date.now(),
    });
    await ticks(first, 5);
    await first.stop();
    expect(ran).toEqual(["cool"]);

    const second = server(bus, store, [plan("cool", ran)]);
    await second.start();
    await ticks(second, 5);
    expect(ran).toEqual(["cool"]);
    second.beliefs.set("temp", 20);
    await ticks(second, 3);
    second.beliefs.set("temp", 40);
    await ticks(second, 5);
    expect(ran).toEqual(["cool", "cool"]);
    await second.stop();
  });

  it("answers an agreed request whose goal was lost with failure", async () => {
    const bus = new InMemoryMessageBus();
    const ui = inbox(bus, "ui");
    const store = new InMemoryBeliefBase();
    const first = server(bus, store, [plan("job", [])]);
    first.propositionLibrary.register({ name: "never", evaluate: () => false });
    await first.start();
    await bus.send("a1", {
      performative: "request-when",
      sender: "ui",
      content: { goal: "job", when: "never" },
      timestamp: Date.now(),
    });
    await ticks(first, 3);
    await first.stop();
    expect(ui.map((m) => m.performative)).toEqual(["agree"]);

    // Lost by the store, say: the agreement is still owed an answer.
    for (const { key } of store.queryByPrefix(`${AGENT_STATE_PREFIX}goal.`)) {
      store.remove(key);
    }
    const second = server(bus, store, [plan("job", [])]);
    await second.start();
    await ticks(second, 2);
    expect(ui.map((m) => m.performative)).toEqual(["agree", "failure"]);
    expect(ui[1].content).toMatchObject({
      reason: "agent restarted before it finished",
    });
    await second.stop();
  });

  it("cancels a delegation its restart ended, and delegates afresh", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    const store = new InMemoryBeliefBase();
    const delegating: Plan = {
      goal: "job",
      body: [
        {
          name: "ask",
          execute: async (): Promise<ActionResult> => ({
            delegations: [{ receiver: "peer", goal: "step", timeoutMs: null }],
          }),
        },
      ],
    };
    const first = server(bus, store, [delegating]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(first, 3);
    await first.stop();
    expect(peer.map((m) => m.performative)).toEqual(["request"]);
    const exchange = peer[0].replyWith;

    const second = server(bus, store, [delegating]);
    await second.start();
    expect(peer[1]).toMatchObject({
      performative: "cancel",
      inReplyTo: exchange,
    });
    await ticks(second, 3);
    expect(peer.map((m) => m.performative)).toEqual([
      "request",
      "cancel",
      "request",
    ]);
    expect(peer[2].replyWith).not.toBe(exchange);
    await second.stop();
  });

  it("answers an agreed request restored with its goal once it is done", async () => {
    const bus = new InMemoryMessageBus();
    const ui = inbox(bus, "ui");
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = server(bus, store, [plan("cool", ran)]);
    await first.start();
    await bus.send("a1", {
      performative: "request-when",
      sender: "ui",
      content: { goal: "cool", when: "hot" },
      timestamp: Date.now(),
    });
    await ticks(first, 3);
    await first.stop();
    expect(ui.map((m) => m.performative)).toEqual(["agree"]);

    const second = server(bus, store, [plan("cool", ran)]);
    await second.start();
    second.beliefs.set("temp", 35);
    await ticks(second, 5);
    expect(ran).toEqual(["cool"]);
    expect(ui.map((m) => m.performative)).toEqual(["agree", "inform"]);
    expect(store.queryByPrefix(AGENT_STATE_PREFIX)).toEqual([]);
    await second.stop();
  });
});

describe("KeptMap", () => {
  it("writes nothing while an agent with standing commitments is idle", async () => {
    const bus = new InMemoryMessageBus();
    bus.registerAgent("ui", () => {});
    const store = new InMemoryBeliefBase();
    store.set("temp", 20);
    const library = new PlanLibrary();
    library.register(plan("cool", []));
    const a = new Agent({
      id: "a1",
      bus,
      planLibrary: library,
      beliefs: store,
    });
    a.expressionLibrary.register({
      name: "temp",
      evaluate: (beliefs) => beliefs.get("temp"),
    });
    a.propositionLibrary.register({ name: "never", evaluate: () => false });
    await a.start();
    for (const [performative, content] of [
      ["subscribe", { name: "temp" }],
      ["request-whenever", { goal: "cool", when: "never" }],
    ] as const) {
      await bus.send("a1", {
        performative,
        sender: "ui",
        content,
        timestamp: Date.now(),
      });
    }
    await ticks(a, 3);

    const writes: string[] = [];
    store.on("beliefAdded", ({ key }) => writes.push(key));
    store.on("beliefUpdated", ({ key }) => writes.push(key));
    await ticks(a, 10);
    expect(writes).toEqual([]);
    await a.stop();
  });

  it("refuses an entry changed in place", async () => {
    const a = agent(new InMemoryBeliefBase(), []);
    a.sentRequests.set("x", {
      peer: "p",
      goal: "g",
      performative: "request",
      exchange: "x",
    });
    const entry = a.sentRequests.get("x") as { peer: string };
    expect(() => {
      entry.peer = "q";
    }).toThrow(TypeError);
  });
});

describe("Desires kept in the belief base", () => {
  function withDesire(store: BeliefBase, ran: string[]): Agent {
    const desires = new DesireLibrary();
    desires.register({
      name: "cool",
      intend: (beliefs) =>
        beliefs.get("hot") === true
          ? { goal: "cool", when: "ready" }
          : undefined,
    });
    const library = new PlanLibrary();
    library.register(plan("cool", ran));
    const a = new Agent({
      id: "a",
      bus: new InMemoryMessageBus(),
      planLibrary: library,
      beliefs: store,
      desires,
    });
    a.propositionLibrary.register({
      name: "ready",
      evaluate: (beliefs) => beliefs.get("ready") === true,
    });
    return a;
  }

  it("does not fire again for a goal it already has in the queue", async () => {
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = withDesire(store, ran);
    await first.start();
    first.beliefs.set("hot", true);
    await ticks(first);
    expect(first.goals.getUnfinished()).toHaveLength(1);
    first.stop();

    const second = withDesire(store, ran);
    await second.start();
    await ticks(second);
    expect(second.goals.getUnfinished()).toHaveLength(1);
    second.beliefs.set("ready", true);
    await ticks(second);
    expect(ran).toEqual(["cool"]);
    second.stop();
  });

  it("does not fire again for an edge it already acted on", async () => {
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    store.set("ready", true);
    const first = withDesire(store, ran);
    await first.start();
    first.beliefs.set("hot", true);
    await ticks(first);
    expect(ran).toEqual(["cool"]);
    first.stop();

    const second = withDesire(store, ran);
    await second.start();
    await ticks(second);
    expect(ran).toEqual(["cool"]);
    second.beliefs.set("hot", false);
    await ticks(second);
    second.beliefs.set("hot", true);
    await ticks(second);
    expect(ran).toEqual(["cool", "cool"]);
    second.stop();
  });

  it("writes nothing while it goes on asking", async () => {
    const store = new InMemoryBeliefBase();
    const a = withDesire(store, []);
    await a.start();
    a.beliefs.set("hot", true);
    await ticks(a, 2);
    const writes: string[] = [];
    for (const event of [
      "beliefAdded",
      "beliefUpdated",
      "beliefRemoved",
    ] as const) {
      store.on(event, (e) => writes.push(e.key));
    }
    await ticks(a, 10);
    expect(writes).toEqual([]);
    a.stop();
  });

  it("forgets what a desire no longer registered kept", async () => {
    const store = new InMemoryBeliefBase();
    const first = withDesire(store, []);
    await first.start();
    first.beliefs.set("hot", true);
    await ticks(first);
    first.stop();
    expect(agentKeys(store).some((k) => k.startsWith("~agent.desire."))).toBe(
      true,
    );

    const second = agent(store, []);
    await second.start();
    expect(agentKeys(store).some((k) => k.startsWith("~agent.desire."))).toBe(
      false,
    );
    second.stop();
  });

  it("keeps a desire's records apart from one whose name it starts", async () => {
    const store = new InMemoryBeliefBase();
    const desires = new DesireLibrary();
    desires.register({ name: "a", intend: () => ({ goal: "x" }) });
    desires.register({ name: "a.b", intend: () => ({ goal: "x" }) });
    const library = new PlanLibrary();
    library.register(plan("x", []));
    const a = new Agent({
      id: "a",
      bus: new InMemoryMessageBus(),
      planLibrary: library,
      beliefs: store,
      desires,
    });
    await a.start();
    await ticks(a);
    a.stop();
    const keys = agentKeys(store).filter((k) => k.startsWith("~agent.desire."));
    expect(keys).toHaveLength(2);
    expect(keys.filter((k) => k.startsWith("~agent.desire.a."))).toHaveLength(
      1,
    );
  });
});
