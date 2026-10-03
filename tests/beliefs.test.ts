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
    expect(handler).toHaveBeenCalledWith({
      key: "key1",
      value: "value1",
      status: "positive",
    });
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
      status: "positive",
      previousStatus: "positive",
    });
  });

  it("emits beliefRemoved", () => {
    const bb = new InMemoryBeliefBase();
    const handler = vi.fn();
    bb.set("key1", "value1");
    bb.on("beliefRemoved", handler);

    bb.remove("key1");
    // No `status` on the removal — once the key is gone there is no position to
    // report, only what was there before it went.
    expect(handler).toHaveBeenCalledWith({
      key: "key1",
      value: "value1",
      previousStatus: "positive",
    });
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
      status: "positive",
      previousStatus: "positive",
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

describe("BeliefStatus", () => {
  it("defaults an ordinary write to true", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("k", 1);
    expect(bb.statusOf("k")).toBe("positive");
  });

  it("returns undefined for a key it does not hold", () => {
    const bb = new InMemoryBeliefBase();
    expect(bb.statusOf("missing")).toBeUndefined();
  });

  it("stores an explicit status beside the value", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("k", 1, "negative");
    expect(bb.statusOf("k")).toBe("negative");
    expect(bb.get("k")).toBe(1);
  });

  it("keeps get and all returning bare values, not envelopes", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("a", 1, "negative");
    bb.set("b", { nested: true });
    // The envelope is the store's business. A caller wanting polarity asks
    // statusOf, and a caller reading values gets what it always got.
    expect(bb.get("a")).toBe(1);
    expect(bb.all()).toEqual({ a: 1, b: { nested: true } });
  });

  it("changes status without touching the value", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("k", 1);
    expect(bb.setStatus("k", "uncertain")).toBe(true);
    expect(bb.statusOf("k")).toBe("uncertain");
    expect(bb.get("k")).toBe(1);
  });

  it("reports setStatus on a missing key rather than inventing one", () => {
    const bb = new InMemoryBeliefBase();
    expect(bb.setStatus("missing", "negative")).toBe(false);
    expect(bb.has("missing")).toBe(false);
  });

  it("makes uncertain reachable, which no performative produces", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("k", 1, "uncertain");
    expect(bb.statusOf("k")).toBe("uncertain");
    // Uncertain is a position, not an absence: the key is still held.
    expect(bb.has("k")).toBe(true);
  });

  it("gives status to query results", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("msg.a", 1);
    bb.set("msg.b", 2, "negative");
    expect(bb.queryByPrefix("msg.").map((r) => [r.key, r.status])).toEqual([
      ["msg.a", "positive"],
      ["msg.b", "negative"],
    ]);
  });

  it("passes status to a query predicate", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("a", 1);
    bb.set("b", 2, "negative");
    bb.set("c", 3, "uncertain");

    expect(
      bb.query((_k, _v, status) => status !== "positive").map((r) => r.key),
    ).toEqual(["b", "c"]);
  });

  it("keeps a two-argument query predicate working", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("a", 1);
    bb.set("b", 2, "negative");
    // Written against the older signature; it should still typecheck and run.
    expect(bb.query((k, v) => v === 2).map((r) => r.key)).toEqual(["b"]);
  });

  it("carries status through compareAndSet", async () => {
    const bb = new InMemoryBeliefBase();
    bb.set("k", 1);
    expect(await bb.compareAndSet("k", 1, 2, "negative")).toBe(true);
    expect(bb.statusOf("k")).toBe("negative");
    expect(bb.get("k")).toBe(2);
  });

  it("compares values, not envelopes, so CAS still matches", async () => {
    const bb = new InMemoryBeliefBase();
    bb.set("k", 1, "negative");
    // Matching on the value a caller can see, even though the store holds more.
    expect(await bb.compareAndSet("k", 1, 2)).toBe(true);
    expect(bb.statusOf("k")).toBe("positive");
  });

  it("removes the status along with the value", () => {
    const bb = new InMemoryBeliefBase();
    bb.set("k", 1, "negative");
    expect(bb.remove("k")).toBe(true);
    expect(bb.statusOf("k")).toBeUndefined();
    expect(bb.has("k")).toBe(false);
  });

  it("warns in its docs that every status is truthy", () => {
    // Not a runtime assertion: these are non-empty strings, so a truthiness test
    // is always true. The union type is the guard, and this test exists so the
    // fact stays written down next to the behaviour it warns about. The names
    // being non-boolean makes it easier to get wrong, not harder — nothing about
    // "positive"/"negative" suggests falsiness.
    expect("negative").toBeTruthy();
    expect(Boolean("uncertain")).toBe(true);
  });
});
