import type { Goal } from "./goals.js";
import type { ActionResult, Plan } from "./plans.js";
import { EventEmitter } from "node:events";

export type IntentionStatus =
  "pending" | "executing" | "waiting" | "completed" | "failed" | "dropped";

/** Statuses an intention never leaves. An intention in one of these is finished. */
export const TERMINAL_INTENTION_STATUSES: readonly IntentionStatus[] = [
  "completed",
  "failed",
  "dropped",
];

export function isTerminalIntentionStatus(status: IntentionStatus): boolean {
  return status === "completed" || status === "failed" || status === "dropped";
}

/** A sub-goal an intention was waiting for that failed instead. */
export interface ChildFailure {
  goalId: string;
  goal: string;
  reason: string;
}

export interface Intention {
  id: string;
  goal: Goal;
  plan: Plan;
  actionIndex: number;
  status: IntentionStatus;
  result?: ActionResult;
  failureReason?: string;
  /** Ids of the sub-goals this intention is currently waiting for. */
  children: string[];
  /** Sub-goal failures collected while the plan recovers (`onChildFailure: "continue"`). */
  childFailures: ChildFailure[];
}

/**
 * A finished intention left the stack. The intention is the stack's own object,
 * so a handler that keeps it must snapshot it (`{ ...intention }`).
 */
export type IntentionEvent = "intentionRemoved";

export type IntentionEventHandler = (intention: Intention) => void;

let intentionCounter = 0;

export function createIntention(goal: Goal, plan: Plan): Intention {
  return {
    id: `intention-${++intentionCounter}`,
    goal,
    plan,
    actionIndex: 0,
    status: "pending",
    children: [],
    childFailures: [],
  };
}

export function resetIntentionCounter(): void {
  intentionCounter = 0;
}

export class IntentionStack {
  private readonly intentions = new Map<string, Intention>();
  /**
   * Ids per status, so the reasoning cycle reads the intentions it can still
   * advance without walking every intention the agent has ever run.
   */
  private readonly byStatus: Record<IntentionStatus, Set<string>> = {
    pending: new Set(),
    executing: new Set(),
    waiting: new Set(),
    completed: new Set(),
    failed: new Set(),
    dropped: new Set(),
  };
  /**
   * Ids of the intentions working each goal, so a goal that just finished can
   * be traced to the intentions waiting on it without scanning the stack.
   */
  private readonly byGoal = new Map<string, Set<string>>();
  private readonly emitter = new EventEmitter();
  /** Ids that reached a terminal status, awaiting collection by `flush()`. */
  private finished: string[] = [];

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  push(intention: Intention): void {
    this.intentions.set(intention.id, intention);
    this.byStatus[intention.status].add(intention.id);
    this.indexGoal(intention);
  }

  get(id: string): Intention | undefined {
    return this.intentions.get(id);
  }

  getAll(): Intention[] {
    return Array.from(this.intentions.values());
  }

  getByStatus(status: IntentionStatus): Intention[] {
    const result: Intention[] = [];
    for (const id of this.byStatus[status]) {
      const intention = this.intentions.get(id);
      if (intention) {
        result.push(intention);
      }
    }
    return result;
  }

  /** Intentions with work to do this cycle: pending + executing, but not waiting. */
  getRunnable(): Intention[] {
    return [...this.getByStatus("pending"), ...this.getByStatus("executing")];
  }

  getActive(): Intention[] {
    return [
      ...this.getByStatus("pending"),
      ...this.getByStatus("executing"),
      ...this.getByStatus("waiting"),
    ];
  }

  /** Every intention working a given goal, in any status. */
  getByGoal(goalId: string): Intention[] {
    const ids = this.byGoal.get(goalId);
    if (!ids) {
      return [];
    }
    const result: Intention[] = [];
    for (const id of ids) {
      const intention = this.intentions.get(id);
      if (intention) {
        result.push(intention);
      }
    }
    return result;
  }

  remove(id: string): boolean {
    const intention = this.intentions.get(id);
    if (!intention) {
      return false;
    }
    this.collect(id, intention);
    return true;
  }

  complete(id: string, result: ActionResult): void {
    const intention = this.intentions.get(id);
    if (!intention) {
      return;
    }
    this.byStatus[intention.status].delete(id);
    intention.status = "completed";
    intention.result = result;
    this.byStatus.completed.add(id);
    this.finished.push(id);
  }

  fail(id: string, reason: string): void {
    const intention = this.intentions.get(id);
    if (!intention) {
      return;
    }
    this.byStatus[intention.status].delete(id);
    intention.status = "failed";
    intention.failureReason = reason;
    this.byStatus.failed.add(id);
    this.finished.push(id);
  }

  drop(id: string): void {
    const intention = this.intentions.get(id);
    if (!intention) {
      return;
    }
    this.byStatus[intention.status].delete(id);
    intention.status = "dropped";
    this.byStatus.dropped.add(id);
    this.finished.push(id);
  }

  setStatus(id: string, status: IntentionStatus): void {
    const intention = this.intentions.get(id);
    if (!intention) {
      return;
    }
    this.byStatus[intention.status].delete(id);
    intention.status = status;
    this.byStatus[status].add(id);
    if (isTerminalIntentionStatus(status)) {
      this.finished.push(id);
    }
  }

  advance(id: string): void {
    const intention = this.intentions.get(id);
    if (intention) {
      intention.actionIndex++;
    }
  }

  /**
   * Collects every intention that reached a terminal status since the last
   * flush. Deferred rather than done at the transition so that a job's whole
   * event sequence is delivered with its intention still on the stack.
   *
   * `Agent` calls this at the end of every cycle; a standalone stack has to
   * call it itself, since otherwise finished intentions are never collected.
   */
  flush(): void {
    if (this.finished.length === 0) {
      return;
    }

    const ids = this.finished;
    this.finished = [];

    for (const id of ids) {
      const intention = this.intentions.get(id);
      // An intention can leave the stack between being marked finished and
      // being flushed, so the list is re-checked rather than trusted.
      if (!intention || !isTerminalIntentionStatus(intention.status)) {
        continue;
      }
      this.collect(id, intention);
    }
  }

  private collect(id: string, intention: Intention): void {
    this.byStatus[intention.status].delete(id);
    this.unindexGoal(intention);
    this.intentions.delete(id);
    this.emitter.emit("intentionRemoved", intention);
  }

  private indexGoal(intention: Intention): void {
    const goalId = intention.goal.id;
    let ids = this.byGoal.get(goalId);
    if (!ids) {
      ids = new Set();
      this.byGoal.set(goalId, ids);
    }
    ids.add(intention.id);
  }

  private unindexGoal(intention: Intention): void {
    const goalId = intention.goal.id;
    const ids = this.byGoal.get(goalId);
    if (!ids) {
      return;
    }
    ids.delete(intention.id);
    if (ids.size === 0) {
      this.byGoal.delete(goalId);
    }
  }

  /**
   * Observes the stack. Returns an unsubscribe function.
   *
   * @example
   * ```ts
   * const off = intentions.on("intentionRemoved", (intention) => {
   *   archive({ ...intention });
   * });
   * ```
   */
  on(event: IntentionEvent, handler: IntentionEventHandler): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }
}
