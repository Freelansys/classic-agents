import type { BeliefBase } from "./beliefs.js";

/**
 * The goal a desire wants the agent to pursue, as {@link Desire.intend} returns
 * it: a goal descriptor — the same shape an action `spawn`s (`{ name, priority,
 * data? }`, with a `goal` name in place of `name`) — or `undefined` for "not
 * now".
 *
 * It is *returned*, never applied by the desire itself: the framework creates
 * the goal. That is what keeps `intend` a pure function of the beliefs, safe to
 * re-evaluate every cycle while the agent watches for the moment the desire
 * starts — and stops — asking.
 */
export interface DesiredGoal<T = unknown> {
  /** The name of the goal to generate. A plan must serve it. */
  goal: string;
  /**
   * Priority of the generated goal. Defaults to 5, the same default a
   * self-delegated sub-goal uses. Computed with the rest of the descriptor, so
   * it can depend on the situation.
   */
  priority?: number;
  /** The generated goal's data. */
  data?: T;
  /**
   * Ids of goals the generated goal depends on, forwarded to the queue. The
   * generated goal is not selected until each has been achieved.
   */
  dependsOn?: string[];
}

/**
 * A standing preference the agent holds over its own beliefs: *when my beliefs
 * say so, pursue this goal.*
 *
 * A desire is what lets an agent start work of its own accord, without a
 * directive arriving on the bus. The whole desire is one pure function,
 * {@link Desire.intend}, evaluated once per reasoning cycle against the
 * beliefs. It returns the goal to pursue now, or `undefined` when the desire is
 * not asking for anything. Because the goal is *returned* — the framework
 * creates it — `intend` has no side effects, so it is safe to run on every
 * cycle. That is what lets the agent watch for the moment the desire begins
 * (and stops) asking, and, by default, fire on the rising edge of that moment.
 *
 * When it fires, the goal generated is the same goal a `request` would have
 * created, only with no requester: no `agree`, no `refuse`, and no terminal
 * `inform`/`failure`, because there is nobody to send them to. Everything after
 * creation is identical. The goal is queued, planned, executed, and can fail,
 * `onGoalFailure` and all.
 *
 * Keep `intend` fast and synchronous, and free of side effects: it reads the
 * beliefs, exactly as a {@link Plan.context} does, and is held to the same
 * discipline. A desire is a quick read of what the agent already believes — a
 * flag, a threshold, a pattern — not a place to do work. One that throws counts
 * as not asking. (A belief store that answers asynchronously is out of scope:
 * `BeliefBase` reads are synchronous.)
 *
 * @example
 * ```ts
 * desires.register({
 *   name: "cool-room",
 *   intend: (beliefs) =>
 *     (beliefs.get<number>("room.temperature") ?? 0) > 30
 *       ? { goal: "cool", priority: 8, data: { at: beliefs.get("room.id") } }
 *       : undefined,
 * });
 * ```
 */
export interface Desire<T = unknown> {
  /**
   * The desire's own name. Unique within a {@link DesireLibrary}, and recorded
   * on the goals it generates (see `Goal.desire`) so a monitor can attribute
   * them.
   */
  name: string;
  /**
   * What the desire wants now: the goal to pursue, or `undefined` if it is not
   * asking for anything. Evaluated against the agent's beliefs once per cycle,
   * synchronously and without side effects. One that throws counts as not
   * asking.
   */
  intend: (beliefs: BeliefBase) => DesiredGoal<T> | undefined;
  /**
   * When the desire may fire again after the goal it generated has finished.
   *
   * - `"once"` (default): the desire fires on the rising edge of its asking —
   *   when `intend` goes from returning nothing to returning a goal. It does
   *   not fire while the desire keeps asking, so a goal that succeeds without
   *   changing the beliefs does not immediately trigger another; it fires again
   *   only after `intend` has returned nothing and then a goal once more. This
   *   is the safe default: it makes "pursue X while P" mean one attempt per
   *   occurrence of P.
   * - `"always"`: the desire fires whenever it is asking and it has no goal in
   *   flight, so a recurring or maintenance goal is started again as soon as
   *   the previous one finishes. Use it deliberately: if `intend` never returns
   *   nothing, this re-runs the goal continuously.
   *
   * Either way, at most one goal this desire generated is ever outstanding: it
   * does not fire again until that goal leaves the queue.
   */
  repeat?: "once" | "always";
}

/**
 * The desires an agent holds, in evaluation order.
 *
 * Like a {@link PlanLibrary}, it is fixed at construction and may be extended
 * at runtime with {@link register}. Registration order is the order desires are
 * considered each cycle; because each generates a distinct goal, order only
 * matters when two desires compete for the last unit of goal-queue capacity.
 */
export class DesireLibrary {
  private readonly desires: Desire[] = [];

  /**
   * Adds a desire.
   *
   * @throws If a desire of the same name is already registered: the name is
   *   what attributes the goals it generates, so two desires may not share one.
   */
  register(desire: Desire): void {
    if (this.desires.some((d) => d.name === desire.name)) {
      throw new Error(
        `a desire named "${desire.name}" is already registered; give each desire its own \`name\``,
      );
    }
    this.desires.push(desire);
  }

  /** Whether a desire of this name is registered. */
  declares(name: string): boolean {
    return this.desires.some((d) => d.name === name);
  }

  /** Every registered desire, in registration order. */
  all(): Desire[] {
    return [...this.desires];
  }
}
