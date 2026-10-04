import { describe, expect, it } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent, PlanLibrary } from "../src/core/index.js";
import {
  validateContent,
  schemaViolationReason,
  isKnownPerformative,
  validateAssertionContent,
  assertionStateReason,
  parseAssertionState,
} from "../src/bus/schemas.js";

function makeAgent(id: string, bus: InMemoryMessageBus): Agent {
  const lib = new PlanLibrary();
  lib.register({
    name: "do-fetch",
    can: "fetchData",
    trigger: () => false,
    body: [],
  });
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

  it("rejects a refuse missing the required goal", () => {
    expect(validateContent("refuse", { verdict: "capacity" })).toBe(false);
    expect(validateContent("refuse", {})).toBe(false);
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
    for (const p of ["sorry", "promise"] as const) {
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

  it("accepts a well-formed query-if", () => {
    expect(validateContent("query-if", { key: "temp", proposition: true })).toBe(
      true,
    );
  });

  it("rejects a query-if missing the required key", () => {
    expect(validateContent("query-if", {})).toBe(false);
    expect(validateContent("query-if", { value: 42 })).toBe(false);
  });

  it("rejects a query-if with a non-string key", () => {
    expect(validateContent("query-if", { key: 42 })).toBe(false);
  });

  it("accepts a well-formed query-ref", () => {
    expect(
      validateContent("query-ref", { key: "person", expression: { name: "a" } }),
    ).toBe(true);
  });

  it("rejects a query-ref missing the required fields", () => {
    expect(validateContent("query-ref", {})).toBe(false);
    expect(validateContent("query-ref", { result: "某人" })).toBe(false);
  });

  it("produces a readable violation reason for query-if", () => {
    const reason = schemaViolationReason("query-if", {});
    expect(reason).toContain("key");
    expect(reason).toContain("query-if");
  });

  it("produces a readable violation reason for query-ref", () => {
    const reason = schemaViolationReason("query-ref", {});
    expect(reason).toContain("key");
    expect(reason).toContain("query-ref");
  });
});

describe("isKnownPerformative", () => {
  it("recognises every FIPA-ACL performative", () => {
    for (const p of [
      "inform" as const,
      "confirm",
      "disconfirm",
      "request",
      "agree",
      "refuse",
      "failure",
      "not-understood",
      "declare",
      "cancel",
      "subscribe",
      "query-if-known",
      "accept-proposal",
      "reject-proposal",
      "promise",
      "commit",
    ]) {
      expect(isKnownPerformative(p), p).toBe(true);
    }
  });

  it("recognises legacy performatives", () => {
    expect(isKnownPerformative("achieve")).toBe(true);
    expect(isKnownPerformative("query")).toBe(true);
  });

  it("validates assertion content and allows an explicit state", () => {
    expect(
      validateAssertionContent("inform", { temp: 22, state: "positive" }),
    ).toBe(true);
    expect(
      validateAssertionContent("inform", { temp: 22, state: "uncertain" }),
    ).toBe(true);
    expect(
      validateAssertionContent("inform", { temp: 22, state: "negative" }),
    ).toBe(true);
    expect(validateAssertionContent("confirm", { goal: "x" })).toBe(true);
    expect(validateAssertionContent("disconfirm", { goal: "x" })).toBe(true);
  });

  it("rejects an assertion with an invalid state", () => {
    expect(
      validateAssertionContent("inform", { temp: 22, state: "maybe" }),
    ).toBe(false);
    expect(
      validateAssertionContent("inform", { temp: 22, state: "true" }),
    ).toBe(false);
    expect(validateAssertionContent("inform", { temp: 22, state: "yes" })).toBe(
      false,
    );
    expect(validateAssertionContent("confirm", { goal: "x", state: "" })).toBe(
      false,
    );
  });

  it("passes assertion validation for performatives that do not carry a state", () => {
    expect(validateAssertionContent("failure", { goal: "fetch" })).toBe(true);
    expect(
      validateAssertionContent("not-understood", { event: "request" }),
    ).toBe(true);
    expect(validateAssertionContent("declare", { recorded: true })).toBe(true);
  });

  it("produces a readable reason for an invalid state", () => {
    const reason = assertionStateReason({
      temp: 22,
      state: "maybe" as unknown as "positive",
    });
    expect(reason).toContain("state");
  });

  it("returns an empty reason when the state is valid", () => {
    expect(assertionStateReason({ temp: 22, state: "positive" })).toBe("");
    expect(assertionStateReason({ temp: 22 })).toBe("");
  });

  it("parses the explicit state from assertion content", () => {
    expect(
      parseAssertionState("inform", { temp: 22, state: "uncertain" }),
    ).toBe("uncertain");
    expect(parseAssertionState("inform", { temp: 22, state: "negative" })).toBe(
      "negative",
    );
    expect(parseAssertionState("inform", { temp: 22 })).toBeUndefined();
    expect(parseAssertionState("confirm", { goal: "x" })).toBeUndefined();
  });

  it("returns undefined for performatives that do not carry a state", () => {
    expect(parseAssertionState("failure", { goal: "fetch" })).toBeUndefined();
    expect(
      parseAssertionState("not-understood", { event: "request" }),
    ).toBeUndefined();
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
      name: "do-fetch",
      can: "fetchData",
      trigger: () => false,
      body: [],
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

    // The goal was admitted.
    expect(agent.goals.all()).toHaveLength(1);

    await agent.stop();
  });

  it("sends not-understood when middleware cannot repair the content", async () => {
    const bus = new InMemoryMessageBus();
    const lib = new PlanLibrary();
    lib.register({
      name: "do-fetch",
      can: "fetchData",
      trigger: () => false,
      body: [],
    });
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

describe("query-if and query-ref as unsupported directives", () => {
  it("refuses a well-formed query-if with unsupported", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      content: { key: "temp", proposition: true },
      timestamp: Date.now(),
    });

    await agent.tick();

    const refuse = inbox.find(
      (m) => m.performative === "refuse" && m.sender === "a1",
    );
    expect(refuse).toBeDefined();
    const content = refuse!.content as Record<string, unknown>;
    // No goal field in query-if content, so the refusal carries an empty goal.
    expect(content.goal).toBe("");
    expect(content.verdict).toBe("unsupported");
    expect(content.reason).toBe('this agent does not implement "query-if"');

    // No goal was created.
    expect(agent.goals.all()).toHaveLength(0);

    await agent.stop();
  });

  it("refuses a well-formed query-ref with unsupported", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-ref",
      sender: "b",
      receiver: "a1",
      content: { key: "person", expression: { name: "a" } },
      timestamp: Date.now(),
    });

    await agent.tick();

    const refuse = inbox.find(
      (m) => m.performative === "refuse" && m.sender === "a1",
    );
    expect(refuse).toBeDefined();
    const content = refuse!.content as Record<string, unknown>;
    expect(content.goal).toBe("");
    expect(content.verdict).toBe("unsupported");
    expect(content.reason).toBe('this agent does not implement "query-ref"');

    // No goal was created.
    expect(agent.goals.all()).toHaveLength(0);

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

    // No goal was created.
    expect(agent.goals.all()).toHaveLength(0);

    await agent.stop();
  });

  it("allows middleware to enrich query-if into a request", async () => {
    const bus = new InMemoryMessageBus();
    const lib = new PlanLibrary();
    lib.register({
      name: "do-fetch",
      can: "fetchData",
      trigger: () => false,
      body: [],
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: lib,
      directiveMiddleware: [
        async (req, _res, next) => {
          const content = req.content as Record<string, unknown> | undefined;
          if (req.performative === "query-if" && typeof content?.key === "string") {
            req.content = { ...content, goal: "fetchData" };
          }
          await next();
        },
      ],
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-if",
      sender: "b",
      receiver: "a1",
      content: { key: "temp", proposition: true },
      timestamp: Date.now(),
    });

    await agent.tick();

    // No refusal — middleware enriched it into a request.
    const refuse = inbox.find(
      (m) => m.performative === "refuse" && m.sender === "a1",
    );
    expect(refuse).toBeUndefined();

    // The goal was admitted.
    expect(agent.goals.all()).toHaveLength(1);

    await agent.stop();
  });

  it("allows middleware to enrich query-ref into a request", async () => {
    const bus = new InMemoryMessageBus();
    const lib = new PlanLibrary();
    lib.register({
      name: "do-fetch",
      can: "fetchData",
      trigger: () => false,
      body: [],
    });
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: lib,
      directiveMiddleware: [
        async (req, _res, next) => {
          const content = req.content as Record<string, unknown> | undefined;
          if (req.performative === "query-ref" && typeof content?.key === "string") {
            req.content = { ...content, goal: "fetchData" };
          }
          await next();
        },
      ],
    });
    await agent.start();

    const inbox = collectFromAgent(bus, "b");

    await bus.send("a1", {
      performative: "query-ref",
      sender: "b",
      receiver: "a1",
      content: { key: "person", expression: { name: "a" } },
      timestamp: Date.now(),
    });

    await agent.tick();

    // No refusal — middleware enriched it into a request.
    const refuse = inbox.find(
      (m) => m.performative === "refuse" && m.sender === "a1",
    );
    expect(refuse).toBeUndefined();

    // The goal was admitted.
    expect(agent.goals.all()).toHaveLength(1);

    await agent.stop();
  });
});
