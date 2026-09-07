import { EventEmitter } from "node:events";

export type BeliefEvent = "beliefAdded" | "beliefUpdated" | "beliefRemoved";

export interface BeliefChangeDetail {
  key: string;
  value?: unknown;
  previousValue?: unknown;
}

export type BeliefChangeHandler = (detail: BeliefChangeDetail) => void;

export interface BeliefQueryResult {
  key: string;
  value: unknown;
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
  set(key: string, value: unknown): void;
  compareAndSet(key: string, expected: unknown, next: unknown): Promise<boolean>;
  update<T = unknown>(
    key: string,
    reducer: (current: T | undefined) => T,
  ): Promise<boolean>;
  remove(key: string): boolean;
  queryByPrefix(prefix: string): BeliefQueryResult[];
  query(
    predicate: (key: string, value: unknown) => boolean,
  ): BeliefQueryResult[];
  on(event: BeliefEvent, handler: BeliefChangeHandler): () => void;
  all(): Record<string, unknown>;
  clear(): void;
}

export async function casUpdate<T = unknown>(
  store: Pick<BeliefBase, "get" | "compareAndSet">,
  key: string,
  reducer: (current: T | undefined) => T,
  maxAttempts = 100,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = store.get<T>(key);
    const next = reducer(current);
    if (await store.compareAndSet(key, current, next)) {
      return true;
    }
  }
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
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

export class InMemoryBeliefBase implements BeliefBase {
  private readonly beliefs = new Map<string, unknown>();
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  get<T = unknown>(key: string): T | undefined {
    return this.beliefs.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.beliefs.has(key);
  }

  set(key: string, value: unknown): void {
    const existing = this.beliefs.has(key);
    const previousValue = this.beliefs.get(key);

    this.beliefs.set(key, value);

    if (existing) {
      this.emitter.emit("beliefUpdated", {
        key,
        value,
        previousValue,
      } satisfies BeliefChangeDetail);
    } else {
      this.emitter.emit("beliefAdded", {
        key,
        value,
      } satisfies BeliefChangeDetail);
    }
  }

  async compareAndSet(
    key: string,
    expected: unknown,
    next: unknown,
  ): Promise<boolean> {
    const absent = !this.beliefs.has(key);
    const matches =
      expected === undefined
        ? absent
        : !absent && deepEqual(this.beliefs.get(key), expected);

    if (!matches) return false;

    this.set(key, next);
    return true;
  }

  async update<T = unknown>(
    key: string,
    reducer: (current: T | undefined) => T,
  ): Promise<boolean> {
    return casUpdate<T>(this, key, reducer);
  }

  remove(key: string): boolean {
    const existed = this.beliefs.has(key);
    const value = this.beliefs.get(key);

    if (existed) {
      this.beliefs.delete(key);
      this.emitter.emit("beliefRemoved", {
        key,
        value,
      } satisfies BeliefChangeDetail);
    }

    return existed;
  }

  queryByPrefix(prefix: string): Array<{ key: string; value: unknown }> {
    const results: Array<{ key: string; value: unknown }> = [];
    for (const [key, value] of this.beliefs) {
      if (key.startsWith(prefix)) {
        results.push({ key, value });
      }
    }
    return results;
  }

  query(
    predicate: (key: string, value: unknown) => boolean,
  ): Array<{ key: string; value: unknown }> {
    const results: Array<{ key: string; value: unknown }> = [];
    for (const [key, value] of this.beliefs) {
      if (predicate(key, value)) {
        results.push({ key, value });
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
    return Object.fromEntries(this.beliefs);
  }

  clear(): void {
    for (const key of this.beliefs.keys()) {
      this.remove(key);
    }
  }
}
