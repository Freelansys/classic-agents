import { describe, expect, it } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent, PlanLibrary } from "../src/core/index.js";
import type { MessageRejected } from "../src/core/index.js";
import { envelopeSender, envelopeViolationReason } from "../src/bus/schemas.js";

function makeAgent(id: string, bus: InMemoryMessageBus): Agent {
  return new Agent({ id, bus, planLibrary: new PlanLibrary() });
}

describe("envelopeViolationReason", () => {
  it("accepts a well-formed message", () => {
    expect(
      envelopeViolationReason({
        performative: "inform",
        sender: "a",
        content: {},
        timestamp: Date.now(),
      }),
    ).toBeUndefined();
  });

  it("accepts a message with no timestamp — it is a library extension, not FIPA", () => {
    expect(
      envelopeViolationReason({
        performative: "inform",
        sender: "a",
        content: {},
      }),
    ).toBeUndefined();
  });

  it("rejects a message with no sender, naming the field", () => {
    const reason = envelopeViolationReason({
      performative: "inform",
      content: {},
    });
    expect(reason).toContain("malformed envelope");
    expect(reason).toContain("sender");
  });

  it("rejects a message with no performative", () => {
    const reason = envelopeViolationReason({ sender: "a", content: {} });
    expect(reason).toContain("performative");
  });

  it("rejects a field of the wrong type", () => {
    const reason = envelopeViolationReason({
      performative: "inform",
      sender: "a",
      replyWith: 123,
      content: {},
    });
    expect(reason).toContain("replyWith");
  });

  it("rejects a non-object", () => {
    expect(envelopeViolationReason(null)).toContain("malformed envelope");
    expect(envelopeViolationReason("hello")).toContain("malformed envelope");
  });
});

describe("envelopeSender", () => {
  it("returns a non-empty string sender", () => {
    expect(envelopeSender({ sender: "a" })).toBe("a");
  });

  it("returns undefined for a missing, empty or non-string sender", () => {
    expect(envelopeSender({})).toBeUndefined();
    expect(envelopeSender({ sender: "" })).toBeUndefined();
    expect(envelopeSender({ sender: 42 })).toBeUndefined();
    expect(envelopeSender(null)).toBeUndefined();
  });
});

describe("incoming envelope validation", () => {
  it("processes a message with no timestamp normally", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    // A peer speaking only FIPA sends no `timestamp`; the message is still
    // read, believed, and answered nothing.
    await bus.send("a1", {
      performative: "inform",
      sender: "b",
      receiver: "a1",
      content: { temperature: 5 },
    });

    await agent.tick();

    expect(agent.beliefs.get("msg.temperature")).toBe(5);

    await agent.stop();
  });

  it("answers not-understood when a malformed envelope has a usable sender", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");
    const rejected: MessageRejected[] = [];
    agent.on("message:rejected", (e) => rejected.push(e));

    // A usable sender, but `timestamp` is the wrong type: the envelope cannot
    // be trusted, so the message is not reasoned about.
    await bus.send("a1", {
      performative: "inform",
      sender: "b",
      receiver: "a1",
      content: { temperature: 5 },
      timestamp: "not-a-number",
    } as unknown as Message);

    await agent.tick();

    const notUnderstood = inbox.find(
      (m) => m.performative === "not-understood" && m.sender === "a1",
    );
    expect(notUnderstood).toBeDefined();
    expect((notUnderstood!.content as { reason: string }).reason).toContain(
      "malformed envelope",
    );

    // The message was not believed, and the refusal is on the agent's own
    // stream as well as on the wire.
    expect(agent.beliefs.get("msg.temperature")).toBeUndefined();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].agentId).toBe("a1");

    await agent.stop();
  });

  it("reports locally and sends nothing when a malformed envelope has no usable sender", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");
    const rejected: MessageRejected[] = [];
    agent.on("message:rejected", (e) => rejected.push(e));

    await bus.send("a1", {
      performative: "inform",
      content: { temperature: 5 },
    } as unknown as Message);

    await agent.tick();

    // There is nobody to answer, so the drop is reported locally only.
    expect(inbox).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("malformed envelope");
    expect(agent.beliefs.get("msg.temperature")).toBeUndefined();

    await agent.stop();
  });

  it("reports a message whose sender is not a string locally", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const inbox = collectFromAgent(bus, "b");
    const rejected: MessageRejected[] = [];
    agent.on("message:rejected", (e) => rejected.push(e));

    await bus.send("a1", {
      performative: "inform",
      sender: 42,
      receiver: "a1",
      content: { temperature: 5 },
    } as unknown as Message);

    await agent.tick();

    expect(inbox).toHaveLength(0);
    expect(rejected).toHaveLength(1);

    await agent.stop();
  });

  it("does not answer a malformed message it sent itself", async () => {
    const bus = new InMemoryMessageBus();
    const agent = makeAgent("a1", bus);
    await agent.start();

    const rejected: MessageRejected[] = [];
    agent.on("message:rejected", (e) => rejected.push(e));

    await bus.send("a1", {
      performative: "inform",
      sender: "a1",
      receiver: "a1",
      content: { temperature: 5 },
      replyWith: 123,
    } as unknown as Message);

    await agent.tick();

    const inbox = collectFromAgent(bus, "a1");
    expect(inbox).toHaveLength(0);
    expect(rejected).toHaveLength(1);

    await agent.stop();
  });
});

function collectFromAgent(bus: InMemoryMessageBus, id: string): Message[] {
  const messages: Message[] = [];
  bus.registerAgent(id, (m) => messages.push(m));
  return messages;
}
