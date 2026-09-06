import { describe, it, expect, vi } from "vitest";
import { BeliefBase } from "../src/core/beliefs.js";

describe("BeliefBase", () => {
  it("stores and retrieves values", () => {
    const bb = new BeliefBase();
    bb.set("weather", "sunny");
    expect(bb.get("weather")).toBe("sunny");
    expect(bb.has("weather")).toBe(true);
  });

  it("returns undefined for missing keys", () => {
    const bb = new BeliefBase();
    expect(bb.get("missing")).toBeUndefined();
    expect(bb.has("missing")).toBe(false);
  });

  it("emits beliefAdded on first set", () => {
    const bb = new BeliefBase();
    const handler = vi.fn();
    bb.on("beliefAdded", handler);

    bb.set("key1", "value1");
    expect(handler).toHaveBeenCalledWith({ key: "key1", value: "value1" });
  });

  it("emits beliefUpdated on subsequent set", () => {
    const bb = new BeliefBase();
    const addedHandler = vi.fn();
    const updatedHandler = vi.fn();
    bb.on("beliefAdded", addedHandler);
    bb.on("beliefUpdated", updatedHandler);

    bb.set("key1", "value1");
    bb.set("key1", "value2");

    expect(addedHandler).toHaveBeenCalledTimes(1);
    expect(updatedHandler).toHaveBeenCalledWith({
      key: "key1",
      value: "value2",
      previousValue: "value1",
    });
  });

  it("emits beliefRemoved", () => {
    const bb = new BeliefBase();
    const handler = vi.fn();
    bb.set("key1", "value1");
    bb.on("beliefRemoved", handler);

    bb.remove("key1");
    expect(handler).toHaveBeenCalledWith({ key: "key1", value: "value1" });
    expect(bb.has("key1")).toBe(false);
  });

  it("remove returns false for missing key", () => {
    const bb = new BeliefBase();
    expect(bb.remove("missing")).toBe(false);
  });

  it("queryByPrefix finds matching keys", () => {
    const bb = new BeliefBase();
    bb.set("msg.sender", "alice");
    bb.set("msg.text", "hello");
    bb.set("other", "nope");

    const results = bb.queryByPrefix("msg.");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.key).sort()).toEqual([
      "msg.sender",
      "msg.text",
    ]);
  });

  it("query finds by predicate", () => {
    const bb = new BeliefBase();
    bb.set("a", 10);
    bb.set("b", 20);
    bb.set("c", 5);

    const results = bb.query((_key, value) => (value as number) > 8);
    expect(results).toHaveLength(2);
  });

  it("supports nested objects", () => {
    const bb = new BeliefBase();
    const nested = { a: { b: { c: 42 } } };
    bb.set("config", nested);
    expect(bb.get("config")).toEqual(nested);
  });

  it("clear removes all beliefs", () => {
    const bb = new BeliefBase();
    bb.set("a", 1);
    bb.set("b", 2);
    bb.clear();
    expect(bb.all()).toEqual({});
  });
});
