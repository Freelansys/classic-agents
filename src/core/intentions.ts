import type { Goal } from "./goals.js";
import type { ActionResult, Plan, RefusalVerdict } from "./plans.js";
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
 * past a tolerated failure (`onFailure: "continue"`) can tell which peer let
 * it down. `goalId`
 * is the goal the work ran under: always set for a sub-goal and a
 * self-delegation, and for a remote delegation only once the peer named one in
 * its `agree`.
 */
export interface ChildFailure {
  readonly goalId?: string;
  readonly goal: string;
  readonly reason: string;
  /**
   * What the failing side gave a program to read alongside `reason`: a
   * sub-goal's `ActionResult.failure.details`, or the `details` of the
   * `failure`, `refuse` or `not-understood` that ended a remote delegation.
   * Absent when it gave none.
   */
  readonly details?: unknown;
  /** The agent the work was delegated to; absent for a sub-goal. */
  readonly receiver?: string;
  /** The delegated request's `replyWith`; absent for a sub-goal and a self-delegation. */
  readonly exchange?: string;
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
 * Where a call for proposals stands.
 *
 * - `"open"` — the `cfp` has gone out and the bidding is still open.
 * - `"closed"` — every invited agent has answered, or the deadline passed. The
 *   next action reads the proposals and awards them.
 * - `"cancelled"` — the intention stopped waiting before the call closed; the
 *   bids received are rejected.
 */
export type CallStatus = "open" | "closed" | "cancelled";

/**
 * A bid received for a call, from a `propose`. Keyed by the `propose`'s
 * `replyWith`, which an `accept-proposal` or `reject-proposal` names back.
 */
export interface Proposal {
  /** The `propose`'s `replyWith`: the id an award names. */
  readonly id: string;
  /** The agent that bid. */
  readonly sender: string;
  /** The job the bid is for. */
  readonly goal: string;
  /** The terms offered: the `propose`'s content `terms`. */
  readonly terms: unknown;
  /** When the bid arrived, as epoch ms. */
  readonly receivedAt: number;
  /**
   * When the bid stops being valid, as epoch ms; absent for none. A call
   * holding a bid closes ahead of this, so the bid can still be awarded.
   */
  readonly expiresAt?: number;
  /**
   * What happened to the bid: `"offered"` until the call is awarded, then
   * `"awarded"`, `"rejected"` or `"expired"`.
   */
  readonly status: "offered" | "awarded" | "rejected" | "expired";
}

/**
 * Where a proposal this agent made stands.
 *
 * - `"open"` — the `propose` has gone out and the receiver has not decided.
 * - `"accepted"` — the receiver sent `accept-proposal`.
 * - `"rejected"` — the receiver sent `reject-proposal`, or could not read
 *   the proposal (`not-understood`).
 * - `"expired"` — its `reply-by` passed with no decision.
 * - `"cancelled"` — the intention stopped waiting before it was decided, and
 *   the receiver was sent a `cancel`.
 */
export type SentProposalStatus =
  "open" | "accepted" | "rejected" | "expired" | "cancelled";

/**
 * A proposal an intention made and waited on, from an action's
 * `ActionResult.proposals`: FIPA Propose (SC00036), a `propose` that answers
 * no call. The intention waits while any is `"open"`; the next action reads
 * how each was decided.
 */
export interface SentProposal {
  /** The `propose`'s `replyWith`, which the decision names back. */
  readonly id: string;
  /** The agent asked to accept. */
  readonly receiver: string;
  /** What was proposed. */
  readonly goal: string;
  /** The terms offered. */
  readonly terms: unknown;
  readonly status: SentProposalStatus;
  /**
   * What the receiver said with its `accept-proposal`: the `result` of the
   * goal it decided under. Absent when it said nothing.
   */
  readonly answer?: unknown;
  /** Why it was rejected, expired or cancelled. */
  readonly reason?: string;
  /** What a `reject-proposal` gave a program to read beside its reason. */
  readonly details?: unknown;
  /** When the decision is due, as epoch ms; absent for none. */
  readonly deadline?: number;
}

/**
 * A call for proposals an intention opened and waited on, from an action's
 * `ActionResult.calls`. The intention waits while any call is `"open"`; once
 * every call has closed, the plan's next action reads the proposals and awards
 * them.
 */
export interface Call {
  readonly id: string;
  /** The job proposals were asked for. */
  readonly goal: string;
  readonly status: CallStatus;
  /** The agents invited, absent for a topic call. */
  readonly invited?: readonly string[];
  /** The `cfp`s' `replyWith`s, one per receiver (or one for a published call). */
  readonly exchanges: readonly string[];
  /** When the call closes, as epoch ms. */
  readonly deadline: number;
  /** The bids received, in arrival order. */
  readonly proposals: readonly Proposal[];
  /** Refusals received, for the plan to consider alongside the bids. */
  readonly refusals: ReadonlyArray<{
    readonly sender: string;
    readonly verdict?: RefusalVerdict;
    readonly reason?: string;
  }>;
}

/**
 * A sub-goal an intention handed off and waits for, served by this agent or
 * another. Created from an action's `ActionResult.delegations`. A
 * self-delegation's goal id is also in the intention's `children`.
 */
export interface Delegation {
  /** The agent doing the work. This agent's own id for a self-delegation. */
  readonly receiver: string;
  /** The goal it was asked to achieve. */
  readonly goal: string;
  readonly status: DelegationStatus;
  /**
   * The request's `replyWith`, which every reply names back. Absent for a
   * self-delegation, which never goes on the wire.
   */
  readonly exchange?: string;
  /**
   * The goal the work runs under: the id a remote receiver assigned in its
   * `agree`, or the sub-goal a self-delegation created.
   */
  readonly goalId?: string;
  /**
   * The answer the work produced: the `result` of the delegate's
   * `inform { done: true }`, or the `ActionResult.result` of a self-delegated
   * sub-goal. Absent when it produced none. A remote reply's whole content is
   * also kept at `done.<receiver>.<goal>.<exchange>`.
   */
  readonly result?: unknown;
  /**
   * The latest progress note from a remote delegate: the content of the last
   * `inform` it sent for this request that was not its final `done`, as the
   * belief middleware accepted it. Each note replaces the one before.
   */
  readonly progress?: unknown;
  /** Why the delegation failed or was cancelled. */
  readonly reason?: string;
  /**
   * What the failing side gave a program to read alongside `reason`, the
   * failure's counterpart of `result`: the `details` of the delegate's
   * `failure`, `refuse` or `not-understood`, or the
   * `ActionResult.failure.details` of a self-delegated sub-goal. Absent when
   * it gave none, and for a failure this agent decided itself (a timeout, a
   * result its belief middleware would not accept).
   */
  readonly details?: unknown;
  /** When the work must be done by, as epoch milliseconds; absent for none. */
  readonly deadline?: number;
  /**
   * What this delegation's failure does, when it set one: `"continue"` if the
   * intention can do without it. Absent means `"fail"`.
   */
  readonly onFailure?: "fail" | "continue";
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
 * sub-goal or a delegation that has not settled, a call for proposals that
 * has not closed, or a proposal that has not been decided.
 */
export function isAwaitingWork(intention: Intention): boolean {
  return (
    intention.children.length > 0 ||
    intention.delegations.some(isOpenDelegation) ||
    intention.calls.some((call) => call.status === "open") ||
    intention.proposals.some((p) => p.status === "open")
  );
}

export interface Intention {
  readonly id: string;
  readonly goal: Goal;
  readonly plan: Plan;
  readonly actionIndex: number;
  readonly status: IntentionStatus;
  readonly result?: ActionResult;
  readonly failureReason?: string;
  /** What the failure reported with its reason, if anything. */
  readonly failureDetails?: unknown;
  /**
   * Ids of this agent's own sub-goals the intention is currently waiting for:
   * the self-delegations still open.
   */
  readonly children: readonly string[];
  /**
   * Every delegation this intention made, settled or not, in the order made.
   * The open ones are what it is waiting for besides `children`; the settled
   * ones keep their outcome — a `done` one its `result` — for the plan's next
   * action to read.
   */
  readonly delegations: readonly Delegation[];
  /**
   * Every failure among the delegations the intention waited on — a sub-goal
   * of its own or a remote request — for the plan's next action to inspect.
   */
  readonly childFailures: readonly ChildFailure[];
  /**
   * Every call for proposals this intention opened, settled or not, in the
   * order opened. The intention waits while any is `"open"`; a closed one keeps
   * its proposals for the next action to award.
   */
  readonly calls: readonly Call[];
  /**
   * Every proposal this intention made, decided or not, in the order made.
   * The intention waits while any is `"open"`; a decided one keeps its
   * outcome for the next action to read.
   */
  readonly proposals: readonly SentProposal[];
}

/**
 * A finished intention left the stack. The intention is the stack's own object,
 * so a handler that keeps it must snapshot it (`{ ...intention }`).
 */
export type IntentionEvent = "intentionRemoved";

export type IntentionEventHandler = (intention: Intention) => void;

/** The lists of an intention that grow as it works, one record each. */
export type IntentionList =
  "delegations" | "childFailures" | "calls" | "proposals";

/** An item of one of an intention's {@link IntentionList}s. */
export type IntentionItem<L extends IntentionList> = Intention[L][number];

/**
 * What changed in an intention on the stack, so a listener that keeps it can
 * write that part alone:
 *
 * - `"added"`: the intention was pushed, with whatever its lists held.
 * - `"intention"`: one of its own fields — status, action, result, children.
 * - a list name: the item at `index` of that list was added or replaced.
 * - `"bid"`: the bid at `index` of the call at `call` was added or replaced.
 */
export type IntentionChange =
  | { readonly part: "added" | "intention" }
  | { readonly part: IntentionList; readonly index: number }
  | { readonly part: "bid"; readonly call: number; readonly index: number };

export type IntentionChangeHandler = (
  intention: Intention,
  change: IntentionChange,
) => void;

/** An intention as the stack itself changes it. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The intention's own fields the stack changes with {@link IntentionStack.update}. */
export type IntentionFields = Partial<
  Pick<
    Intention,
    | "actionIndex"
    | "status"
    | "result"
    | "failureReason"
    | "failureDetails"
    | "children"
  >
>;

/**
 * Freezes what the stack keeps of an item: the item and the lists it holds,
 * not the data a plan or a peer put in it.
 */
function frozen<T extends object>(item: T): T {
  for (const value of Object.values(item)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "object" && entry !== null) Object.freeze(entry);
      }
      Object.freeze(value);
    }
  }
  return Object.freeze(item);
}

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
    calls: [],
    proposals: [],
  };
}

export function resetIntentionCounter(): void {
  intentionCounter = 0;
}

/**
 * Moves the counter past an id given out before, so an intention restored
 * after a restart never shares its id with a new one.
 *
 * @internal
 */
export function noteIntentionId(id: string): void {
  const n = Number(/^intention-(\d+)$/.exec(id)?.[1]);
  if (n > intentionCounter) intentionCounter = n;
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

  /**
   * Puts an intention on the stack. From here on the stack is what changes
   * it: its lists and their items are frozen, and each change is a new item
   * or field set by the methods below, reported on {@link onChange}.
   */
  push(intention: Intention): void {
    const own = intention as Mutable<Intention>;
    own.children = Object.freeze([...intention.children]);
    own.delegations = Object.freeze(intention.delegations.map(frozen));
    own.childFailures = Object.freeze(intention.childFailures.map(frozen));
    own.proposals = Object.freeze(intention.proposals.map(frozen));
    own.calls = Object.freeze(
      intention.calls.map((call) =>
        frozen({ ...call, proposals: call.proposals.map(frozen) }),
      ),
    );
    this.intentions.set(intention.id, intention);
    this.byStatus[intention.status].add(intention.id);
    this.indexGoal(intention);
    this.changed(intention, { part: "added" });
  }

  /**
   * Sets fields of the intention's own. A change of `status` moves it between
   * the status indexes, and a terminal one marks it for {@link flush}.
   */
  update(id: string, fields: IntentionFields): void {
    const intention = this.intentions.get(id);
    if (!intention) {
      return;
    }
    const own = intention as Mutable<Intention>;
    const from = intention.status;
    Object.assign(own, fields);
    if (fields.children) own.children = Object.freeze([...fields.children]);
    if (fields.status !== undefined && fields.status !== from) {
      this.byStatus[from].delete(id);
      this.byStatus[fields.status].add(id);
      if (isTerminalIntentionStatus(fields.status)) {
        this.finished.push(id);
      }
    }
    this.changed(intention, { part: "intention" });
  }

  /**
   * Adds `item` to one of the intention's lists, and returns it as kept. An
   * intention not on the stack (any more) is changed all the same, but the
   * change is not reported.
   */
  add<L extends IntentionList>(
    intention: Intention,
    list: L,
    item: IntentionItem<L>,
  ): IntentionItem<L> {
    const kept = frozen({ ...item }) as IntentionItem<L>;
    const items = intention[list] as readonly IntentionItem<L>[];
    (intention as Mutable<Intention>)[list] = Object.freeze([
      ...items,
      kept,
    ]) as Intention[L];
    this.changed(intention, { part: list, index: items.length });
    return kept;
  }

  /**
   * Replaces `item`, as the intention holds it now, with `next`, and returns
   * `next` as kept. Throws if the intention does not hold `item`: a change
   * made from an item since replaced would undo the one that replaced it.
   */
  replace<L extends IntentionList>(
    intention: Intention,
    list: L,
    item: IntentionItem<L>,
    next: IntentionItem<L>,
  ): IntentionItem<L> {
    const items = intention[list] as readonly IntentionItem<L>[];
    const index = items.indexOf(item);
    if (index < 0) {
      throw new Error(
        `intention ${intention.id} holds no such item in ${list}`,
      );
    }
    const kept = frozen({ ...next }) as IntentionItem<L>;
    (intention as Mutable<Intention>)[list] = Object.freeze(
      items.map((existing, i) => (i === index ? kept : existing)),
    ) as Intention[L];
    this.changed(intention, { part: list, index });
    return kept;
  }

  /**
   * Adds a bid to one of the intention's calls, as it holds that call now.
   * Returns the call as it now stands and the bid as kept.
   */
  addBid(
    intention: Intention,
    call: Call,
    bid: Proposal,
  ): { call: Call; bid: Proposal } {
    return this.setBid(intention, call, call.proposals.length, bid);
  }

  /** Replaces a bid of one of the intention's calls with `next`. */
  replaceBid(
    intention: Intention,
    call: Call,
    bid: Proposal,
    next: Proposal,
  ): { call: Call; bid: Proposal } {
    const index = call.proposals.indexOf(bid);
    if (index < 0) {
      throw new Error(`call ${call.id} holds no such bid`);
    }
    return this.setBid(intention, call, index, next);
  }

  private setBid(
    intention: Intention,
    call: Call,
    index: number,
    bid: Proposal,
  ): { call: Call; bid: Proposal } {
    const at = intention.calls.indexOf(call);
    if (at < 0) {
      throw new Error(`intention ${intention.id} holds no such call`);
    }
    const kept = Object.freeze({ ...bid });
    const proposals = [...call.proposals];
    proposals[index] = kept;
    const next = frozen({ ...call, proposals });
    (intention as Mutable<Intention>).calls = Object.freeze(
      intention.calls.map((existing, i) => (i === at ? next : existing)),
    );
    this.changed(intention, { part: "bid", call: at, index });
    return { call: next, bid: kept };
  }

  /** Observes every change the stack makes to an intention. */
  onChange(handler: IntentionChangeHandler): () => void {
    this.emitter.on("intentionChanged", handler);
    return () => {
      this.emitter.off("intentionChanged", handler);
    };
  }

  /** Reports a change to an intention, if it is on the stack. */
  private changed(intention: Intention, change: IntentionChange): void {
    if (this.intentions.get(intention.id) !== intention) return;
    this.emitter.emit("intentionChanged", intention, change);
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

  /** How many intentions are in `status`, without listing them. */
  countByStatus(status: IntentionStatus): number {
    return this.byStatus[status].size;
  }

  /** How many intentions are pending or executing: those that hold a running slot. */
  countRunnable(): number {
    return this.byStatus.pending.size + this.byStatus.executing.size;
  }

  /** Intentions not yet finished: pending, executing or waiting. */
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
    this.update(id, { status: "completed", result });
  }

  fail(id: string, reason: string, details?: unknown): void {
    this.update(id, {
      status: "failed",
      failureReason: reason,
      ...(details !== undefined ? { failureDetails: details } : {}),
    });
  }

  setStatus(id: string, status: IntentionStatus): void {
    this.update(id, { status });
  }

  advance(id: string): void {
    const intention = this.intentions.get(id);
    if (intention) {
      this.update(id, { actionIndex: intention.actionIndex + 1 });
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
