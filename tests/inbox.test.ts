import { describe, expect, it } from "vitest";
import { Inbox, DEFAULT_MAX_INBOX_ENTRIES } from "../src/core/inbox.js";
import type { Message } from "../src/bus/types.js";

const inform = (sender: string, content: unknown): Message => ({
  performative: "inform",
  sender,
  content,
  timestamp: Date.now(),
});

describe("Inbox", () => {
  it("holds delivered messages until they are perceived", () => {
    const inbox = new Inbox();
    inbox.push(inform("a", { x: 1 }));

    expect(inbox.size()).toBe(1);
    expect(inbox.empty).toBe(false);
    expect(inbox.peek()).toHaveLength(1);

    const drained = inbox.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].message.sender).toBe("a");
    expect(inbox.size()).toBe(0);
    expect(inbox.empty).toBe(true);
  });

  it("leaves the inbox alone when only peeked at", () => {
    const inbox = new Inbox();
    inbox.push(inform("a", { x: 1 }));

    inbox.peek();
    inbox.peek();

    expect(inbox.size()).toBe(1);
  });

  it("drains empty without allocating", () => {
    const inbox = new Inbox();
    expect(inbox.drain()).toEqual([]);
  });

  it("gives arrival order, even within a single millisecond", () => {
    const inbox = new Inbox();
    inbox.push(inform("a", {}));
    inbox.push(inform("b", {}));
    inbox.push(inform("c", {}));

    // Delivery order is the contract: two messages stamped in the same
    // millisecond must still be totally ordered.
    expect(inbox.drain().map((e) => e.message.sender)).toEqual(["a", "b", "c"]);
    const sequences = inbox.peek();
    expect(sequences).toHaveLength(0);
  });

  it("gives strictly increasing sequence numbers", () => {
    const inbox = new Inbox();
    for (let i = 0; i < 5; i++) {
      inbox.push(inform("a", {}));
    }

    const sequences = inbox.drain().map((e) => e.sequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
  });

  it("stamps every entry with an arrival time", () => {
    const inbox = new Inbox();
    const before = Date.now();
    inbox.push(inform("a", {}));

    expect(inbox.drain()[0].receivedAt).toBeGreaterThanOrEqual(before);
  });

  it("carries the message through unaltered", () => {
    const inbox = new Inbox();
    const msg = inform("scout", { lead: "l-42" });
    inbox.push(msg);

    // The envelope adds ordering and nothing else: what the bus delivered is
    // what the receiver perceives, references and all.
    expect(inbox.drain()[0].message).toBe(msg);
  });
});

describe("Inbox overflow", () => {
  it("drops the oldest, since a newer assertion supersedes it", () => {
    const inbox = new Inbox(2);
    inbox.push(inform("a", { v: 1 }));
    inbox.push(inform("b", { v: 2 }));
    inbox.push(inform("c", { v: 3 }));

    expect(inbox.drain().map((e) => e.message.sender)).toEqual(["b", "c"]);
    expect(inbox.dropped).toBe(1);
  });

  it("counts every drop, so a gap is never mistaken for quiet", () => {
    const inbox = new Inbox(1);
    for (let i = 0; i < 5; i++) {
      inbox.push(inform("a", {}));
    }

    expect(inbox.dropped).toBe(4);
  });

  it("never exceeds its capacity", () => {
    const inbox = new Inbox(3);
    for (let i = 0; i < 100; i++) {
      inbox.push(inform("a", {}));
      expect(inbox.size()).toBeLessThanOrEqual(3);
    }
  });

  it("keeps the bound before the overflow, so the first N all land", () => {
    const inbox = new Inbox(3);
    for (let i = 0; i < 3; i++) {
      inbox.push(inform("a", {}));
    }

    expect(inbox.dropped).toBe(0);
    expect(inbox.size()).toBe(3);
  });

  it("treats 0 and Infinity as unbounded", () => {
    for (const max of [0, Infinity]) {
      const inbox = new Inbox(max);
      expect(inbox.capacity).toBe(Infinity);
      for (let i = 0; i < DEFAULT_MAX_INBOX_ENTRIES + 10; i++) {
        inbox.push(inform("a", {}));
      }
      expect(inbox.dropped).toBe(0);
    }
  });

  it("rejects a bound that is neither unbounded nor a positive integer", () => {
    for (const max of [-1, 1.5, NaN]) {
      expect(() => new Inbox(max)).toThrow(/maxInboxSize/);
    }
  });

  it("defaults to a bound", () => {
    expect(new Inbox().capacity).toBe(DEFAULT_MAX_INBOX_ENTRIES);
  });
});

describe("Inbox.clear", () => {
  it("discards unperceived messages without counting them as dropped", () => {
    const inbox = new Inbox();
    inbox.push(inform("a", {}));
    inbox.clear();

    expect(inbox.size()).toBe(0);
    // A deliberate discard is not overflow, so it must not look like a gap a
    // monitor has to account for.
    expect(inbox.dropped).toBe(0);
  });
});
