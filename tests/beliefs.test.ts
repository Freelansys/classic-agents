import { describe, it, expect, vi } from "vitest";
import { InMemoryBeliefBase, casUpdate } from "../src/core/beliefs.js";

describe("InMemoryBeliefBase", () => {
  it("stores and retrieves values", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("weather", "sunny");
    expect(bb.get("weather")).toBe("sunny");
    expect(bb.has("weather")).toBe(true);
  });

  it("returns undefined for missing keys", () => {
    const bb = new InMemoryBeliefBase();
    expect(bb.get("missing")).toBeUndefined();
    expect(bb.has("missing")).toBe(false);
  });

  it("emits beliefAdded on first set", () => {
    const bb = new InMemoryBeliefBase();
    const handler = vi.fn();
    bb.on("beliefAdded", handler);

    bb.set("key1", "value1");
    expect(handler).toHaveBeenCalledWith({ key: "key1", value: "value1" });
  });

  it("emits beliefUpdated on subsequent set", () => {
    const bb = new InMemoryBeliefBase();
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
    const bb = new InMemoryBeliefBase();
    const handler = vi.fn();
    bb.set("key1", "value1");
    bb.on("beliefRemoved", handler);

    bb.remove("key1");
    expect(handler).toHaveBeenCalledWith({ key: "key1", value: "value1" });
    expect(bb.has("key1")).toBe(false);
  });

  it("remove returns false for missing key", () => {
    const bb = new InMemoryBeliefBase();
    expect(bb.remove("missing")).toBe(false);
  });

  it("queryByPrefix finds matching keys", () => {
    const bb = new InMemoryBeliefBase();
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
    const bb = new InMemoryBeliefBase();
    bb.set("a", 10);
    bb.set("b", 20);
    bb.set("c", 5);

    const results = bb.query((_key, value) => (value as number) > 8);
    expect(results).toHaveLength(2);
  });

  it("supports nested objects", () => {
    const bb = new InMemoryBeliefBase();
    const nested = { a: { b: { c: 42 } } };
    bb.set("config", nested);
    expect(bb.get("config")).toEqual(nested);
  });

  it("clear removes all beliefs", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("a", 1);
    bb.set("b", 2);
    bb.clear();
    expect(bb.all()).toEqual({});
  });

  it("compareAndSet succeeds when current value matches", async () => {
    const bb = new InMemoryBeliefBase();
    bb.set("counter", 1);

    const ok = await bb.compareAndSet("counter", 1, 2);
    expect(ok).toBe(true);
    expect(bb.get("counter")).toBe(2);
  });

  it("compareAndSet fails when current value differs and leaves it untouched", async () => {
    const bb = new InMemoryBeliefBase();
    bb.set("counter", 1);

    const ok = await bb.compareAndSet("counter", 99, 2);
    expect(ok).toBe(false);
    expect(bb.get("counter")).toBe(1);
  });

  it("compareAndSet with expected undefined succeeds only when key is absent", async () => {
    const bb = new InMemoryBeliefBase();

    const ok = await bb.compareAndSet("fresh", undefined, "seed");
    expect(ok).toBe(true);
    expect(bb.get("fresh")).toBe("seed");

    const again = await bb.compareAndSet("fresh", undefined, "other");
    expect(again).toBe(false);
    expect(bb.get("fresh")).toBe("seed");
  });

  it("compareAndSet uses deep equality for object values", async () => {
    const bb = new InMemoryBeliefBase();
    bb.set("config", { a: { b: 42 } });

    const ok = await bb.compareAndSet(
      "config",
      { a: { b: 42 } },
      { a: { b: 43 } },
    );
    expect(ok).toBe(true);
    expect(bb.get("config")).toEqual({ a: { b: 43 } });

    const mismatch = await bb.compareAndSet("config", { a: { b: 42 } }, "nope");
    expect(mismatch).toBe(false);
    expect(bb.get("config")).toEqual({ a: { b: 43 } });
  });

  it("compareAndSet emits belief events on success", async () => {
    const bb = new InMemoryBeliefBase();
    const updated = vi.fn();
    bb.on("beliefUpdated", updated);

    bb.set("k", "v1");
    const ok = await bb.compareAndSet("k", "v1", "v2");
    expect(ok).toBe(true);
    expect(updated).toHaveBeenCalledWith({
      key: "k",
      value: "v2",
      previousValue: "v1",
    });
  });

  it("update applies a reducer to the stored value", async () => {
    const bb = new InMemoryBeliefBase();
    bb.set("counter", 1);

    const ok = await bb.update<number>("counter", (n) => (n ?? 0) + 1);
    expect(ok).toBe(true);
    expect(bb.get("counter")).toBe(2);
  });

  it("update initializes an absent key", async () => {
    const bb = new InMemoryBeliefBase();

    const ok = await bb.update<number>("fresh", (n) => (n ?? 0) + 1);
    expect(ok).toBe(true);
    expect(bb.get("fresh")).toBe(1);
  });

  it("casUpdate is shared by backends implementing get + compareAndSet", async () => {
    const bb = new InMemoryBeliefBase();
    bb.set("k", "a");

    const ok = await casUpdate(bb, "k", (cur) => `${cur}b`);
    expect(ok).toBe(true);
    expect(bb.get("k")).toBe("ab");
  });
});
