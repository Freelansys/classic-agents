import type { Message } from "../bus/types.js";

/**
 * A message waiting to be perceived.
 *
 * The message is the one the bus delivered, unaltered; the envelope adds only
 * what perception needs to order by — when it arrived and in what sequence.
 */
export interface InboxEntry {
  /** The message as delivered. */
  readonly message: Message;
  /** `Date.now()` at the moment the bus handed it over. */
  readonly receivedAt: number;
  /** Arrival order, strictly increasing. Ties in `receivedAt` break here. */
  readonly sequence: number;
}

/**
 * Default bound on unperceived messages.
 *
 * Percepts are transient — the cycle drains the inbox every tick — so this
 * only bites an agent that is not ticking: stopped, or busy behind an action
 * that has not returned. A bounded inbox turns that stall into visible
 * backpressure rather than unbounded growth.
 */
export const DEFAULT_MAX_INBOX_ENTRIES = 1000;

/**
 * A message's arrival order, and the sequence number it arrived at.
 *
 * `receivedAt` has millisecond resolution, so two messages delivered in the
 * same tick would otherwise be indistinguishable; `sequence` is the tiebreak
 * that makes perception order total.
 */
let inboxSequence = 0;

/** Resets the inbox arrival counter. Exposed for deterministic tests. */
export function resetInboxSequence(): void {
  inboxSequence = 0;
}

/**
 * The queue of messages a bus has delivered but the reasoning cycle has not
 * yet perceived.
 *
 * Separate from the belief base on purpose. A message is an *event*: it
 * happened, at a time, from a sender. A belief is a state the agent currently
 * holds. Folding the first into the second at delivery time is what makes an
 * agent treat every assertion it hears as true — so the inbox holds the event
 * until a cycle decides what, if anything, to believe.
 *
 * Bounded, oldest-first on overflow: an assertion is superseded by a later
 * assertion about the same proposition, so when the inbox is full the stale one
 * is the one to lose. {@link dropped} counts what was lost, because a silent
 * drop would be indistinguishable from quiet delivery.
 */
export class Inbox {
  private readonly entries: InboxEntry[] = [];
  private droppedCount = 0;
  private readonly maxEntries: number;

  /**
   * @param maxEntries Unperceived messages held before the oldest are dropped.
   *   `0` or `Infinity` means unbounded, which is safe only for an agent
   *   guaranteed to tick.
   */
  constructor(maxEntries: number = DEFAULT_MAX_INBOX_ENTRIES) {
    this.maxEntries = resolveMaxInboxEntries(maxEntries);
  }

  /**
   * Accepts a message from the bus, dropping the oldest if the inbox is full.
   *
   * Never throws and never blocks: delivery happens inside the bus's own
   * callback, where an exception would surface as an unhandled rejection on a
   * transport's socket rather than as a failed send.
   */
  push(message: Message): void {
    const entry: InboxEntry = {
      message,
      receivedAt: Date.now(),
      sequence: inboxSequence++,
    };

    if (this.entries.length >= this.maxEntries) {
      this.entries.shift();
      this.droppedCount++;
    }

    this.entries.push(entry);
  }

  /** Takes every unperceived message and empties the inbox, oldest first. */
  drain(): InboxEntry[] {
    if (this.entries.length === 0) {
      return [];
    }
    const drained = this.entries.splice(0, this.entries.length);
    return drained;
  }

  /** Every unperceived message, oldest first. The inbox itself is unchanged. */
  peek(): readonly InboxEntry[] {
    return this.entries;
  }

  /** Unperceived messages held. */
  size(): number {
    return this.entries.length;
  }

  /** Whether a message is waiting to be perceived. */
  get empty(): boolean {
    return this.entries.length === 0;
  }

  /** Messages dropped because the inbox was full, since construction. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** The bound this inbox was built with; `Infinity` when unbounded. */
  get capacity(): number {
    return this.maxEntries;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Resolves a configured bound to the inbox's internal capacity: `0` and
 * `Infinity` both mean unbounded, and anything else must be a positive
 * integer rather than being silently clamped.
 */
function resolveMaxInboxEntries(value: number): number {
  if (value === 0 || value === Infinity) {
    return Infinity;
  }
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(
    `maxInboxSize must be 0 (unbounded), Infinity, or a positive integer; got ${value}`,
  );
}
