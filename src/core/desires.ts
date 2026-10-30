import type { BeliefBase } from "./beliefs.js";
import type { TriggerMode } from "./trigger.js";

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
  /**
   * The name of the goal to generate. A plan must serve it: a goal no plan
   * declares is not generated, and the desire is reported on `desire:error`.
   */
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
  /**
   * The name of a registered proposition the generated goal waits for,
   * recorded as its `Goal.when`: it is not selected until the proposition
   * holds.
   */
  when?: string;
  /**
   * Which item this goal is about, when `intend` returns several: each is
   * fired, paced and retracted on its own, by key. Recorded as the generated
   * goal's `Goal.key`, so the default selection runs goals about
   * different items in parallel and never two about the same item.
   *
   * Defaults to the goal's name and `data`, compared by value. Set it when
   * `data` carries values that change while it is still the same item — a
   * score, a timestamp — or every change would count as a new item: `key:
   * lead.id`. Keys must be unique within one answer of `intend`.
   *
   * A desire that returns a single goal is one item whatever its key, as it
   * always was; the key then only becomes the goal's.
   */
  key?: string;
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
 * (and stops) asking, and, by default, fire on the rising edge of that moment
 * — the same firing rule a standing `request-whenever` follows.
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
 * flag, a threshold, a pattern — not a place to do work. One that throws is
 * reported on `desire:error` and leaves the desire as it was: an error says
 * nothing about whether it is asking. (A belief store that answers asynchronously is out of scope:
 * `BeliefBase` reads are synchronous.)
 *
 * A desire may also return several goals at once — one per item that needs
 * work — and fan out: each item, told apart by its `key`, has its own trigger,
 * so it fires, waits for its goal, retries and is retracted independently of
 * the others. An item that drops out of the list has stopped asking.
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
 *
 * // One `qualify` goal per new lead, run side by side.
 * desires.register({
 *   name: "qualify-leads",
 *   intend: (beliefs) =>
 *     (beliefs.get<Lead[]>("leads.new") ?? []).map((lead) => ({
 *       goal: "qualify",
 *       key: lead.id,
 *       data: lead,
 *     })),
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
   * What the desire wants now: the goal to pursue, the goals to pursue — one
   * per item, told apart by `key` — or `undefined` (or `[]`) if it is not
   * asking for anything. Evaluated against the agent's beliefs once per cycle,
   * synchronously and without side effects. One that throws is reported on
   * `desire:error` and changes nothing: it neither fires nor stops asking.
   */
  intend: (
    beliefs: BeliefBase,
  ) => DesiredGoal<T> | readonly DesiredGoal<T>[] | undefined;
  /**
   * When the desire fires — the same firing rule a standing `request-whenever`
   * follows (see `Trigger`).
   *
   * - `"edge"` (default): on the rising edge of its asking — when `intend`
   *   goes from returning nothing to returning a goal. It does not fire again
   *   while the desire keeps asking, so a goal that succeeds without changing
   *   the beliefs does not immediately trigger another; it fires again only
   *   after `intend` has returned nothing and then a goal once more. This is
   *   the safe default: "pursue X while P" means one attempt per occurrence of
   *   P, as `request-whenever` does.
   * - `"level"`: whenever it is asking and has no goal in flight, so a
   *   recurring or maintenance goal is started again as soon as the previous
   *   one finishes. A goal that failed is retried only after
   *   {@link retryAfterMs}.
   *
   * Either way, at most one goal this desire generated is ever outstanding
   * per item: it does not fire again for an item until that item's goal
   * leaves the queue. A desire returning a single goal is one item.
   */
  trigger?: TriggerMode;
  /**
   * How long (ms) to wait after a goal this desire generated has failed before
   * firing again for the same item. Keeps a goal that fails every time — no applicable plan, a
   * plan that cannot succeed in the current state — from being re-run every
   * cycle. Defaults to 1000; 0 retries at once.
   */
  retryAfterMs?: number;
  /**
   * What happens to the goal in flight when the desire stops asking for it —
   * or, for a desire that fans out, when an item drops out of its answer.
   *
   * - `"keep"` (default): nothing; the goal runs to its end.
   * - `"withdraw"`: the goal is withdrawn as a requester's `cancel` would
   *   withdraw it — at once if nothing has started, otherwise only if every
   *   started plan is `cancellable`, and never mid-action. Each attempt is
   *   reported on `desire:retracted`; a goal that cannot be withdrawn carries
   *   on, and is reported on `desire:error` as well (logged when nobody
   *   listens there).
   */
  onRetract?: "keep" | "withdraw";
}

/**
 * The desires an agent holds, in evaluation order.
 *
 * Like a {@link PlanLibrary}, it is fixed at construction and may be extended
 * at runtime with {@link register}. Registration order is the order desires are
 * considered each cycle. When several are due and the goal queue has room for
 * only some, the goals asked for with the highest priority are generated
 * first, ties going to registration order.
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
