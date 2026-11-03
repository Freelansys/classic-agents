import { EventEmitter } from "node:events";
import * as sortedBtree from "sorted-btree";

// sorted-btree is CommonJS with its class on `exports.default`. Node's ESM
// loader hands that whole `exports` object over as the default import, while a
// bundler unwraps it, so take the class from wherever it ended up.
const BTree: typeof sortedBtree.default =
  (sortedBtree.default as unknown as { default?: typeof sortedBtree.default })
    .default ?? sortedBtree.default;

export type BeliefEvent = "beliefAdded" | "beliefUpdated" | "beliefRemoved";

/**
 * How the agent stands toward a belief.
 *
 * The store keeps this beside the value and does not interpret either. The
 * words are deliberately *not* `"true"`/`"false"`: those would assert that the
 * content is a truth-apt proposition with a truth value, which is a claim about
 * the user's ontology that this library has no standing to make. A key and value
 * might denote a proposition, or a measurement, or a reading that is simply
 * wrong — the store holds all three identically.
 *
 * What it does record is the stance a performative establishes. `inform` and
 * `confirm` assert the content, so the receiver holds it `"positively"`.
 * `disconfirm` asserts its negation, so it is held `"negatively"`. Reading
 * "negative" as *not p* needs an ontology, and that stays with the user:
 * classic-agents knows the sender took the opposite stance, not what the
 * opposite of `temp: 22` happens to be.
 *
 * `"negative"` is a position, which absence is not. `statusOf` returning
 * `undefined` means no position is held at all; `"negative"` means one was
 * taken. That distinction is the reason a `disconfirm` leaves its key in place
 * rather than removing it.
 *
 * **A trap worth naming:** these are non-empty strings, so every one of them is
 * truthy, `"negative"` included. `if (store.statusOf(key))` is therefore always
 * true. Compare against the value, and let the union type's exhaustiveness
 * catch the rest. The non-boolean names make this easier to get wrong, not
 * harder, since nothing about `"positive"`/`"negative"` suggests falsiness.
 *
 * Nothing in the protocol produces `"uncertain"` on its own: FIPA has no
 * performative that conveys a receiver's uncertainty *to* someone, since
 * uncertainty is a state of the receiver rather than a claim about the world.
 * It is representable so a plan can mark what it does not yet know.
 */
export type BeliefStatus = "positive" | "uncertain" | "negative";

/** What the store holds per key: a value, and how firmly it is held. */
interface BeliefEntry {
  value: unknown;
  status: BeliefStatus;
}

export interface BeliefChangeDetail {
  key: string;
  value?: unknown;
  previousValue?: unknown;
  /** The status now held, absent on a removal. */
  status?: BeliefStatus;
  /** The status before this change, absent on an addition. */
  previousStatus?: BeliefStatus;
}

export type BeliefChangeHandler = (detail: BeliefChangeDetail) => void;

export interface BeliefQueryResult {
  key: string;
  value: unknown;
  /** How firmly the belief is held. Lets a query ask for the doubtful ones. */
  status: BeliefStatus;
}

/**
 * Typed key-value belief store per agent, with support for
 * structured/nested beliefs and change events.
 *
 * The storage backend is pluggable: agents depend only on this
 * interface, so implementations can swap between in-memory, Redis,
 * etc. without touching agent or plan code.
 */
export interface BeliefBase {
  get<T = unknown>(key: string): T | undefined;
  has(key: string): boolean;
  /**
   * How firmly the belief at `key` is held, or `undefined` if there is none.
   *
   * Prefer comparing the result to a {@link BeliefStatus} over testing it for
   * truthiness: every status is a non-empty string, `"negative"` included.
   */
  statusOf(key: string): BeliefStatus | undefined;
  /**
   * Stores a value. `status` defaults to `"positive"`, so an ordinary write is a
   * belief and every existing call site keeps its meaning. Pass `"negative"` to
   * record that the sender took the opposite stance toward this content.
   */
  set(key: string, value: unknown, status?: BeliefStatus): void;
  /**
   * Changes how firmly an existing belief is held, leaving its value alone.
   * This is how a belief becomes `"uncertain"` without inventing a new claim
   * about it. Returns whether there was anything to change.
   */
  setStatus(key: string, status: BeliefStatus): boolean;
  compareAndSet(
    key: string,
    expected: unknown,
    next: unknown,
    status?: BeliefStatus,
  ): Promise<boolean>;
  update<T = unknown>(
    key: string,
    reducer: (current: T | undefined) => T,
    status?: BeliefStatus,
  ): Promise<boolean>;
  remove(key: string): boolean;
  queryByPrefix(prefix: string): BeliefQueryResult[];
  /**
   * The predicate receives the status as a third argument. Predicates written
   * against the older two-argument shape still typecheck and still work.
   */
  query(
    predicate: (key: string, value: unknown, status: BeliefStatus) => boolean,
  ): BeliefQueryResult[];
  on(event: BeliefEvent, handler: BeliefChangeHandler): () => void;
  all(): Record<string, unknown>;
  clear(): void;
}

/**
 * Read-modify-write with retry, for a store that may be shared across processes.
 *
 * `status` is what the resulting belief is held with, not what it was: the
 * update is a new claim, so it asserts like any other write unless told
 * otherwise. `maxAttempts` bounds the retry, since a concurrent writer can win
 * every round and spin forever.
 */
export async function casUpdate<T = unknown>(
  store: Pick<BeliefBase, "get" | "compareAndSet">,
  key: string,
  reducer: (current: T | undefined) => T,
  status?: BeliefStatus,
  maxAttempts = 100,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = store.get<T>(key);
    const next = reducer(current);
    if (await store.compareAndSet(key, current, next, status)) {
      return true;
    }
  }
  return false;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/**
 * The default belief base: every belief in memory, in a B+ tree ordered by key,
 * so {@link BeliefBase.queryByPrefix} visits only the keys under the prefix
 * rather than every key held. Queries and {@link all} list keys in key order.
 */
export class InMemoryBeliefBase implements BeliefBase {
  private readonly beliefs = new BTree<string, BeliefEntry>(
    undefined,
    sortedBtree.simpleComparator,
  );
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  get<T = unknown>(key: string): T | undefined {
    return this.beliefs.get(key)?.value as T | undefined;
  }

  has(key: string): boolean {
    return this.beliefs.has(key);
  }

  statusOf(key: string): BeliefStatus | undefined {
    return this.beliefs.get(key)?.status;
  }

  set(key: string, value: unknown, status: BeliefStatus = "positive"): void {
    const previous = this.beliefs.get(key);

    this.beliefs.set(key, { value, status });

    if (previous) {
      // Fires for a status flip even when the value is identical, since
      // "now believed false" is a change to what the agent holds even though
      // what it holds has not moved.
      this.emitter.emit("beliefUpdated", {
        key,
        value,
        previousValue: previous.value,
        status,
        previousStatus: previous.status,
      } satisfies BeliefChangeDetail);
    } else {
      this.emitter.emit("beliefAdded", {
        key,
        value,
        status,
      } satisfies BeliefChangeDetail);
    }
  }

  setStatus(key: string, status: BeliefStatus): boolean {
    const entry = this.beliefs.get(key);
    if (!entry) {
      return false;
    }

    this.beliefs.set(key, { value: entry.value, status });
    this.emitter.emit("beliefUpdated", {
      key,
      value: entry.value,
      previousValue: entry.value,
      status,
      previousStatus: entry.status,
    } satisfies BeliefChangeDetail);
    return true;
  }

  async compareAndSet(
    key: string,
    expected: unknown,
    next: unknown,
    status: BeliefStatus = "positive",
  ): Promise<boolean> {
    const entry = this.beliefs.get(key);
    const matches =
      expected === undefined
        ? entry === undefined
        : entry !== undefined && deepEqual(entry.value, expected);

    if (!matches) return false;

    this.set(key, next, status);
    return true;
  }

  async update<T = unknown>(
    key: string,
    reducer: (current: T | undefined) => T,
    status: BeliefStatus = "positive",
  ): Promise<boolean> {
    return casUpdate<T>(this, key, reducer, status);
  }

  remove(key: string): boolean {
    const entry = this.beliefs.get(key);
    if (!entry) {
      return false;
    }

    this.beliefs.delete(key);
    // No status on the removal: once the key is gone there is no position to
    // report, only what was there before it went.
    this.emitter.emit("beliefRemoved", {
      key,
      value: entry.value,
      previousStatus: entry.status,
    } satisfies BeliefChangeDetail);
    return true;
  }

  queryByPrefix(prefix: string): BeliefQueryResult[] {
    const results: BeliefQueryResult[] = [];
    // Keys under a prefix are contiguous in key order, starting at the
    // prefix itself, so the scan stops at the first key past them.
    for (const [key, entry] of this.beliefs.entries(prefix)) {
      if (!key.startsWith(prefix)) break;
      results.push({ key, value: entry.value, status: entry.status });
    }
    return results;
  }

  query(
    predicate: (key: string, value: unknown, status: BeliefStatus) => boolean,
  ): BeliefQueryResult[] {
    const results: BeliefQueryResult[] = [];
    for (const [key, entry] of this.beliefs.entries()) {
      if (predicate(key, entry.value, entry.status)) {
        results.push({ key, value: entry.value, status: entry.status });
      }
    }
    return results;
  }

  on(event: BeliefEvent, handler: BeliefChangeHandler): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }

  all(): Record<string, unknown> {
    // Values only: the envelope is the store's business. A caller wanting
    // polarity asks `statusOf`, or filters a query by it.
    return Object.fromEntries(
      [...this.beliefs.entries()].map(([key, entry]) => [key, entry.value]),
    );
  }

  clear(): void {
    // Copied first: removing while walking the tree would skip keys.
    for (const key of [...this.beliefs.keys()]) {
      this.remove(key);
    }
  }
}

/**
 * The prefix under which an agent keeps its own state in its belief base:
 * goals, conversations and the commitments it made, so that a belief base that
 * persists what it holds also restores the agent. Plans, desires, expressions
 * and peers never see these keys; see {@link BeliefView}.
 */
export const AGENT_STATE_PREFIX = "~agent.";

/**
 * A belief base as everyone but the agent sees it: the store underneath with
 * every key under a hidden prefix left out of reads, queries and change
 * events. Writing such a key through the view throws, since it would change
 * the agent's own state behind its back.
 *
 * {@link Agent.beliefs} is this view over the belief base the agent was given,
 * hiding {@link AGENT_STATE_PREFIX}.
 */
export class BeliefView implements BeliefBase {
  constructor(
    private readonly store: BeliefBase,
    private readonly hidden: string = AGENT_STATE_PREFIX,
  ) {}

  private visible(key: string): boolean {
    return !key.startsWith(this.hidden);
  }

  private writable(key: string): void {
    if (!this.visible(key)) {
      throw new Error(
        `belief key "${key}" is under "${this.hidden}", which is the agent's own state`,
      );
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return this.visible(key) ? this.store.get<T>(key) : undefined;
  }

  has(key: string): boolean {
    return this.visible(key) && this.store.has(key);
  }

  statusOf(key: string): BeliefStatus | undefined {
    return this.visible(key) ? this.store.statusOf(key) : undefined;
  }

  set(key: string, value: unknown, status?: BeliefStatus): void {
    this.writable(key);
    this.store.set(key, value, status);
  }

  setStatus(key: string, status: BeliefStatus): boolean {
    this.writable(key);
    return this.store.setStatus(key, status);
  }

  compareAndSet(
    key: string,
    expected: unknown,
    next: unknown,
    status?: BeliefStatus,
  ): Promise<boolean> {
    this.writable(key);
    return this.store.compareAndSet(key, expected, next, status);
  }

  update<T = unknown>(
    key: string,
    reducer: (current: T | undefined) => T,
    status?: BeliefStatus,
  ): Promise<boolean> {
    this.writable(key);
    return this.store.update(key, reducer, status);
  }

  remove(key: string): boolean {
    this.writable(key);
    return this.store.remove(key);
  }

  queryByPrefix(prefix: string): BeliefQueryResult[] {
    if (prefix.startsWith(this.hidden)) return [];
    const results = this.store.queryByPrefix(prefix);
    // Only a prefix the hidden one starts with ("", "~") can reach its keys.
    return this.hidden.startsWith(prefix)
      ? results.filter((r) => this.visible(r.key))
      : results;
  }

  query(
    predicate: (key: string, value: unknown, status: BeliefStatus) => boolean,
  ): BeliefQueryResult[] {
    return this.store.query(
      (key, value, status) =>
        this.visible(key) && predicate(key, value, status),
    );
  }

  on(event: BeliefEvent, handler: BeliefChangeHandler): () => void {
    return this.store.on(event, (detail) => {
      if (this.visible(detail.key)) handler(detail);
    });
  }

  all(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.store.all()).filter(([key]) => this.visible(key)),
    );
  }

  /** Removes every visible belief, leaving the agent's own state in place. */
  clear(): void {
    for (const { key } of this.query(() => true)) {
      this.store.remove(key);
    }
  }
}
