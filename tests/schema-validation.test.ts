import { describe, expect, it } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { FIPA_PERFORMATIVES } from "../src/bus/performatives.js";
import { Agent, PlanLibrary } from "../src/core/index.js";
import { ExpressionLibrary, PropositionLibrary } from "../src/core/index.js";
import {
  validateContent,
  schemaViolationReason,
  isKnownPerformative,
} from "../src/bus/schemas.js";

function makeAgent(id: string, bus: InMemoryMessageBus): Agent {
  const lib = new PlanLibrary();
  lib.register({ name: "fetchData", body: [] });
  return new Agent({ id, bus, planLibrary: lib });
}

function collectFromAgent(bus: InMemoryMessageBus, agentId: string): Message[] {
  const messages: Message[] = [];
  bus.registerAgent(agentId, (msg) => messages.push(msg));
  return messages;
}

describe("content schema validation", () => {
  it("accepts a well-formed request", () => {
    expect(validateContent("request", { goal: "fetchData" })).toBe(true);
  });

  it("accepts a request with optional fields", () => {
    expect(
      validateContent("request", {
        goal: "fetchData",
        goalId: "g-1",
        dependsOn: ["g-2"],
      }),
    ).toBe(true);
  });

  it("rejects a request missing the required goal", () => {
    expect(validateContent("request", { task: "fetchData" })).toBe(false);
    expect(validateContent("request", {})).toBe(false);
  });

  it("rejects a request with a non-string goal", () => {
    expect(validateContent("request", { goal: 42 })).toBe(false);
  });

  it("accepts a well-formed agree", () => {
    expect(validateContent("agree", { goalId: "g-1" })).toBe(true);
  });

  it("accepts an agree with optional fields", () => {
    expect(
      validateContent("agree", {
        goalId: "g-1",
        goal: "fetchData",
        conversationId: "c-1",
      }),
    ).toBe(true);
  });

  it("rejects an agree missing the required goalId", () => {
    expect(validateContent("agree", { goal: "fetchData" })).toBe(false);
    expect(validateContent("agree", {})).toBe(false);
  });

  it("rejects an agree with a non-string goalId", () => {
    expect(validateContent("agree", { goalId: 123 })).toBe(false);
  });

  it("accepts a well-formed refuse", () => {
    expect(validateContent("refuse", { goal: "fetchData" })).toBe(true);
  });

  it("accepts a refuse with optional fields", () => {
    expect(
      validateContent("refuse", {
        goal: "fetchData",
        verdict: "capacity",
        reason: "busy",
      }),
    ).toBe(true);
  });

  it("rejects a refuse that names neither a goal nor a query", () => {
    expect(validateContent("refuse", { verdict: "capacity" })).toBe(false);
    expect(validateContent("refuse", {})).toBe(false);
  });

  it("accepts a refuse that names a query instead of a goal", () => {
    expect(
      validateContent("refuse", { name: "raining", verdict: "middleware" }),
    ).toBe(true);
  });

  it("accepts a failure with any shape — no required fields", () => {
    expect(validateContent("failure", { goal: "fetch", reason: "503" })).toBe(
      true,
    );
    expect(validateContent("failure", { reason: "broke" })).toBe(true);
    expect(validateContent("failure", {})).toBe(true);
  });

  it("accepts a not-understood with any shape — no required fields", () => {
    expect(
      validateContent("not-understood", {
        event: "request",
        reason: "bad schema",
      }),
    ).toBe(true);
    expect(validateContent("not-understood", { reason: "unknown" })).toBe(true);
    expect(validateContent("not-understood", {})).toBe(true);
  });

  it("accepts assertions without checking content shape", () => {
    for (const p of ["inform", "confirm", "disconfirm"] as const) {
      expect(validateContent(p, {})).toBe(true);
      expect(validateContent(p, { anything: true })).toBe(true);
    }
  });

  it("accepts conversation-only performatives without checking content", () => {
    for (const p of ["propose", "accept-proposal"] as const) {
      expect(validateContent(p, {})).toBe(true);
    }
  });

  it("produces a readable violation reason", () => {
    const reason = schemaViolationReason("request", { task: "fetchData" });
    expect(reason).toContain("goal");
    expect(reason).toContain("request");
  });

  it("returns an empty reason for a performative with no schema", () => {
    expect(schemaViolationReason("inform", {})).toBe("");
    expect(schemaViolationReason("failure", { goal: 42 })).toBe("");
  });

  it("accepts a well-formed query-if naming a proposition", () => {
    expect(validateContent("query-if", { name: "raining" })).toBe(true);
  });

  it("rejects a query-if with no name", () => {
    expect(validateContent("query-if", {})).toBe(false);
    expect(validateContent("query-if", { name: 42 })).toBe(false);
  });

  it("rejects a query-ref with no name", () => {
    expect(validateContent("query-ref", {})).toBe(false);
    expect(validateContent("query-ref", { name: "raining", extra: true })).toBe(
      true,
    );
  });

  it("accepts a well-formed query-ref naming an expression", () => {
    expect(validateContent("query-ref", { name: "warmest-room" })).toBe(true);
  });

  it("produces a readable violation reason for query-if", () => {
    const reason = schemaViolationReason("query-if", {});
    expect(reason).toContain("name");
    expect(reason).toContain("query-if");
  });

  it("produces a readable violation reason for query-ref", () => {
    const reason = schemaViolationReason("query-ref", {});
    expect(reason).toContain("name");
    expect(reason).toContain("query-ref");
  });
});

describe("isKnownPerformative", () => {
  it("recognises every FIPA CAL performative", () => {
    for (const p of FIPA_PERFORMATIVES) {
      expect(isKnownPerformative(p), p).toBe(true);
    }
  });

  it("rejects every name outside the vocabulary, the old aliases included", () => {
    // The vocabulary is the 22 CAL acts. Everything the library used to accept
    // beyond them now arrives as "I have never seen this kind of act before",
    // which is what an FIPA message carrying a non-FIPA performative is.
    for (const p of [
      "achieve",
      "query",
      "commit",
      "declare",
      "delegate",
      "disagree",
      "invite",
      "invoke",
      "promise",
      "query-if-known",
      "sorry",
      "unsubscribe",
    ]) {
      expect(isKnownPerformative(p), p).toBe(false);
    }
  });

  it("rejects a performative the library has never seen", () => {
    expect(isKnownPerformative("ping" as string)).toBe(false);
    expect(isKnownPerformative("foo-bar" as string)).toBe(false);
    expect(isKnownPerformative("" as string)).toBe(false);
  });
});

describe("not-understood on unknown performative", () => {
  it("sends not-understood when a message carries an unknown performative", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "ping" as Parameters<typeof bus.send>[1]["performative"],
      sender: "b",
      receiver: "a1",
      content: { value: 42 },
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("ping");
    const reason = content.reason as string;
    expect(reason).toContain("unknown performative");
    expect(reason).toContain("ping");

    // No goal, no belief — the message was neither acted on nor stored.
    expect(agent.goals.all()).toHaveLength(0);
    expect(agent.beliefs.get("msg.value")).toBeUndefined();

    await agent.stop();
  });

  it("does not send not-understood for an unknown performative to itself", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    await bus.send("a1", {
      performative: "ping" as Parameters<typeof bus.send>[1]["performative"],
      sender: "a1",
      receiver: "a1",
      content: { value: 42 },
      timestamp: Date.now(),
    });

    await agent.tick();

    const inbox = collectFromAgent(bus, "a1");
    const notUnderstood = inbox.filter(
      (m) => m.performative === "not-understood" && m.receiver === "a1",
    );
    expect(notUnderstood).toHaveLength(0);

    await agent.stop();
  });

  it("does not send not-understood for a known performative with unknown content shape", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    // Known performative but malformed content — schema validation should
    // handle this, not the unknown-performative path.
    await bus.send("a1", {
      performative: "request",
      sender: "b",
      receiver: "a1",
      content: { task: "fetchData" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    // The reason should mention schema violation, not unknown performative.
    expect(content.event).toBe("request");
    const reason = content.reason as string;
    expect(reason).toContain("schema violation");

    await agent.stop();
  });
});

describe("not-understood on schema violation", () => {
  it("sends not-understood when a request has no goal", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    // Register b before sending so we can capture the reply.
    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "request",
      sender: "b",
      receiver: "a1",
      content: { task: "fetchData" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("request");
    expect(typeof content.reason).toBe("string");
    expect(content.reason as string).toContain("goal");

    // No goal was created.
    expect(agent.goals.all()).toHaveLength(0);

    await agent.stop();
  });

  it("sends not-understood when an agree has no goalId", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "agree",
      sender: "b",
      receiver: "a1",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("agree");

    await agent.stop();
  });

  it("sends not-understood when a refuse has no goal", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "refuse",
      sender: "b",
      receiver: "a1",
      content: { verdict: "capacity" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("refuse");

    await agent.stop();
  });

  it("does not send not-understood for malformed assertions", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "inform",
      sender: "b",
      receiver: "a1",
      content: { temperature: null },
      timestamp: Date.now(),
    });

    await agent.tick();

    // Inform is not schema-checked, so the message is believed and no
    // not-understood is sent.
    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeUndefined();

    // The belief was stored anyway.
    expect(agent.beliefs.get("msg.temperature")).toBeNull();

    await agent.stop();
  });

  it("does not send not-understood to itself", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    // a1 sends itself a malformed request.
    await bus.send("a1", {
      performative: "request",
      sender: "a1",
      receiver: "a1",
      content: { task: "fetchData" },
      timestamp: Date.now(),
    });

    await agent.tick();

    // No not-understood should be sent back to a1.
    const inbox = collectFromAgent(bus, "a1");
    const notUnderstood = inbox.filter(
      (m) => m.performative === "not-understood" && m.receiver === "a1",
    );
    expect(notUnderstood).toHaveLength(0);

    await agent.stop();
  });

  it("allows middleware to repair a malformed request before validation", async () => {
    const bus = new InMemoryMessageBus();
    const lib = new PlanLibrary();
    lib.register({
      name: "fetchData",
      body: [
        {
          name: "mark",
          execute: async () => ({
            beliefUpdates: [{ key: "fetched", value: true }],
          }),
        },
      ],
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: lib,
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

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "request",
      sender: "b",
      receiver: "a1",
      content: { task: "fetchData" },
      timestamp: Date.now(),
    });

    await agent.tick();

    // Middleware repaired the content, so no not-understood is sent.
    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeUndefined();

    // The goal was admitted and the repaired plan ran to completion.
    expect(agent.beliefs.get("fetched")).toBe(true);

    await agent.stop();
  });

  it("sends not-understood when middleware cannot repair the content", async () => {
    const bus = new InMemoryMessageBus();
    const lib = new PlanLibrary();
    lib.register({ name: "fetchData", body: [] });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: lib,
      directiveMiddleware: [
        async (_req, _res, next) => {
          // Intentionally does not repair the missing goal.
          await next();
        },
      ],
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "request",
      sender: "b",
      receiver: "a1",
      content: { task: "fetchData" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();

    // No goal was created.
    expect(agent.goals.all()).toHaveLength(0);

    await agent.stop();
  });
});

describe("query-if and query-ref, answered from the agent's knowledge", () => {
  it("answers a query-if from a registered proposition, in the same exchange", async () => {
    const bus = new InMemoryMessageBus();
    const propositions = new PropositionLibrary();
    propositions.register({
      name: "raining",
      evaluate: (b) => b.get("weather.rain") === true,
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      propositionLibrary: propositions,
    });
    await agent.start();

    const beliefs = agent.beliefs;
    beliefs.set("weather.rain", true);

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      conversationId: "chat-1",
      replyWith: "q-1",
      content: { name: "raining" },
      timestamp: Date.now(),
    });

    await agent.tick();

    // No goal is created, nothing is agreed: a query is answered, not worked.
    expect(agent.goals.all()).toHaveLength(0);

    const inform = inbox.find(
      (m) => m.performative === "inform" && m.sender === "a1",
    );
    expect(inform).toBeDefined();
    expect(inform!.receiver).toBe("b");
    // The answer rides the same exchange: the conversation, and the question it
    // answers named via `in-reply-to`.
    expect(inform!.conversationId).toBe("chat-1");
    expect(inform!.inReplyTo).toBe("q-1");
    expect(inform!.content).toEqual({ name: "raining", result: true });

    await agent.stop();
  });

  it("answers a query-ref from a registered expression with the value", async () => {
    const bus = new InMemoryMessageBus();
    const expressions = new ExpressionLibrary();
    expressions.register({
      name: "warmest-room",
      evaluate: (b) => {
        const rooms = b.get<Record<string, number>>("survey.rooms") ?? {};
        return Object.entries(rooms).sort((a, z) => z[1] - a[1])[0];
      },
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      expressionLibrary: expressions,
    });
    await agent.start();

    agent.beliefs.set("survey.rooms", { r1: 20, r2: 24, r3: 21 });

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-ref",
      sender: "b",
      receiver: "a1",
      conversationId: "chat-2",
      replyWith: "q-2",
      content: { name: "warmest-room" },
      timestamp: Date.now(),
    });

    await agent.tick();

    expect(agent.goals.all()).toHaveLength(0);

    const inform = inbox.find(
      (m) => m.performative === "inform" && m.sender === "a1",
    );
    expect(inform).toBeDefined();
    expect(inform!.receiver).toBe("b");
    expect(inform!.conversationId).toBe("chat-2");
    expect(inform!.inReplyTo).toBe("q-2");
    expect(inform!.content).toEqual({
      name: "warmest-room",
      result: ["r2", 24],
    });

    await agent.stop();
  });

  it("evaluates the proposition against the agent's own beliefs, and the message", async () => {
    const bus = new InMemoryMessageBus();
    const propositions = new PropositionLibrary();
    propositions.register({
      name: "allowed",
      evaluate: (b, message) => {
        const gate = message.content as { open?: boolean };
        return b.get("security.mode") === "permissive" || gate.open === true;
      },
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      propositionLibrary: propositions,
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      content: { name: "allowed", open: true },
      timestamp: Date.now(),
    });

    await agent.tick();

    const inform = inbox.find(
      (m) => m.performative === "inform" && m.sender === "a1",
    );
    expect(inform!.content).toEqual({ name: "allowed", result: true });

    await agent.stop();
  });

  it("waits for an async proposition, as when judging by a model", async () => {
    const bus = new InMemoryMessageBus();
    const propositions = new PropositionLibrary();
    propositions.register({
      name: "judged",
      evaluate: async (b, message): Promise<boolean> => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return (
          (message.content as { threshold?: number }).threshold === undefined
        );
      },
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      propositionLibrary: propositions,
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      content: { name: "judged" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const inform = inbox.find(
      (m) => m.performative === "inform" && m.sender === "a1",
    );
    expect(inform!.content).toEqual({ name: "judged", result: true });

    await agent.stop();
  });

  it("sends not-understood when the named proposition is not registered", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      content: { name: "no-such-proposition" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("query-if");
    expect(content.reason).toBe(
      'no proposition named "no-such-proposition" is registered',
    );

    // No goal was created, and nothing was refused.
    expect(agent.goals.all()).toHaveLength(0);
    expect(
      inbox.find((m) => m.performative === "refuse" && m.sender === "a1"),
    ).toBeUndefined();

    await agent.stop();
  });

  it("answers null, not not-understood, when a registered expression finds nothing", async () => {
    const bus = new InMemoryMessageBus();
    const expressions = new ExpressionLibrary();
    expressions.register({ name: "warmest-room", evaluate: () => undefined });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      expressionLibrary: expressions,
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-ref",
      sender: "b",
      receiver: "a1",
      replyWith: "q-5",
      content: { name: "warmest-room" },
      timestamp: Date.now(),
    });

    await agent.tick();

    // The name is known and the question was answered: there is no such room.
    // `null` survives JSON where `undefined` would vanish from the content.
    expect(inbox.map((m) => m.performative)).toEqual(["inform"]);
    expect(inbox[0].inReplyTo).toBe("q-5");
    expect(inbox[0].content).toEqual({ name: "warmest-room", result: null });

    await agent.stop();
  });

  it("sends not-understood when the named expression is not registered", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-ref",
      sender: "b",
      receiver: "a1",
      content: { name: "no-such-expression" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("query-ref");
    expect(content.reason).toBe(
      'no expression named "no-such-expression" is registered',
    );

    await agent.stop();
  });

  it("a directive middleware can decline a query", async () => {
    const bus = new InMemoryMessageBus();
    const propositions = new PropositionLibrary();
    propositions.register({ name: "raining", evaluate: () => true });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      propositionLibrary: propositions,
      directiveMiddleware: [
        async (req, res, next) => {
          if (req.sender === "blocked") {
            res.refuse("middleware", "you may not ask");
            return;
          }
          await next();
        },
      ],
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "blocked");

    await bus.send("a1", {
      performative: "query-if",
      sender: "blocked",
      receiver: "a1",
      content: { name: "raining" },
      timestamp: Date.now(),
    });

    await agent.tick();

    const refuse = inbox.find(
      (m) => m.performative === "refuse" && m.sender === "a1",
    );
    expect(refuse).toBeDefined();
    const content = refuse!.content as Record<string, unknown>;
    expect(content.verdict).toBe("middleware");
    expect(content.reason).toBe("you may not ask");
    // A query creates no goal, so the refusal names the question it declines.
    expect(content.name).toBe("raining");
    expect(content).not.toHaveProperty("goal");

    // The declined query answered nothing.
    expect(
      inbox.find((m) => m.performative === "inform" && m.sender === "a1"),
    ).toBeUndefined();

    await agent.stop();
  });

  it("sends not-understood for a malformed query-if", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      content: {},
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("query-if");
    expect((content.reason as string).includes("query-if")).toBe(true);

    // No goal was created.
    expect(agent.goals.all()).toHaveLength(0);

    await agent.stop();
  });

  it("sends not-understood for a malformed query-ref", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-ref",
      sender: "b",
      receiver: "a1",
      content: {},
      timestamp: Date.now(),
    });

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    const content = notUnderstood!.content as Record<string, unknown>;
    expect(content.event).toBe("query-ref");
    expect((content.reason as string).includes("query-ref")).toBe(true);

    // No goal was created.
    expect(agent.goals.all()).toHaveLength(0);

    await agent.stop();
  });

  it("answers failure, in the same exchange, when the expression throws", async () => {
    const bus = new InMemoryMessageBus();
    const expressions = new ExpressionLibrary();
    expressions.register({
      name: "room-temperature",
      evaluate: async () => {
        throw new Error("sensor offline");
      },
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      expressionLibrary: expressions,
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-ref",
      sender: "b",
      receiver: "a1",
      conversationId: "chat-3",
      replyWith: "q-3",
      content: { name: "room-temperature" },
      timestamp: Date.now(),
    });

    await agent.tick();

    // The question was read and an answer attempted, so the honest reply is
    // `failure` — not a `refuse` blaming the middleware chain.
    expect(inbox.map((m) => m.performative)).toEqual(["failure"]);
    const failure = inbox[0];
    expect(failure.conversationId).toBe("chat-3");
    expect(failure.inReplyTo).toBe("q-3");
    expect(failure.content).toEqual({
      name: "room-temperature",
      reason: 'expression "room-temperature" failed: sensor offline',
    });

    await agent.stop();
  });

  it("answers failure when a proposition throws synchronously", async () => {
    const bus = new InMemoryMessageBus();
    const propositions = new PropositionLibrary();
    propositions.register({
      name: "raining",
      evaluate: () => {
        throw new Error("no weather feed");
      },
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      propositionLibrary: propositions,
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      content: { name: "raining" },
      timestamp: Date.now(),
    });

    await agent.tick();

    expect(inbox.map((m) => m.performative)).toEqual(["failure"]);
    expect(inbox[0].content).toEqual({
      name: "raining",
      reason: 'proposition "raining" failed: no weather feed',
    });

    await agent.stop();
  });

  it("the asker understands a refusal that names its query", async () => {
    const bus = new InMemoryMessageBus();
    const propositions = new PropositionLibrary();
    propositions.register({ name: "raining", evaluate: () => true });
    const server = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      propositionLibrary: propositions,
      directiveMiddleware: [(_req, res) => res.refuse("middleware", "no")],
    });
    const asker = makeAgent("b", bus);
    const refusals: unknown[] = [];
    asker.on("goalRefused", (r) => refusals.push(r));
    const answers: Message[] = [];
    asker.on("message:sent", (m) => answers.push(m));
    await server.start();
    await asker.start();

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      replyWith: "q-4",
      content: { name: "raining" },
      timestamp: Date.now(),
    });

    await server.tick();
    await asker.tick();

    // Read as a refusal of the query it names — not as malformed.
    expect(refusals).toEqual([
      expect.objectContaining({
        agentId: "a1",
        query: "raining",
        verdict: "middleware",
        reason: "no",
        inReplyTo: "q-4",
      }),
    ]);
    expect(answers.find((m) => m.performative === "not-understood")).toBe(
      undefined,
    );

    await server.stop();
    await asker.stop();
  });
});
