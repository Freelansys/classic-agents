import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type { AgentConfig } from "../src/core/reasoning/index.js";
import { DesireLibrary } from "../src/core/desires.js";
import type { Desire } from "../src/core/desires.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";
import type { Goal } from "../src/core/goals.js";

// A plan may name the conversation a delegation, call, proposal or message
// belongs to, and a desire the conversation its goal acts in (#89).

function agent(
  bus: InMemoryMessageBus,
  id: string,
  plans: Plan[],
  config: Partial<AgentConfig> = {},
): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library, ...config });
}

/** A plan of one action per result, in order. */
function plan(goal: string, ...results: ActionResult[]): Plan {
  return {
    goal,
    body: results.map((result, i) => ({
      name: `${goal}-${i}`,
      execute: async (): Promise<ActionResult> => result,
    })),
  };
}

async function run(agents: Agent[], cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A peer that records what it receives and answers nothing. */
function silentPeer(bus: InMemoryMessageBus, id: string): Message[] {
  const received: Message[] = [];
  bus.registerAgent(id, (msg) => received.push(msg));
  return received;
}

/** Sends `boss` a request for `goal` from `ui`, in `conv-ui`. */
function requestFromUi(bus: InMemoryMessageBus, goal: string): Promise<void> {
  return bus.send("boss", {
    performative: "request",
    sender: "ui",
    receiver: "boss",
    content: { goal },
    conversationId: "conv-ui",
    replyWith: "req-ui",
    timestamp: Date.now(),
  });
}

/** Records every message `a` sends. */
function sentBy(a: Agent): Message[] {
  const sent: Message[] = [];
  a.on("message:sent", (m: Message) => sent.push(m));
  return sent;
}

describe("A delegation that names its conversation", () => {
  it("goes out in it, and the receiver's own delegations follow it there", async () => {
    const bus = new InMemoryMessageBus();
    const ui: Message[] = [];
    bus.registerAgent("ui", (m) => ui.push(m));
    const boss = agent(bus, "boss", [
      plan("ship", {
        delegations: [
          {
            receiver: "warehouse",
            goal: "pick",
            conversationId: "conv-thread",
          },
        ],
      }),
    ]);
    const warehouse = agent(bus, "warehouse", [
      plan("pick", { delegations: [{ receiver: "packer", goal: "pack" }] }),
    ]);
    const packer = agent(bus, "packer", [plan("pack", {})]);
    const fromBoss = sentBy(boss);
    const fromWarehouse = sentBy(warehouse);
    const fromPacker = sentBy(packer);
    for (const a of [boss, warehouse, packer]) await a.start();

    await requestFromUi(bus, "ship");
    await run([boss, warehouse, packer], 15);

    const request = fromBoss.find(
      (m) => m.performative === "request" && m.receiver === "warehouse",
    )!;
    expect(request.conversationId).toBe("conv-thread");
    // The receiver took it on in that conversation, so its own request
    // follows, and every reply stays there.
    const onward = fromWarehouse.find((m) => m.performative === "request")!;
    expect(onward.conversationId).toBe("conv-thread");
    for (const m of [...fromWarehouse, ...fromPacker]) {
      expect(m.conversationId).toBe("conv-thread");
    }
    // The requester is still answered in its own conversation.
    const done = ui.find((m) => m.performative === "inform")!;
    expect(done.conversationId).toBe("conv-ui");
  });

  it("is cancelled in it when it times out", async () => {
    const bus = new InMemoryMessageBus();
    const received = silentPeer(bus, "warehouse");
    const boss = agent(bus, "boss", [
      plan("ship", {
        delegations: [
          {
            receiver: "warehouse",
            goal: "pick",
            conversationId: "conv-thread",
            timeoutMs: 20,
          },
        ],
      }),
    ]);
    await boss.start();
    boss.goals.add({ id: "g-1", name: "ship", priority: 5, status: "pending" });
    await run([boss], 3);
    await wait(40);
    await run([boss], 3);

    const cancel = received.find((m) => m.performative === "cancel")!;
    expect(cancel).toBeDefined();
    expect(cancel.conversationId).toBe("conv-thread");
  });

  it("makes a self-delegation's sub-goal speak in it", async () => {
    const bus = new InMemoryMessageBus();
    const received = silentPeer(bus, "proxy");
    const boss = agent(bus, "boss", [
      plan("ship", {
        delegations: [{ goal: "ask", conversationId: "conv-thread" }],
      }),
      plan("ask", {
        messages: [{ receiver: "proxy", performative: "inform", content: {} }],
      }),
    ]);
    const goals: Goal[] = [];
    boss.on("goal:added", (g: Goal) => goals.push(g));
    await boss.start();

    await requestFromUi(bus, "ship");
    await run([boss], 8);

    const sub = goals.find((g) => g.name === "ask")!;
    // The requester stays traceable; only the conversation changes.
    expect(sub.source).toMatchObject({
      sender: "ui",
      conversationId: "conv-thread",
    });
    expect(received[0].conversationId).toBe("conv-thread");
  });
});

describe("A proposal that names its conversation", () => {
  it("goes out in it", async () => {
    const bus = new InMemoryMessageBus();
    const received = silentPeer(bus, "approver");
    const boss = agent(bus, "boss", [
      plan("offer", {
        proposals: [
          {
            receiver: "approver",
            goal: "approve",
            terms: { slot: 1 },
            conversationId: "conv-thread",
          },
        ],
      }),
    ]);
    await boss.start();
    await requestFromUi(bus, "offer");
    await run([boss], 4);

    const propose = received.find((m) => m.performative === "propose")!;
    expect(propose.conversationId).toBe("conv-thread");
  });
});

/**
 * A bidder that is not an agent: answers each `cfp` with a `propose` of
 * `price`, and records what it receives.
 */
function bidder(bus: InMemoryMessageBus, id: string, price: number): Message[] {
  const received: Message[] = [];
  bus.registerAgent(id, (msg) => {
    received.push(msg);
    if (msg.performative !== "cfp") return;
    void bus.send(msg.sender, {
      performative: "propose",
      sender: id,
      receiver: msg.sender,
      content: { goal: "dig", terms: { price } },
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      replyWith: `bid-${id}`,
      inReplyTo: msg.replyWith,
      timestamp: Date.now(),
    });
  });
  return received;
}

/** A plan that calls `cheap` and `dear` for "dig", then awards `cheap`'s bid. */
function tender(conversationId?: string): Plan {
  return {
    goal: "build",
    body: [
      {
        name: "call",
        execute: async (): Promise<ActionResult> => ({
          calls: [
            {
              goal: "dig",
              receivers: ["cheap", "dear"],
              deadlineMs: 1000,
              ...(conversationId ? { conversationId } : {}),
            },
          ],
        }),
      },
      {
        name: "award",
        execute: async (): Promise<ActionResult> => ({
          awards: [{ proposal: "bid-cheap", timeoutMs: null }],
        }),
      },
    ],
  };
}

describe("A call for proposals that names its conversation", () => {
  it("goes out in it, and is awarded and rejected in it", async () => {
    const bus = new InMemoryMessageBus();
    const cheap = bidder(bus, "cheap", 1);
    const dear = bidder(bus, "dear", 9);
    const boss = agent(bus, "boss", [tender("conv-thread")]);
    const calls: string[] = [];
    boss.on("call:opened", (e: { call: { conversationId?: string } }) =>
      calls.push(e.call.conversationId!),
    );
    await boss.start();
    await requestFromUi(bus, "build");
    await run([boss], 8);

    expect(calls).toEqual(["conv-thread"]);
    for (const m of [...cheap, ...dear]) {
      expect(m.conversationId).toBe("conv-thread");
    }
    expect(cheap.map((m) => m.performative)).toEqual([
      "cfp",
      "accept-proposal",
    ]);
    expect(dear.map((m) => m.performative)).toEqual(["cfp", "reject-proposal"]);
  });

  it("keeps the goal's conversation for the whole call when it names none", async () => {
    const bus = new InMemoryMessageBus();
    const cheap = bidder(bus, "cheap", 1);
    const dear = bidder(bus, "dear", 9);
    const boss = agent(bus, "boss", [tender()]);
    await boss.start();
    await requestFromUi(bus, "build");
    await run([boss], 8);

    for (const m of [...cheap, ...dear]) {
      expect(m.conversationId).toBe("conv-ui");
    }
  });

  it("opens one conversation for every leg when the goal has none", async () => {
    const bus = new InMemoryMessageBus();
    const cheap = bidder(bus, "cheap", 1);
    const dear = bidder(bus, "dear", 9);
    const boss = agent(bus, "boss", [tender()]);
    await boss.start();
    boss.goals.add({
      id: "g-1",
      name: "build",
      priority: 5,
      status: "pending",
    });
    await run([boss], 8);

    const conversation = cheap[0].conversationId;
    expect(conversation).toBeDefined();
    for (const m of [...cheap, ...dear]) {
      expect(m.conversationId).toBe(conversation);
    }
  });
});

describe("A plan message that names its conversation", () => {
  it("goes out in it, to one receiver, a set, or a topic", async () => {
    const bus = new InMemoryMessageBus();
    const a = silentPeer(bus, "a");
    const b = silentPeer(bus, "b");
    const c = silentPeer(bus, "c");
    const heard: Message[] = [];
    await bus.subscribe("news", (m) => {
      heard.push(m);
    });
    const boss = agent(bus, "boss", [
      plan("tell", {
        messages: [
          {
            receiver: "a",
            performative: "inform",
            content: {},
            conversationId: "conv-thread",
          },
          {
            receiver: ["b", "c"],
            performative: "inform",
            content: {},
            conversationId: "conv-thread",
          },
          {
            topic: "news",
            performative: "inform",
            content: {},
            conversationId: "conv-thread",
          },
        ],
      }),
    ]);
    await boss.start();
    await requestFromUi(bus, "tell");
    await run([boss], 4);

    for (const m of [a[0], b[0], c[0], heard[0]]) {
      expect(m.conversationId).toBe("conv-thread");
    }
  });

  it("keeps the goal's conversation when it names none", async () => {
    const bus = new InMemoryMessageBus();
    const a = silentPeer(bus, "a");
    const boss = agent(bus, "boss", [
      plan("tell", {
        messages: [{ receiver: "a", performative: "inform", content: {} }],
      }),
    ]);
    await boss.start();
    await requestFromUi(bus, "tell");
    await run([boss], 4);

    expect(a[0].conversationId).toBe("conv-ui");
  });
});

describe("A desire that names its conversation", () => {
  it("generates a goal in it, answered to nobody, whose work goes out there", async () => {
    const bus = new InMemoryMessageBus();
    const received: Message[] = [];
    bus.registerAgent("proxy", (msg) => {
      received.push(msg);
      if (msg.performative === "request") {
        void bus.send(msg.sender, {
          performative: "inform",
          sender: "proxy",
          receiver: msg.sender,
          content: { goal: "forward", done: true },
          ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
          ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
          timestamp: Date.now(),
        });
      }
    });
    const planLibrary = new PlanLibrary();
    planLibrary.register(
      plan("reroute", {
        delegations: [{ receiver: "proxy", goal: "forward" }],
      }),
    );
    const desires = new DesireLibrary();
    let fired = false;
    const desire: Desire = {
      name: "reroute-declined",
      intend: () =>
        fired ? undefined : { goal: "reroute", conversationId: "conv-thread" },
    };
    desires.register(desire);
    const coordinator = new Agent({
      id: "coordinator",
      bus,
      planLibrary,
      desires,
    });
    const sent = sentBy(coordinator);
    const goals: Goal[] = [];
    coordinator.on("goal:added", (g: Goal) => {
      goals.push(g);
      fired = true;
    });
    await coordinator.start();
    await run([coordinator], 8);

    const goal = goals.find((g) => g.name === "reroute")!;
    expect(goal.source).toEqual({
      sender: "coordinator",
      conversationId: "conv-thread",
    });
    const request = received.find((m) => m.performative === "request")!;
    expect(request.conversationId).toBe("conv-thread");
    // Nothing answers the goal itself: the agent is its source.
    expect(sent.filter((m) => m.performative !== "request")).toEqual([]);
  });
});
