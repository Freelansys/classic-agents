import { EventEmitter } from "node:events";

export type BeliefEvent = "beliefAdded" | "beliefUpdated" | "beliefRemoved";

export interface BeliefChangeDetail {
  key: string;
  value?: unknown;
  previousValue?: unknown;
}

export type BeliefChangeHandler = (detail: BeliefChangeDetail) => void;

/**
 * Typed key-value belief store per agent, with support for
 * structured/nested beliefs and change events.
 */
export class BeliefBase {
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
