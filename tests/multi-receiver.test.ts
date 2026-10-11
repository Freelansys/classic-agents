import { describe, expect, it } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { envelopeViolationReason } from "../src/bus/schemas.js";
import { Agent } from "../src/core/reasoning/index.js";
import type { AgentConfig } from "../src/core/reasoning/index.js";
import { asReceiverList } from "../src/core/reasoning/helpers.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { Action, ActionResult, Plan } from "../src/core/plans.js";

/** An agent serving the given plans, with any extra config. */
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

/** Ticks every agent, in turn, `cycles` times. */
async function run(agents: Agent[], cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

/** Records everything a non-agent peer receives. */
function inboxFor(bus: InMemoryMessageBus, id: string) {
  const received: Message[] = [];
  bus.registerAgent(id, (m) => received.push(m));
  return received;
}

/** A boss whose plan for `goal` sends the given action result once. */
function boss(
  bus: InMemoryMessageBus,
  id: string,
  result: ActionResult,
): Agent {
  const action: Action = { name: "send", execute: async () => result };
  const plan: Plan = { name: "broadcast", body: [action] };
  return agent(bus, id, [plan]);
}

/** A requester at `ui` that asks `boss` for the `broadcast` goal. */
function requester(bus: InMemoryMessageBus) {
  const inbox = inboxFor(bus, "ui");
  const request = (): Promise<void> =>
    bus.send("boss", {
      performative: "request",
      sender: "ui",
      receiver: "boss",
      content: { goal: "broadcast" },
      conversationId: "conv-ui",
      replyWith: "req-ui",
      timestamp: Date.now(),
    });
  return { inbox, request };
}

describe("asReceiverList", () => {
  it("normalizes a single address, a set, and nothing", () => {
    expect(asReceiverList("a")).toEqual(["a"]);
    expect(asReceiverList(["a", "b"])).toEqual(["a", "b"]);
    expect(asReceiverList(undefined)).toEqual([]);
  });

  it("drops duplicates and empty strings, preserving order", () => {
    expect(asReceiverList(["a", "a", "b", "a"])).toEqual(["a", "b"]);
    expect(asReceiverList(["b", "", "a"])).toEqual(["b", "a"]);
    expect(asReceiverList("")).toEqual([]);
  });
});

describe("receiver set in the envelope", () => {
  it("accepts a non-empty set of addresses", () => {
    expect(
      envelopeViolationReason({
        performative: "inform",
        sender: "a",
        receiver: ["b", "c"],
        content: {},
      }),
    ).toBeUndefined();
  });

  it("rejects an empty set", () => {
    expect(
      envelopeViolationReason({
        performative: "inform",
        sender: "a",
        receiver: [],
        content: {},
      }),
    ).toContain("malformed envelope");
  });

  it("rejects a set with an empty address", () => {
    expect(
      envelopeViolationReason({
        performative: "inform",
        sender: "a",
        receiver: ["b", ""],
        content: {},
      }),
    ).toContain("malformed envelope");
  });
});

describe("fanning a message out to a set", () => {
  it("sends one message per receiver, one conversation, one exchange each", async () => {
    const bus = new InMemoryMessageBus();
    const sent: Message[] = [];
    const mirror = boss(bus, "boss", {
      messages: [
        {
          performative: "inform",
          receiver: ["m1", "m2", "m3"],
          content: { notice: "hello" },
        },
      ],
    });
    mirror.on("message:sent", (m) => sent.push(m));
    const ui = requester(bus);
    const m1 = inboxFor(bus, "m1");
    const m2 = inboxFor(bus, "m2");
    const m3 = inboxFor(bus, "m3");

    await mirror.start();
    await ui.request();
    await run([mirror]);

    // One message per receiver, each addressed to exactly its own mailbox.
    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
    expect(m3).toHaveLength(1);
    expect(m1[0].receiver).toBe("m1");
    expect(m2[0].receiver).toBe("m2");
    expect(m3[0].receiver).toBe("m3");

    // One conversation, a distinct exchange per leg.
    const conversationIds = new Set(
      [m1[0], m2[0], m3[0]].map((m) => m.conversationId),
    );
    expect(conversationIds.size).toBe(1);
    const replyWiths = new Set([m1[0], m2[0], m3[0]].map((m) => m.replyWith));
    expect(replyWiths.size).toBe(3);

    await mirror.stop();
  });

  it("sends once to a duplicated address", async () => {
    const bus = new InMemoryMessageBus();
    const mirror = boss(bus, "boss", {
      messages: [
        {
          performative: "inform",
          receiver: ["m1", "m1", "m2"],
          content: {},
        },
      ],
    });
    const ui = requester(bus);
    const m1 = inboxFor(bus, "m1");
    const m2 = inboxFor(bus, "m2");

    await mirror.start();
    await ui.request();
    await run([mirror]);

    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);

    await mirror.stop();
  });

  it("sends nothing for an empty set", async () => {
    const bus = new InMemoryMessageBus();
    const sent: Message[] = [];
    const mirror = boss(bus, "boss", {
      messages: [{ performative: "inform", receiver: [], content: {} }],
    });
    mirror.on("message:sent", (m) => sent.push(m));
    const ui = requester(bus);

    await mirror.start();
    await ui.request();
    await run([mirror]);

    // Only the terminal `inform` back to the requester; nothing fanned out.
    expect(sent.filter((m) => m.performative === "inform")).toHaveLength(1);
    expect(sent[0].receiver).toBe("ui");

    await mirror.stop();
  });
});

describe("fanning a directive out to a set", () => {
  it("opens an exchange per receiver and tracks each peer separately", async () => {
    const bus = new InMemoryMessageBus();
    const mirror = boss(bus, "boss", {
      messages: [
        {
          performative: "request",
          receiver: ["w1", "w2"],
          content: { goal: "work" },
        },
      ],
    });
    const ui = requester(bus);
    const w1 = inboxFor(bus, "w1");
    const w2 = inboxFor(bus, "w2");

    await mirror.start();
    await ui.request();
    await run([mirror]);

    const req1 = w1.find((m) => m.performative === "request")!;
    const req2 = w2.find((m) => m.performative === "request")!;
    expect(req1.receiver).toBe("w1");
    expect(req2.receiver).toBe("w2");
    expect(req1.conversationId).toBe(req2.conversationId);
    expect(req1.replyWith).not.toBe(req2.replyWith);

    // A pending (uncertain) intention per peer, keyed by its own exchange.
    expect(mirror.beliefs.statusOf(`intent.w1.work.${req1.replyWith}`)).toBe(
      "uncertain",
    );
    expect(mirror.beliefs.statusOf(`intent.w2.work.${req2.replyWith}`)).toBe(
      "uncertain",
    );

    // Each peer agrees in its own exchange; both intentions go positive.
    await bus.send("boss", {
      performative: "agree",
      sender: "w1",
      receiver: "boss",
      content: { goal: "work", goalId: "g1" },
      conversationId: req1.conversationId,
      inReplyTo: req1.replyWith,
      timestamp: Date.now(),
    });
    await bus.send("boss", {
      performative: "agree",
      sender: "w2",
      receiver: "boss",
      content: { goal: "work", goalId: "g2" },
      conversationId: req2.conversationId,
      inReplyTo: req2.replyWith,
      timestamp: Date.now(),
    });
    await run([mirror]);

    expect(mirror.beliefs.statusOf(`intent.w1.work.${req1.replyWith}`)).toBe(
      "positive",
    );
    expect(mirror.beliefs.statusOf(`intent.w2.work.${req2.replyWith}`)).toBe(
      "positive",
    );

    await mirror.stop();
  });
});

describe("answering the requester from a set", () => {
  it("ties every leg back to the source exchange when the requester is in the set", async () => {
    const bus = new InMemoryMessageBus();
    const mirror = boss(bus, "boss", {
      messages: [
        {
          performative: "inform",
          receiver: ["ui", "observer"],
          content: { done: true },
        },
      ],
    });
    const ui = requester(bus);
    const observer = inboxFor(bus, "observer");

    await mirror.start();
    await ui.request();
    await run([mirror]);

    const answer = ui.inbox.find((m) => m.performative === "inform")!;
    expect(answer.inReplyTo).toBe("req-ui");
    expect(answer.conversationId).toBe("conv-ui");

    // The observer gets the same answer in the same conversation.
    const copy = observer.find((m) => m.performative === "inform")!;
    expect(copy.inReplyTo).toBe("req-ui");
    expect(copy.conversationId).toBe("conv-ui");

    await mirror.stop();
  });
});

describe("receiving a message addressed to a set", () => {
  it("processes a set that includes this agent", async () => {
    const bus = new InMemoryMessageBus();
    const listener = agent(bus, "l1", []);
    await listener.start();

    await bus.send("l1", {
      performative: "inform",
      sender: "s",
      receiver: ["l1", "l2"],
      content: { temperature: 7 },
      timestamp: Date.now(),
    });
    await run([listener]);

    expect(listener.beliefs.get("msg.temperature")).toBe(7);

    await listener.stop();
  });
});
