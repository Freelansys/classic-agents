import { describe, it, expect, vi } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/types.js";

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    performative: "inform",
    sender: "agent-a",
    content: { text: "hello" },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("InMemoryMessageBus", () => {
  it("delivers pub/sub messages to all subscribers", async () => {
    const bus = new InMemoryMessageBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.subscribe("weather", handler1);
    bus.subscribe("weather", handler2);

    const msg = makeMsg({ topic: "weather" });
    await bus.publish("weather", msg);

    expect(handler1).toHaveBeenCalledWith(msg);
    expect(handler2).toHaveBeenCalledWith(msg);
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new InMemoryMessageBus();
    const handler = vi.fn();

    const unsub = bus.subscribe("topic", handler);
    unsub();

    await bus.publish("topic", makeMsg());
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers point-to-point messages to the correct agent", async () => {
    const bus = new InMemoryMessageBus();
    const inboxA = vi.fn();
    const inboxB = vi.fn();

    bus.registerAgent("agent-a", inboxA);
    bus.registerAgent("agent-b", inboxB);

    const msg = makeMsg({ receiver: "agent-b" });
    await bus.send("agent-b", msg);

    expect(inboxB).toHaveBeenCalledWith(msg);
    expect(inboxA).not.toHaveBeenCalled();
  });

  it("send to unregistered agent is a no-op", async () => {
    const bus = new InMemoryMessageBus();
    // Should not throw
    await bus.send("nonexistent", makeMsg());
  });

  it("supports multiple subscribers on the same topic", async () => {
    const bus = new InMemoryMessageBus();
    const results: string[] = [];

    bus.subscribe("events", () => results.push("a"));
    bus.subscribe("events", () => results.push("b"));
    bus.subscribe("events", () => results.push("c"));

    await bus.publish("events", makeMsg());

    expect(results).toEqual(["a", "b", "c"]);
  });
});
