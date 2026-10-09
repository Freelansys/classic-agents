import type { Goal } from "./goals.js";
import type { ActionResult, Plan } from "./plans.js";
import { EventEmitter } from "node:events";

export type IntentionStatus =
  "pending" | "executing" | "waiting" | "completed" | "failed";

/**
 * Statuses an intention never leaves. An intention in one of these is finished.
 *
 * There is no `dropped` here, unlike a goal's status. A goal can be dropped —
 * a dependency failed, so nothing it was waiting for will ever happen — but an
 * intention is the agent's own work on a goal, and the agent abandons that by
 * failing it, which records a reason. Silently withdrawing an intention would
 * leave the sender that was told `agree` with no account of why.
 */
export const TERMINAL_INTENTION_STATUSES: readonly IntentionStatus[] = [
  "completed",
  "failed",
];

export function isTerminalIntentionStatus(status: IntentionStatus): boolean {
  return status === "completed" || status === "failed";
}

/**
 * A sub-goal or delegation an intention was waiting for that failed instead.
 *
 * A delegation's failure carries `receiver` and, when the work was sent to
 * another agent, `exchange` — the request's `replyWith` — so a plan recovering
 * with `onChildFailure: "continue"` can tell which peer let it down. `goalId`
 * is the goal the work ran under: always set for a sub-goal and a
 * self-delegation, and for a remote delegation only once the peer named one in
 * its `agree`.
 */
export interface ChildFailure {
  goalId?: string;
  goal: string;
  reason: string;
  /** The agent the work was delegated to; absent for a sub-goal. */
  receiver?: string;
  /** The delegated request's `replyWith`; absent for a sub-goal and a self-delegation. */
  exchange?: string;
}

/**
 * Where a delegation stands.
 *
 * - `"sent"` — asked, not yet agreed to. A self-delegation is never in this
 *   state: its sub-goal is created on the spot.
 * - `"agreed"` — the receiver took the work on.
 * - `"done"` — the work was done; `result` holds what the receiver said.
 * - `"failed"` — refused, failed, not understood, unanswered, timed out, or a
 *   result this agent's belief middleware would not accept; `reason` says which.
 * - `"cancelled"` — the intention stopped waiting for it before it settled —
 *   it failed, was cancelled, or had enough answers already (`waitFor`) — and
 *   the work was asked to stop.
 */
export type DelegationStatus =
  "sent" | "agreed" | "done" | "failed" | "cancelled";

/**
 * A sub-goal an intention handed off and waits for, served by this agent or
 * another. Created from an action's `ActionResult.delegations`. A
 * self-delegation's goal id is also in the intention's `children`.
 */
export interface Delegation {
  /** The agent doing the work. This agent's own id for a self-delegation. */
  receiver: string;
  /** The goal it was asked to achieve. */
  goal: string;
  status: DelegationStatus;
  /**
   * The request's `replyWith`, which every reply names back. Absent for a
   * self-delegation, which never goes on the wire.
   */
  exchange?: string;
  /**
   * The goal the work runs under: the id a remote receiver assigned in its
   * `agree`, or the sub-goal a self-delegation created.
   */
  goalId?: string;
  /**
   * The answer the work produced: the `result` of the delegate's
   * `inform { done: true }`, or the `ActionResult.result` of a self-delegated
   * sub-goal. Absent when it produced none. A remote reply's whole content is
   * also kept at `done.<receiver>.<goal>.<exchange>`.
   */
  result?: unknown;
  /**
   * The latest progress note from a remote delegate: the content of the last
   * `inform` it sent for this request that was not its final `done`, as the
   * belief middleware accepted it. Each note replaces the one before.
   */
  progress?: unknown;
  /** Why the delegation failed or was cancelled. */
  reason?: string;
  /** When the work must be done by, as epoch milliseconds; absent for none. */
  deadline?: number;
  /**
   * What this delegation's failure does, when it set its own; otherwise the
   * plan's `onChildFailure` decides.
   */
  onFailure?: "fail" | "continue";
}

/** Whether a delegation is still outstanding: asked for, and not yet settled. */
export function isOpenDelegation(delegation: Delegation): boolean {
  return delegation.status === "sent" || delegation.status === "agreed";
}

/** The delegations an intention is still waiting on. */
export function openDelegations(intention: Intention): Delegation[] {
  return intention.delegations.filter(isOpenDelegation);
}

/**
 * Whether an intention still has work outstanding that it handed off: a
 * sub-goal or a delegation that has not settled.
 */
export function isAwaitingWork(intention: Intention): boolean {
  return (
    intention.children.length > 0 ||
    intention.delegations.some(isOpenDelegation)
  );
}

export interface Intention {
  id: string;
  goal: Goal;
  plan: Plan;
  actionIndex: number;
  status: IntentionStatus;
  result?: ActionResult;
  failureReason?: string;
  /**
   * Ids of this agent's own sub-goals the intention is currently waiting for:
   * the self-delegations still open.
   */
  children: string[];
  /**
   * Every delegation this intention made, settled or not, in the order made.
   * The open ones are what it is waiting for besides `children`; the settled
   * ones keep their outcome — a `done` one its `result` — for the plan's next
   * action to read.
   */
  delegations: Delegation[];
  /**
   * Every failure among the delegations the intention waited on — a sub-goal
   * of its own or a remote request — for the plan's next action to inspect.
   */
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
    delegations: [],
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
