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
 * What a trigger has seen: the whole of it, so the firing rule can be kept as
 * a value and moved on with the functions below, each of which returns the
 * next state rather than changing the one it is given. {@link Trigger} wraps
 * them for a caller that would rather hold an object.
 */
export interface TriggerState {
  /** What the condition last did; absent until it is first observed. */
  readonly last?: boolean;
  /** A firing is owed. */
  readonly due: boolean;
  /**
   * The goal last fired, while it may still be unfinished: the queue's own
   * live object, so its status is current even after the queue collected it.
   */
  readonly inFlight?: Goal;
  /** No firing before this time (ms since epoch): the retry delay. */
  readonly notBefore: number;
}

/** A trigger that has seen nothing yet. */
export const INITIAL_TRIGGER_STATE: TriggerState = Object.freeze({
  due: false,
  notBefore: 0,
});

/**
 * Records whether the condition holds now: the next state, and what changed.
 * A rising edge makes a firing due (`"edge"`); in `"level"` mode a firing is
 * due exactly while the condition holds.
 */
export function observeTrigger(
  state: TriggerState,
  options: TriggerOptions,
  holds: boolean,
): { state: TriggerState; change: TriggerChange } {
  const rose = holds && state.last !== true;
  const fell = !holds && state.last === true;
  const due = options.mode === "level" ? holds : state.due || rose;
  return { state: { ...state, last: holds, due }, change: { rose, fell } };
}

/** Forgets a goal in flight that has ended, starting the retry delay if it failed. */
export function settleTrigger(
  state: TriggerState,
  options: TriggerOptions,
  now = Date.now(),
): TriggerState {
  const goal = state.inFlight;
  if (!goal || !isTerminalGoalStatus(goal.status)) return state;
  const { inFlight: _ended, ...rest } = state;
  return goal.status === "failed" && options.retryAfterMs
    ? { ...rest, notBefore: now + options.retryAfterMs }
    : rest;
}

/**
 * Whether a firing is due and may go ahead now: owed, not held back by a goal
 * still in flight (`oneInFlight`) or by the retry delay, and with room in
 * `goals`. At the bound the firing stays due — backpressure, not a refusal —
 * and is ready again once there is room. Pass a {@link settleTrigger}d state.
 */
export function triggerReady(
  state: TriggerState,
  options: TriggerOptions,
  goals: GoalQueue,
  now = Date.now(),
): boolean {
  if (!state.due) return false;
  if (options.oneInFlight && state.inFlight) return false;
  if (now < state.notBefore) return false;
  return !goals.atCapacity();
}

/**
 * Records that the due firing went ahead and created `goal`. An edge is
 * consumed; a level stays due, held back by `oneInFlight` until the goal ends.
 */
export function fireTrigger(
  state: TriggerState,
  options: TriggerOptions,
  goal: Goal | undefined,
): TriggerState {
  const { inFlight: _previous, ...rest } = state;
  return {
    ...rest,
    due: options.mode === "edge" ? false : state.due,
    ...(goal ? { inFlight: goal } : {}),
  };
}

/**
 * Whether the trigger holds nothing worth keeping: the condition does not
 * hold, no goal is in flight and no retry delay is running. Pass a
 * {@link settleTrigger}d state; see {@link Trigger.idle}.
 */
export function triggerIdle(state: TriggerState, now = Date.now()): boolean {
  return state.last !== true && !state.inFlight && now >= state.notBefore;
}

/**
 * The firing rule a condition-driven goal source follows: watch a condition
 * cycle by cycle, decide when a goal is due, and hold the firing until the goal
 * queue has room for it.
 *
 * Shared by the two things that turn a condition into work again and again —
 * a standing `request-whenever` the agent agreed to, and a desire it
 * holds of its own accord — so both detect edges, wait for room, and pace
 * themselves the same way. A trigger only decides *when*; the caller creates
 * the goal and tells the trigger with {@link fired}.
 *
 * An evaluation that errored says nothing about the condition, so it should
 * not be {@link observe}d at all: the trigger then keeps what it last saw, and
 * a flaky condition does not produce a false edge.
 */
export class Trigger {
  private current: TriggerState = INITIAL_TRIGGER_STATE;

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
    const { state, change } = observeTrigger(this.current, this.options, holds);
    this.current = state;
    return change;
  }

  /**
   * The goal this trigger last fired, while it is unfinished; `undefined` once
   * it has ended (or if nothing was fired). The goal is the queue's own live
   * object, so its status is current even after the queue has collected it.
   */
  outstanding(now = Date.now()): Goal | undefined {
    this.settle(now);
    return this.current.inFlight;
  }

  /**
   * Whether a firing is due and may go ahead now: owed, not held back by a
   * goal still in flight (`oneInFlight`) or by the retry delay, and with room
   * in `goals`. At the bound the firing stays due — backpressure, not a
   * refusal — and is ready again once there is room.
   */
  ready(goals: GoalQueue, now = Date.now()): boolean {
    this.settle(now);
    return triggerReady(this.current, this.options, goals, now);
  }

  /**
   * Records that the due firing went ahead and created `goal`. An edge is
   * consumed; a level stays due, held back by `oneInFlight` until the goal
   * ends.
   */
  fired(goal: Goal | undefined): void {
    this.current = fireTrigger(this.current, this.options, goal);
  }

  /**
   * Whether the trigger holds nothing worth keeping: the condition does not
   * hold, no goal is in flight and no retry delay is running. Should the
   * condition hold again, a fresh trigger would see the same rising edge, so
   * an idle one can be discarded — which is how a caller watching many
   * conditions keeps its triggers bounded. (An edge still owed from before the
   * condition fell is lost with it; a caller that discards a trigger is one
   * that could not have fired it without the condition holding anyway.)
   */
  idle(now = Date.now()): boolean {
    this.settle(now);
    return triggerIdle(this.current, now);
  }

  /** What this trigger has seen; see {@link TriggerState}. */
  state(): TriggerState {
    return this.current;
  }

  /** Forgets a goal in flight that has ended, starting the retry delay if it failed. */
  private settle(now: number): void {
    this.current = settleTrigger(this.current, this.options, now);
  }
}
