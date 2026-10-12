import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import {
  Agent,
  MAX_REMEMBERED_PROTOCOLS,
} from "../src/core/reasoning/index.js";
import {
  ExpressionLibrary,
  PropositionLibrary,
} from "../src/core/expressions.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";
import type { Intention } from "../src/core/intentions.js";

/** An agent serving the given plans, with any extra config. */
function agent(
  bus: InMemoryMessageBus,
  id: string,
  plans: Plan[],
  extra: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library, ...extra });
}

/** A one-step plan that does nothing. */
function worker(name: string): Plan {
  return { name, body: [{ name, execute: async () => ({}) }] };
}

/** A plain bus client that records everything sent to it. */
function client(bus: InMemoryMessageBus, id: string): Message[] {
  const inbox: Message[] = [];
  bus.registerAgent(id, (m) => inbox.push(m));
  return inbox;
}

async function run(agents: Agent[], cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

function send(
  bus: InMemoryMessageBus,
  to: string,
  message: Omit<Message, "timestamp" | "receiver">,
): Promise<void> {
  return bus.send(to, { ...message, receiver: to, timestamp: Date.now() });
}

describe("protocol", () => {
  it("answers a request in fipa-request: agree, terminal inform, refuse", async () => {
    const bus = new InMemoryMessageBus();
    const worker1 = agent(bus, "w", [worker("dig")]);
    const inbox = client(bus, "ui");
    await worker1.start();

    await send(bus, "w", {
      performative: "request",
      sender: "ui",
      content: { goal: "dig" },
      replyWith: "r1",
    });
    await send(bus, "w", {
      performative: "request",
      sender: "ui",
      content: { goal: "fly" },
      replyWith: "r2",
    });
    await run([worker1]);

    const replies = inbox.map((m) => [m.performative, m.inReplyTo, m.protocol]);
    expect(replies).toContainEqual(["agree", "r1", "fipa-request"]);
    expect(replies).toContainEqual(["inform", "r1", "fipa-request"]);
    expect(replies).toContainEqual(["refuse", "r2", "fipa-request"]);
  });

  it("echoes a protocol the requester named itself", async () => {
    const bus = new InMemoryMessageBus();
    const worker1 = agent(bus, "w", [worker("dig")]);
    const inbox = client(bus, "ui");
    await worker1.start();

    await send(bus, "w", {
      performative: "request",
      sender: "ui",
      content: { goal: "dig" },
      replyWith: "r1",
      protocol: "acme-work-order",
    });
    await run([worker1]);

    expect(inbox.map((m) => m.protocol)).toEqual([
      "acme-work-order",
      "acme-work-order",
    ]);
  });

  it("stamps the request a delegation sends, and a query's answer", async () => {
    const bus = new InMemoryMessageBus();
    const propositions = new PropositionLibrary();
    propositions.register({ name: "dry", evaluate: () => true });
    const helper = agent(bus, "helper", [worker("pack")], {
      propositionLibrary: propositions,
    });
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          {
            name: "delegate",
            execute: async (): Promise<ActionResult> => ({
              delegations: [{ receiver: "helper", goal: "pack" }],
            }),
          },
        ],
      },
    ]);
    const sent: Message[] = [];
    boss.on("message:sent", (m) => sent.push(m));
    const inbox = client(bus, "ui");
    await boss.start();
    await helper.start();

    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });
    await send(bus, "helper", {
      performative: "query-if",
      sender: "ui",
      content: { name: "dry" },
      replyWith: "q1",
    });
    await run([boss, helper]);

    expect(sent.find((m) => m.performative === "request")?.protocol).toBe(
      "fipa-request",
    );
    const answer = inbox.find((m) => m.inReplyTo === "q1");
    expect(answer?.performative).toBe("inform");
    expect(answer?.protocol).toBe("fipa-query");
  });

  it("keeps a whole Contract Net exchange in fipa-contract-net", async () => {
    const bus = new InMemoryMessageBus();
    const quotes = new ExpressionLibrary();
    quotes.register({ name: "quote", evaluate: () => ({ price: 1 }) });
    const bidder = agent(
      bus,
      "b1",
      [{ name: "dig", bid: "quote", body: worker("dig").body }],
      { expressionLibrary: quotes },
    );
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [
          {
            name: "call",
            execute: async (): Promise<ActionResult> => ({
              calls: [{ goal: "dig", receivers: ["b1"] }],
            }),
          },
          {
            name: "award",
            execute: async (intention: Intention): Promise<ActionResult> => ({
              awards: [{ proposal: intention.calls[0].proposals[0].id }],
            }),
          },
        ],
      },
    ]);
    const traffic: Message[] = [];
    boss.on("message:sent", (m) => traffic.push(m));
    bidder.on("message:sent", (m) => traffic.push(m));
    await boss.start();
    await bidder.start();

    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, bidder], 15);

    expect(traffic.map((m) => m.performative)).toEqual([
      "cfp",
      "propose",
      "accept-proposal",
      "inform",
    ]);
    expect(new Set(traffic.map((m) => m.protocol))).toEqual(
      new Set(["fipa-contract-net"]),
    );
  });

  it("sends an unprompted inform with no protocol", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "notify",
        body: [
          {
            name: "tell",
            execute: async (): Promise<ActionResult> => ({
              messages: [
                { receiver: "ui", performative: "inform", content: { x: 1 } },
              ],
            }),
          },
        ],
      },
    ]);
    const inbox = client(bus, "ui");
    await boss.start();
    boss.goals.add({ id: "g", name: "notify", priority: 5, status: "pending" });
    await run([boss], 3);

    expect(inbox).toHaveLength(1);
    expect(inbox[0].protocol).toBeUndefined();
  });

  it("remembers a bounded number of exchanges", async () => {
    const bus = new InMemoryMessageBus();
    const worker1 = agent(bus, "w", []);
    client(bus, "ui");
    await worker1.start();

    // Fed in batches, since the inbox itself is bounded well below the cap.
    for (let i = 0; i < MAX_REMEMBERED_PROTOCOLS + 5; i++) {
      if (i > 0 && i % 500 === 0) await worker1.tick();
      worker1.inbox.push({
        performative: "inform",
        sender: "ui",
        receiver: "w",
        content: {},
        replyWith: `m${i}`,
        protocol: "p",
        timestamp: Date.now(),
      });
    }
    await worker1.tick();

    expect(worker1.exchangeProtocols.size).toBe(MAX_REMEMBERED_PROTOCOLS);
    expect(worker1.exchangeProtocols.has("m0")).toBe(false);
    expect(
      worker1.exchangeProtocols.has(`m${MAX_REMEMBERED_PROTOCOLS + 4}`),
    ).toBe(true);
  });
});

describe("language and ontology", () => {
  it("answers not-understood for an ontology it was not configured for", async () => {
    const bus = new InMemoryMessageBus();
    const worker1 = agent(bus, "w", [worker("dig")], {
      supportedOntologies: ["logistics"],
    });
    const inbox = client(bus, "ui");
    const rejected: string[] = [];
    worker1.on("message:rejected", (e) => rejected.push(e.reason));
    await worker1.start();

    await send(bus, "w", {
      performative: "request",
      sender: "ui",
      content: { goal: "dig" },
      replyWith: "r1",
      ontology: "astronomy",
    });
    await send(bus, "w", {
      performative: "request",
      sender: "ui",
      content: { goal: "dig" },
      replyWith: "r2",
      ontology: "logistics",
    });
    await send(bus, "w", {
      performative: "request",
      sender: "ui",
      content: { goal: "dig" },
      replyWith: "r3",
    });
    await run([worker1]);

    const toR1 = inbox.filter((m) => m.inReplyTo === "r1");
    expect(toR1.map((m) => m.performative)).toEqual(["not-understood"]);
    expect(toR1[0].content).toMatchObject({
      reason: 'unsupported ontology: "astronomy"',
    });
    expect(rejected).toEqual(['unsupported ontology: "astronomy"']);
    // A listed ontology, and none at all, are both read as usual.
    for (const id of ["r2", "r3"]) {
      expect(
        inbox.filter((m) => m.inReplyTo === id).map((m) => m.performative),
      ).toEqual(["agree", "inform"]);
    }
  });

  it("answers not-understood for a language it was not configured for", async () => {
    const bus = new InMemoryMessageBus();
    const worker1 = agent(bus, "w", [worker("dig")], {
      supportedLanguages: ["json"],
    });
    const inbox = client(bus, "ui");
    await worker1.start();

    await send(bus, "w", {
      performative: "request",
      sender: "ui",
      content: "(action w (dig))",
      replyWith: "r1",
      language: "fipa-sl",
    });
    await run([worker1]);

    expect(inbox.map((m) => m.performative)).toEqual(["not-understood"]);
    expect(inbox[0].content).toMatchObject({
      reason: 'unsupported language: "fipa-sl"',
    });
  });

  it("accepts every language and ontology when none is configured", async () => {
    const bus = new InMemoryMessageBus();
    const worker1 = agent(bus, "w", [worker("dig")]);
    const inbox = client(bus, "ui");
    await worker1.start();

    await send(bus, "w", {
      performative: "request",
      sender: "ui",
      content: { goal: "dig" },
      replyWith: "r1",
      language: "anything",
      ontology: "anything",
    });
    await run([worker1]);

    expect(inbox.map((m) => m.performative)).toEqual(["agree", "inform"]);
  });

  it("does not answer a not-understood it cannot read", async () => {
    const bus = new InMemoryMessageBus();
    const worker1 = agent(bus, "w", [], { supportedOntologies: ["logistics"] });
    const inbox = client(bus, "ui");
    await worker1.start();

    await send(bus, "w", {
      performative: "not-understood",
      sender: "ui",
      content: { reason: "?" },
      ontology: "astronomy",
    });
    await run([worker1], 3);

    expect(inbox).toEqual([]);
  });
});
