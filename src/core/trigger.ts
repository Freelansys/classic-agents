import { isTerminalGoalStatus, type Goal, type GoalQueue } from "./goals.js";

/**
 * When a {@link Trigger} fires on the condition it watches.
 *
 * - `"edge"`: once each time the condition goes from not holding to holding —
 *   including the first observation, if it already holds. A rising edge that
 *   cannot fire yet (no room, a goal still in flight) is held until it can,
 *   even if the condition has fallen meanwhile.
 * - `"level"`: whenever the condition holds and nothing stops it. Only
 *   meaningful with `oneInFlight`, which is what keeps it from firing every
 *   cycle.
 */
export type TriggerMode = "edge" | "level";

/** How a {@link Trigger} behaves. */
export interface TriggerOptions {
  mode: TriggerMode;
  /**
   * Hold off firing while the last goal it fired is unfinished, so it never
   * has more than one goal outstanding.
   */
  oneInFlight?: boolean;
  /**
   * After a goal it fired ends `failed`, wait this long (ms) before firing
   * again, so a goal that keeps failing is not re-run every cycle. 0 or unset
   * waits for nothing.
   */
  retryAfterMs?: number;
}

/** What a {@link Trigger.observe} saw change. */
export interface TriggerChange {
  /** The condition went from not holding (or never observed) to holding. */
  rose: boolean;
  /** The condition went from holding to not holding. */
  fell: boolean;
}

/**
 * The firing rule a condition-driven goal source follows: watch a condition
 * cycle by cycle, decide when a goal is due, and hold the firing until the goal
 * queue has room for it.
 *
 * Shared by the two things that turn a condition into work — a standing
 * `request-when` / `request-whenever` the agent agreed to, and a desire it
 * holds of its own accord — so both detect edges, wait for room, and pace
 * themselves the same way. A trigger only decides *when*; the caller creates
 * the goal and tells the trigger with {@link fired}.
 *
 * An evaluation that errored says nothing about the condition, so it should
 * not be {@link observe}d at all: the trigger then keeps what it last saw, and
 * a flaky condition does not produce a false edge.
 */
export class Trigger {
  /** What the condition last did; `undefined` until it is first observed. */
  private last: boolean | undefined;
  /** A firing is owed. */
  private due = false;
  /** The goal last fired, while it may still be unfinished. */
  private inFlight: Goal | undefined;
  /** No firing before this time (ms since epoch): the retry delay. */
  private notBefore = 0;

  constructor(private readonly options: TriggerOptions) {}

  /** The trigger's mode. */
  get mode(): TriggerMode {
    return this.options.mode;
  }

  /**
   * Records whether the condition holds now, and returns what changed. A
   * rising edge makes a firing due (`"edge"`); in `"level"` mode a firing is
   * due exactly while the condition holds.
   */
  observe(holds: boolean): TriggerChange {
    const rose = holds && this.last !== true;
    const fell = !holds && this.last === true;
    this.last = holds;
    if (this.options.mode === "level") {
      this.due = holds;
    } else if (rose) {
      this.due = true;
    }
    return { rose, fell };
  }

  /**
   * The goal this trigger last fired, while it is unfinished; `undefined` once
   * it has ended (or if nothing was fired). The goal is the queue's own live
   * object, so its status is current even after the queue has collected it.
   */
  outstanding(now = Date.now()): Goal | undefined {
    this.settle(now);
    return this.inFlight;
  }

  /**
   * Whether a firing is due and may go ahead now: owed, not held back by a
   * goal still in flight (`oneInFlight`) or by the retry delay, and with room
   * in `goals`. At the bound the firing stays due — backpressure, not a
   * refusal — and is ready again once there is room.
   */
  ready(goals: GoalQueue, now = Date.now()): boolean {
    this.settle(now);
    if (!this.due) return false;
    if (this.options.oneInFlight && this.inFlight) return false;
    if (now < this.notBefore) return false;
    return !goals.atCapacity();
  }

  /**
   * Records that the due firing went ahead and created `goal`. An edge is
   * consumed; a level stays due, held back by `oneInFlight` until the goal
   * ends.
   */
  fired(goal: Goal | undefined): void {
    if (this.options.mode === "edge") {
      this.due = false;
    }
    this.inFlight = goal;
  }

  /** Forgets a goal in flight that has ended, starting the retry delay if it failed. */
  private settle(now: number): void {
    const goal = this.inFlight;
    if (!goal || !isTerminalGoalStatus(goal.status)) return;
    this.inFlight = undefined;
    if (goal.status === "failed" && this.options.retryAfterMs) {
      this.notBefore = now + this.options.retryAfterMs;
    }
  }
}
