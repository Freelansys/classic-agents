import { EventEmitter } from "node:events";

export type GoalStatus =
  "pending" | "active" | "achieved" | "failed" | "dropped";

/** Statuses a goal never leaves. A goal in one of these is finished. */
export const TERMINAL_GOAL_STATUSES: readonly GoalStatus[] = [
  "achieved",
  "failed",
  "dropped",
];

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return status === "achieved" || status === "failed" || status === "dropped";
}

/**
 * The message a goal originated from, recorded when a `request`/`achieve`
 * creates a goal and inherited by any sub-goal it spawns. This is what lets the
 * sender follow its own request through decomposition and all the way to the
 * failure or achievement events, without guessing ids.
 *
 * Absent for goals added directly to the queue.
 */
export interface GoalSource {
  sender: string;
  /**
   * Where replies about this goal go, when the sender named somewhere other
   * than itself: FIPA's `reply-to`. Absent means replies go to `sender`.
   */
  replyTo?: string;
  conversationId?: string;
  inReplyTo?: string;
}

export interface Goal<T = unknown> {
  id: string;
  name: string;
  priority: number;
  status: GoalStatus;
  data?: T;
  dependsOn?: string[];
  /** Id of the goal whose plan created this one as a sub-goal. */
  parentGoalId?: string;
  /** Topmost goal of the sub-goal chain: the parent's `rootGoalId`, or its own id. */
  rootGoalId?: string;
  /** Message this goal came from, when it was created from one. */
  source?: GoalSource;
}

/**
 * Picks the next goal to work on.
 *
 * `achieved` holds the ids of goals that have reached `achieved` and are still
 * remembered because some held goal declares a `dependsOn` on them — see
 * `GoalQueue.achievedIds`. Dependency gating has to read it from here rather
 * than from the goals themselves: an achieved goal leaves the queue at the end
 * of the cycle that finished it, so by the time a dependent goal is next
 * considered, the goal it waits on is no longer in `pending` or `active`.
 *
 * A function that ignores the third parameter stays valid; it simply has to do
 * its own dependency gating.
 */
export type GoalSelectionFunction = (
  pending: Goal[],
  active: Goal[],
  achieved: ReadonlySet<string>,
) => Goal | undefined;

/**
 * Events a `GoalQueue` emits, and the payload each one arrives with.
 *
 * - `goalAdded`: a goal was added (including the sub-goals an action creates),
 *   and for a goal refused by the size bound, at the status it was admitted
 *   with before being failed.
 * - `goalStatusChanged`: a goal's status was set, to whatever it was set to.
 *   Read the previous status from the goal before the change if you need it —
 *   the queue reports the goal as it now stands, not the transition.
 * - `goalRejected`: the goal was refused because the queue is already holding
 *   `maxGoals` unfinished goals. It is reported before the `goalStatusChanged`
 *   that fails it, so a handler can still see it at its admitted status.
 * - `goalRemoved`: a finished goal left the queue, either collected by
 *   `flush()` or dropped by an explicit `remove()`.
 *
 * The goal is the queue's own object, not a copy: `setStatus` mutates it in
 * place, so a handler that keeps the goal must snapshot it (`{ ...goal }`) to
 * hold on to the state it saw. Every other field is plain data and safe to
 * serialise.
 */
export type GoalEvent =
  "goalAdded" | "goalStatusChanged" | "goalRejected" | "goalRemoved";

/**
 * Handler for a goal queue event.
 *
 * The goal is the queue's own object, not a copy: `setStatus` mutates it in
 * place, so a handler that keeps the goal must snapshot it (`{ ...goal }`) to
 * hold on to the state it saw. Every other field is plain data and safe to
 * serialise.
 */
export type GoalEventHandler = (goal: Goal) => void;

export function isTerminalGoal(goal: Goal): boolean {
  return isTerminalGoalStatus(goal.status);
}

export function defaultGoalSelection(
  pending: Goal[],
  active: Goal[],
  achieved: ReadonlySet<string> = new Set(),
): Goal | undefined {
  const activeNames = new Set(active.map((g) => g.name));
  const candidates = pending
    .filter((g) => !activeNames.has(g.name))
    .filter(
      (g) => !g.dependsOn || g.dependsOn.every((depId) => achieved.has(depId)),
    )
    .sort((a, b) => b.priority - a.priority);

  return candidates[0];
}

export interface GoalQueueOptions {
  /**
   * Maximum number of unfinished goals (pending + active, sub-goals included)
   * the queue will hold. A goal offered once the limit is reached is admitted
   * and immediately failed rather than queued: see `goalRejected`.
   *
   * `0` or `Infinity` means unbounded, which is the default for a standalone
   * queue. Anything else must be a positive integer.
   */
  maxGoals?: number;
}

/**
 * Resolves a configured `maxGoals` to the queue's internal bound: `0` and
 * `Infinity` both mean unbounded, and anything other than a positive integer is
 * a configuration error rather than a silently-clamped number.
 */
export function resolveMaxGoals(
  value: number | undefined,
  unbounded: number,
): number {
  if (value === undefined) {
    return unbounded;
  }
  if (value === 0 || value === Infinity) {
    return Infinity;
  }
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(
    `maxGoals must be 0 (unbounded), Infinity, or a positive integer; got ${value}`,
  );
}

export class GoalQueue {
  private readonly goals = new Map<string, Goal>();
  /**
   * Ids per status, so the reasoning cycle reads the goals it can still act on
   * without walking every goal the agent has ever run.
   */
  private readonly byStatus: Record<GoalStatus, Set<string>> = {
    pending: new Set(),
    active: new Set(),
    achieved: new Set(),
    failed: new Set(),
    dropped: new Set(),
  };
  private readonly emitter = new EventEmitter();
  private readonly maxGoals: number;
  /** Ids that reached a terminal status, awaiting collection by `flush()`. */
  private finished: string[] = [];
  private selectFn: GoalSelectionFunction;
  /**
   * Ids of goals that have reached `achieved`, retained after they are
   * collected so a goal that declared a `dependsOn` on them can still see that
   * the dependency was met.
   *
   * An achieved goal leaves the queue at the end of the cycle that finished it,
   * and `dependsOn` is checked on a later cycle, so the queue's own status
   * index cannot answer the question by the time it is asked. Held here, keyed
   * by the goals that still reference them (see `depRefs`), so the record
   * outlives collection without outliving the work that needs it.
   */
  private readonly achievedDeps = new Set<string>();
  /** How many held goals each id is depended on by, to keep `achievedDeps` bounded. */
  private readonly depRefs = new Map<string, number>();

  /**
   * @param selectFn How to pick the next goal to work on. Defaults to
   *   `defaultGoalSelection`.
   * @param options Queue limits; see `GoalQueueOptions`.
   *
   * The selection function comes first so it stays the one-argument call it
   * always was; pass `undefined` to configure only the options.
   */
  constructor(
    selectFn: GoalSelectionFunction = defaultGoalSelection,
    options: GoalQueueOptions = {},
  ) {
    this.selectFn = selectFn;
    this.maxGoals = resolveMaxGoals(options.maxGoals, Infinity);
    this.emitter.setMaxListeners(0);
  }

  add<T = unknown>(goal: Goal<T>): void {
    const stored = { ...goal, status: goal.status ?? "pending" };

    // Checked before the insert: the bound is on goals already held, so a
    // `maxGoals: 1` queue admits its first goal and refuses the second.
    const refused =
      !isTerminalGoalStatus(stored.status) &&
      this.unfinishedCount() >= this.maxGoals;

    // Re-adding an id replaces the goal, so the one it replaces must leave the
    // status index first or it would be listed under a status it no longer has.
    const replaced = this.goals.get(stored.id);
    if (replaced) {
      this.byStatus[replaced.status].delete(stored.id);
    }

    this.goals.set(stored.id, stored);
    this.byStatus[stored.status].add(stored.id);
    this.emitter.emit("goalAdded", stored);

    // Dependencies are released only for the ids the replacement drops, so a
    // goal re-added with the same dependencies keeps its reference to an
    // already-achieved goal rather than losing the record mid-`add`.
    this.retainDependencies(stored);
    if (replaced) {
      this.releaseDependencies(replaced, new Set(stored.dependsOn ?? []));
    }

    // A goal added already achieved satisfies a dependency immediately, exactly
    // as one that reaches `achieved` later would.
    if (stored.status === "achieved" && this.depRefs.has(stored.id)) {
      this.achievedDeps.add(stored.id);
    }

    if (refused) {
      // Admitted so the refusal is a normal lifecycle the event stream can
      // describe, then failed: the goal is never selected and never worked on.
      this.emitter.emit("goalRejected", stored);
      this.setStatus(stored.id, "failed");
      return;
    }

    if (isTerminalGoalStatus(stored.status)) {
      this.finished.push(stored.id);
    }
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  setStatus(id: string, status: GoalStatus): void {
    const goal = this.goals.get(id);
    if (!goal) {
      return;
    }

    this.byStatus[goal.status].delete(id);
    goal.status = status;
    this.byStatus[status].add(id);
    this.emitter.emit("goalStatusChanged", goal);

    // Recorded before collection can take the goal away, so a dependent goal
    // still sees the dependency as met. Only kept while something references
    // it, so an agent that never uses `dependsOn` retains nothing.
    if (status === "achieved" && this.depRefs.has(id)) {
      this.achievedDeps.add(id);
    }

    if (isTerminalGoalStatus(status)) {
      this.finished.push(id);
    }
  }

  /**
   * Ids of goals that have reached `achieved` and are still referenced by some
   * held goal's `dependsOn`.
   *
   * This — not `getByStatus("achieved")` — is what dependency checks must read.
   * An achieved goal is collected at the end of the cycle that finished it, so
   * the status index only describes the current cycle; by the time a dependent
   * goal is considered, the goal it waits on has already left the queue.
   */
  achievedIds(): ReadonlySet<string> {
    return this.achievedDeps;
  }

  /** Whether every id a goal depends on has been met. Vacuously true without deps. */
  dependenciesMet(goal: Goal): boolean {
    return !goal.dependsOn?.length
      ? true
      : goal.dependsOn.every((depId) => this.achievedDeps.has(depId));
  }

  /** Records that `goal` now references each of its `dependsOn` ids. */
  private retainDependencies(goal: Goal): void {
    for (const depId of goal.dependsOn ?? []) {
      this.depRefs.set(depId, (this.depRefs.get(depId) ?? 0) + 1);
    }
  }

  /**
   * Drops the references `goal` held, skipping `keep` — the dependencies a
   * replacement goal carries on with. A dependency nobody references any more
   * is forgotten, so the record cannot outlive the work that needed it.
   */
  private releaseDependencies(goal: Goal, keep?: ReadonlySet<string>): void {
    for (const depId of goal.dependsOn ?? []) {
      if (keep?.has(depId)) {
        continue;
      }
      const remaining = (this.depRefs.get(depId) ?? 0) - 1;
      if (remaining > 0) {
        this.depRefs.set(depId, remaining);
      } else {
        this.depRefs.delete(depId);
        this.achievedDeps.delete(depId);
      }
    }
  }

  getByStatus(status: GoalStatus): Goal[] {
    const result: Goal[] = [];
    for (const id of this.byStatus[status]) {
      const goal = this.goals.get(id);
      if (goal) {
        result.push(goal);
      }
    }
    return result;
  }

  /**
   * Every goal that can still be worked on: pending and active, in that order.
   * Finished goals are excluded, so this is what the reasoning cycle iterates.
   */
  getUnfinished(): Goal[] {
    return [...this.getByStatus("pending"), ...this.getByStatus("active")];
  }

  /**
   * Whether a goal has reached `achieved` and is still in the queue. A goal
   * collected by `flush()` is no longer here, so this is only meaningful before
   * the next flush.
   *
   * To ask whether a *dependency* has been met, use `dependenciesMet` or
   * `achievedIds` — this reads the queue's current contents, which by the time
   * a dependent goal is considered no longer include anything that finished on
   * an earlier cycle.
   */
  isAchieved(id: string): boolean {
    return this.goals.get(id)?.status === "achieved";
  }

  /** Unfinished goals currently held: pending + active. */
  unfinishedCount(): number {
    return this.byStatus.pending.size + this.byStatus.active.size;
  }

  /** Whether the queue is already holding `maxGoals` unfinished goals. */
  atCapacity(): boolean {
    return this.unfinishedCount() >= this.maxGoals;
  }

  all(): Goal[] {
    return Array.from(this.goals.values());
  }

  selectNext(): Goal | undefined {
    const pending = this.getByStatus("pending");
    const active = this.getByStatus("active");
    return this.selectFn(pending, active, this.achievedDeps);
  }

  remove(id: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) {
      return false;
    }
    this.collect(id, goal);
    return true;
  }

  /**
   * Collects every goal that reached a terminal status since the last flush.
   *
   * Collection is deferred rather than done at the transition so that a job's
   * whole event sequence — `goalStatusChanged`, then the agent's
   * `intention:completed` — is delivered with the goal still in the queue. That
   * is what lets a listener on `intention:completed` see the goal as achieved.
   *
   * `Agent` calls this at the end of every cycle; a standalone queue has to
   * call it itself, since otherwise finished goals are never collected.
   */
  flush(): void {
    if (this.finished.length === 0) {
      return;
    }

    const ids = this.finished;
    this.finished = [];

    for (const id of ids) {
      const goal = this.goals.get(id);
      // A goal can leave the queue between being marked finished and being
      // flushed (an explicit remove, or a status moved back off a terminal
      // status), so the list is re-checked rather than trusted.
      if (!goal || !isTerminalGoalStatus(goal.status)) {
        continue;
      }
      this.collect(id, goal);
    }
  }

  private collect(id: string, goal: Goal): void {
    this.byStatus[goal.status].delete(id);
    this.goals.delete(id);
    // Whatever this goal was waiting on is no longer waited on, and an achieved
    // dependency nothing refers to any more is forgotten. The goal's own entry
    // in `achievedDeps` is deliberately left alone: a dependent goal still
    // needs to see that this one succeeded.
    this.releaseDependencies(goal);
    this.emitter.emit("goalRemoved", goal);
  }

  /**
   * Observes the queue. Returns an unsubscribe function.
   *
   * @example
   * ```ts
   * const off = goals.on("goalStatusChanged", (goal) => {
   *   console.log(goal.name, goal.status);
   * });
   * ```
   */
  on(event: GoalEvent, handler: GoalEventHandler): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }
}
