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

/**
 * The agent keys that record work, leaving out each exchange's protocol,
 * which is remembered after the exchange is over.
 */
function workKeys(store: BeliefBase): string[] {
  return agentKeys(store).filter((k) => !k.startsWith("~agent.conv.protocol."));
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

  /**
   * A plan that delegates `child` to itself, to run once `ready` holds, and
   * then finishes. `delegate` names its first action.
   */
  function parent(ran: string[], delegate = "delegate"): Plan {
    return {
      goal: "parent",
      body: [
        {
          name: delegate,
          execute: async (): Promise<ActionResult> => {
            ran.push(delegate);
            return {
              delegations: [{ goal: "child", when: "ready", timeoutMs: null }],
            };
          },
        },
        {
          name: "finish",
          execute: async (): Promise<ActionResult> => {
            ran.push("finish");
            return {};
          },
        },
      ],
    };
  }

  it("keeps a sub-goal with the intention waiting for it", async () => {
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = agent(store, [parent(ran), plan("child", ran)]);
    await first.start();
    first.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });
    await ticks(first);
    first.stop();
    const child = first.goals.all().find((g) => g.name === "child")!;
    expect(agentKeys(store)).toEqual(
      expect.arrayContaining([
        `${AGENT_STATE_PREFIX}goal.p`,
        `${AGENT_STATE_PREFIX}goal.${child.id}`,
      ]),
    );

    const second = agent(store, [parent(ran), plan("child", ran)]);
    await second.start();
    expect(second.goals.get(child.id)?.parentGoalId).toBe("p");
    second.beliefs.set("ready", true);
    await ticks(second);
    expect(ran).toEqual(["delegate", "child", "finish"]);
    expect(agentKeys(store)).toEqual([]);
    second.stop();
  });

  it("drops the sub-goals of a plan that changed, which it makes again", async () => {
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = agent(store, [parent(ran), plan("child", ran)]);
    await first.start();
    first.goals.add({
      id: "p",
      name: "parent",
      priority: 5,
      status: "pending",
    });
    await ticks(first);
    first.stop();
    const child = first.goals.all().find((g) => g.name === "child")!;

    const second = agent(store, [
      parent(ran, "delegate-v2"),
      plan("child", ran),
    ]);
    await second.start();
    expect(second.goals.get(child.id)).toBeUndefined();
    expect(second.goals.get("p")?.status).toBe("pending");
    second.beliefs.set("ready", true);
    await ticks(second);
    expect(ran).toEqual(["delegate", "delegate-v2", "child", "finish"]);
    expect(agentKeys(store)).toEqual([]);
    second.stop();
  });

  it("runs again only the action a restart interrupted", async () => {
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    let started!: () => void;
    const inTwo = new Promise<void>((resolve) => (started = resolve));
    /** `two` never finishes on the first agent: the process dies in it. */
    const steps = (dies: boolean): Plan => ({
      goal: "job",
      body: [
        {
          name: "one",
          execute: async (): Promise<ActionResult> => {
            ran.push("one");
            return { beliefUpdates: [{ key: "done", value: 1 }] };
          },
        },
        {
          name: "two",
          execute: async (): Promise<ActionResult> => {
            ran.push("two");
            started();
            if (dies) await new Promise(() => {});
            return {};
          },
        },
        {
          name: "three",
          execute: async (): Promise<ActionResult> => {
            ran.push("three");
            return {};
          },
        },
      ],
    });
    const first = agent(store, [steps(true)]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    void ticks(first);
    await inTwo;
    expect(ran).toEqual(["one", "two"]);

    const second = agent(store, [steps(false)]);
    await second.start();
    expect(second.goals.get("j")?.status).toBe("active");
    await ticks(second);
    expect(ran).toEqual(["one", "two", "two", "three"]);
    expect(second.beliefs.get("done")).toBe(1);
    expect(agentKeys(store)).toEqual([]);
    second.stop();
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

  /**
   * A plan that delegates `step` to `peer` and then reads its result. `ask`
   * names its first action, so a plan that changed can be made.
   */
  function delegating(ran: string[], ask = "ask"): Plan {
    return {
      goal: "job",
      body: [
        {
          name: ask,
          execute: async (): Promise<ActionResult> => {
            ran.push(ask);
            return {
              delegations: [
                { receiver: "peer", goal: "step", timeoutMs: null },
              ],
            };
          },
        },
        {
          name: "use",
          execute: async (intention): Promise<ActionResult> => {
            ran.push(`use:${String(intention.delegations[0].result)}`);
            return {};
          },
        },
      ],
    };
  }

  it("goes on waiting for a delegation after a restart", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = server(bus, store, [delegating(ran)]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(first, 3);
    await first.stop();
    expect(peer.map((m) => m.performative)).toEqual(["request"]);

    const second = server(bus, store, [delegating(ran)]);
    await second.start();
    await bus.send("a1", {
      performative: "inform",
      sender: "peer",
      content: { goal: "step", done: true, result: 42 },
      inReplyTo: peer[0].replyWith,
      timestamp: Date.now(),
    });
    await ticks(second, 3);
    expect(ran).toEqual(["ask", "use:42"]);
    expect(peer.map((m) => m.performative)).toEqual(["request"]);
    expect(workKeys(store)).toEqual([]);
    await second.stop();
  });

  it("cancels a delegation of a plan that changed, and delegates afresh", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = server(bus, store, [delegating(ran)]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(first, 3);
    await first.stop();
    const exchange = peer[0].replyWith;

    const second = server(bus, store, [delegating(ran, "ask-v2")]);
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
    expect(ran).toEqual(["ask", "ask-v2"]);
    await second.stop();
  });

  /** A plan that proposes `step` to `peer` and then reads the decision. */
  function proposing(ran: string[], offer = "offer"): Plan {
    return {
      goal: "job",
      body: [
        {
          name: offer,
          execute: async (): Promise<ActionResult> => {
            ran.push(offer);
            return {
              proposals: [
                { receiver: "peer", goal: "step", terms: 1, timeoutMs: null },
              ],
            };
          },
        },
        {
          name: "read",
          execute: async (intention): Promise<ActionResult> => {
            ran.push(`read:${intention.proposals[0].status}`);
            return {};
          },
        },
      ],
    };
  }

  it("goes on waiting for a proposal's decision after a restart", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = server(bus, store, [proposing(ran)]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(first, 3);
    await first.stop();

    const second = server(bus, store, [proposing(ran)]);
    await second.start();
    await bus.send("a1", {
      performative: "accept-proposal",
      sender: "peer",
      content: { goal: "step" },
      inReplyTo: peer[0].replyWith,
      timestamp: Date.now(),
    });
    await ticks(second, 3);
    expect(ran).toEqual(["offer", "read:accepted"]);
    expect(peer.map((m) => m.performative)).toEqual(["propose"]);
    expect(workKeys(store)).toEqual([]);
    await second.stop();
  });

  it("withdraws a proposal of a plan that changed, and proposes afresh", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    const store = new InMemoryBeliefBase();
    const ran: string[] = [];
    const first = server(bus, store, [proposing(ran)]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(first, 3);
    await first.stop();
    expect(peer.map((m) => m.performative)).toEqual(["propose"]);
    const offer = peer[0].replyWith;

    const second = server(bus, store, [proposing(ran, "offer-v2")]);
    await second.start();
    expect(peer[1]).toMatchObject({ performative: "cancel", inReplyTo: offer });
    await bus.send("a1", {
      performative: "inform",
      sender: "peer",
      content: { goal: "step" },
      inReplyTo: peer[1].replyWith,
      timestamp: Date.now(),
    });
    await ticks(second, 3);
    expect(peer.map((m) => m.performative)).toEqual([
      "propose",
      "cancel",
      "propose",
    ]);
    expect(
      agentKeys(store).filter((k) => k.startsWith("~agent.conv.cancel.")),
    ).toEqual([]);
    await second.stop();
  });

  /** A plan that calls for bids from `receivers` and awards the first one. */
  function calling(receivers = ["peer"], call = "call"): Plan {
    return {
      goal: "job",
      body: [
        {
          name: call,
          execute: async (): Promise<ActionResult> => ({
            calls: [{ goal: "step", receivers, deadlineMs: 60_000 }],
          }),
        },
        {
          name: "award",
          execute: async (intention): Promise<ActionResult> => ({
            awards: intention.calls[0].proposals
              .slice(0, 1)
              .map((p) => ({ proposal: p.id, timeoutMs: null })),
          }),
        },
      ],
    };
  }

  async function bid(bus: InMemoryMessageBus, cfp: Message, id: string) {
    await bus.send("a1", {
      performative: "propose",
      sender: "peer",
      content: { goal: "step", terms: 1 },
      inReplyTo: cfp.replyWith,
      replyWith: id,
      timestamp: Date.now(),
    });
  }

  it("goes on with an open call after a restart, its bids kept", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    const other = inbox(bus, "other");
    const store = new InMemoryBeliefBase();
    const first = server(bus, store, [calling(["peer", "other"])]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(first, 2);
    await bid(bus, peer[0], "bid-1");
    await ticks(first, 2);
    await first.stop();

    const second = server(bus, store, [calling(["peer", "other"])]);
    await second.start();
    // The last invitee answers, which closes the call; its bids are awarded.
    await bus.send("a1", {
      performative: "refuse",
      sender: "other",
      content: { goal: "step" },
      inReplyTo: other[0].replyWith,
      timestamp: Date.now(),
    });
    await ticks(second, 3);
    expect(peer.map((m) => m.performative)).toEqual(["cfp", "accept-proposal"]);
    expect(peer[1].inReplyTo).toBe("bid-1");
    await second.stop();
  });

  it("rejects a bid on a call of a plan that changed, and calls afresh", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    const store = new InMemoryBeliefBase();
    // `other` never answers, so the call is still open when the agent stops.
    inbox(bus, "other");
    const first = server(bus, store, [calling(["peer", "other"])]);
    await first.start();
    first.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(first, 2);
    expect(peer.map((m) => m.performative)).toEqual(["cfp"]);
    await bid(bus, peer[0], "bid-1");
    await ticks(first, 2);
    await first.stop();

    const second = server(bus, store, [calling(["peer", "other"], "call-v2")]);
    await second.start();
    expect(peer[1]).toMatchObject({
      performative: "reject-proposal",
      inReplyTo: "bid-1",
      content: { goal: "step", reason: "agent restarted" },
    });
    await ticks(second, 3);
    expect(peer.map((m) => m.performative)).toEqual([
      "cfp",
      "reject-proposal",
      "cfp",
    ]);
    await second.stop();
  });

  it("writes only the bid's record as a bid comes in", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    inbox(bus, "other");
    const store = new InMemoryBeliefBase();
    const a = server(bus, store, [calling(["peer", "other"])]);
    await a.start();
    a.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(a, 2);
    const written: string[] = [];
    for (const event of ["beliefAdded", "beliefUpdated"] as const) {
      store.on(event, ({ key }) => {
        if (key.startsWith(`${AGENT_STATE_PREFIX}intention.`)) {
          written.push(key);
        }
      });
    }
    await bid(bus, peer[0], "bid-1");
    await ticks(a, 1);
    expect(written).toEqual([
      expect.stringMatching(/^~agent\.intention\.[^.]+\.calls\.0\.bids\.0$/),
    ]);
    await a.stop();
  });

  it("refuses an intention changed in place", async () => {
    const bus = new InMemoryMessageBus();
    inbox(bus, "peer");
    const store = new InMemoryBeliefBase();
    const a = server(bus, store, [delegating([])]);
    await a.start();
    a.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(a, 3);
    const [intention] = a.intentions.getAll();
    const delegation = intention.delegations[0] as { status: string };
    expect(() => {
      delegation.status = "done";
    }).toThrow(TypeError);
    expect(() => {
      (intention.delegations as unknown[]).push({});
    }).toThrow(TypeError);
    await a.stop();
  });

  it("holds no bid once its call is awarded", async () => {
    const bus = new InMemoryMessageBus();
    const peer = inbox(bus, "peer");
    const store = new InMemoryBeliefBase();
    const a = server(bus, store, [calling()]);
    await a.start();
    a.goals.add({ id: "j", name: "job", priority: 5, status: "pending" });
    await ticks(a, 2);
    await bid(bus, peer[0], "bid-1");
    await ticks(a, 3);
    expect(peer.map((m) => m.performative)).toEqual(["cfp", "accept-proposal"]);
    expect(
      agentKeys(store).filter((k) => k.startsWith("~agent.conv.offer.")),
    ).toEqual([]);
    await a.stop();
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
