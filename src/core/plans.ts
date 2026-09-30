import type { BeliefBase } from "./beliefs.js";
import type { Performative } from "../bus/performatives.js";
import type { Goal } from "./goals.js";
import type { Intention } from "./intentions.js";

export interface ActionResult {
  beliefUpdates?: Array<{ key: string; value: unknown }>;
  newGoals?: Array<{ name: string; priority: number; data?: unknown }>;
  messages?: Array<{
    receiver?: string;
    topic?: string;
    /**
     * The speech act the message performs. Typed rather than free-form so a
     * plan cannot send a performative no receiver will recognise: an
     * unrecognised one is perceived and produces nothing, which is a bug that
     * otherwise only shows up as a plan that seems to do nothing.
     */
    performative: Performative;
    content: unknown;
  }>;
  failure?: { reason: string };
  beliefRemovals?: string[];
}

export interface Action {
  name: string;
  execute(intention: Intention, beliefs: BeliefBase): Promise<ActionResult>;
}

/**
 * Why an agent declined a goal.
 *
 * FIPA separates declining from failing: a `refuse` says the receiver will not
 * perform the action, while a `failure` says it undertook the action and could
 * not carry it out. Only the second ever describes a job that was attempted.
 *
 * - `"no-plan"` — no registered plan declares this goal, so the agent has no
 *   way to act on it. The most useful refusal there is, because it is the one
 *   a sender can act on: it is a wiring mistake, not a transient condition.
 *   Asked before the goal is created, so a request the agent could never have
 *   done costs it no queue slot.
 * - `"capacity"` — the agent is at its goal bound and is shedding load.
 *   Recoverable: the same request, offered later, may be agreed to. This is
 *   backpressure, not a judgement about the request.
 * - `"predicate"` — a `canAccept` or a plan `trigger` said no. The agent could
 *   serve this kind of goal but will not serve this one, and says why in
 *   `detail`. The default when no more specific reason is given.
 */
export type RefusalReason = "no-plan" | "capacity" | "predicate";

/**
 * A plan declining a specific goal, returned from a {@link TriggerFunction}.
 *
 * A refusal is a decision, not a lack of knowledge: the plan has declared it
 * serves this goal and is declining this instance. The distinction from
 * returning `false` matters, because `false` means "not yet" and is retried
 * every cycle.
 */
export interface PlanRefusal {
  refuse: true;
  /** Defaults to `"predicate"`. */
  reason?: RefusalReason;
  /** The plan's own explanation, forwarded to the sender. */
  detail?: string;
}

/**
 * What a trigger decides about one goal, right now.
 *
 * - `true` — serve it. An intention is created.
 * - `false` — *not yet*. Nothing happens and the goal stays in the queue,
 *   re-evaluated every cycle. Use this when a precondition is missing (a
 *   belief that has not arrived, a resource that is not free yet); it is not a
 *   refusal, and a goal left here can still become servable later.
 * - a string — refuse, with that string as the sender-facing detail.
 * - a {@link PlanRefusal} — refuse, naming a {@link RefusalReason}.
 */
export type TriggerVerdict = boolean | string | PlanRefusal;

/**
 * Decides whether a plan will serve a goal, and may decline it.
 *
 * Runs once per eligible goal per cycle, so keep it cheap and side-effect
 * free. Read `goal.data` to react to what the requester actually asked for and
 * `goal.source` to see who is asking; `beliefs` is the agent's own state.
 */
export type TriggerFunction = (
  beliefs: BeliefBase,
  goal: Goal,
) => TriggerVerdict;

/**
 * Reads a trigger's verdict as a refusal, or `undefined` for "serve" and
 * "not yet".
 */
function asRefusal(verdict: TriggerVerdict): PlanRefusal | undefined {
  if (typeof verdict === "string") {
    return { refuse: true, detail: verdict };
  }
  if (typeof verdict === "object" && verdict.refuse) {
    return verdict;
  }
  return undefined;
}

/**
 * What an intention does when one of the sub-goals it is waiting for fails.
 *
 * - `"fail"` (default): the waiting intention fails too, with the sub-goal's
 *   reason, and the failure keeps cascading to its own waiting parents.
 * - `"continue"`: the plan can recover — the failed sub-goal is forgotten and
 *   the intention resumes with its next action, with the failure recorded in
 *   `intention.childFailures` for that action to inspect.
 */
export type ChildFailurePolicy = "fail" | "continue";

export interface Plan {
  name: string;
  /**
   * The goal this plan declares it serves. Defaults to the plan's own name.
   *
   * This is the declaration that makes declining honest. A plan library is
   * fixed for the agent's lifetime, so "no plan declares this goal" is knowable
   * without running anything — which is what lets a request the agent could
   * never have done be refused before it becomes a goal, rather than sitting in
   * the queue forever with nothing able to serve it.
   *
   * Declaring is separate from deciding. The plan declares what kind of work it
   * does; {@link Plan.trigger} then decides whether *this* goal, in *these*
   * beliefs, is work it will take on right now. Splitting them is what lets a
   * plan say "not yet" without being mistaken for "never".
   *
   * @example
   * ```ts
   * {
   *   name: "ship-order",
   *   respondTo: "ship",              // serves goals named "ship"
   *   trigger: (beliefs, goal) =>
   *     beliefs.has("order") ? true   // not yet, until the order arrives
   *       : { refuse: true, detail: "no order on file" },
   *   body: [ /* ... *\/ ],
   * }
   * ```
   */
  respondTo?: string;
  trigger: TriggerFunction;
  body: Action[];
  /** Defaults to `"fail"` when omitted. */
  onChildFailure?: ChildFailurePolicy;
}

/** The goal name a plan declares it serves. */
export function planServes(plan: Plan, goalName: string): boolean {
  return (plan.respondTo ?? plan.name) === goalName;
}

/**
 * The outcome of matching a goal against the library: a plan that will serve
 * it, or a refusal from one that declares it but declines this instance.
 *
 * `undefined` means neither — no plan declares the goal, or the plans that do
 * are not willing *yet*. Only the first two are answers to a requester.
 */
export type PlanMatch =
  | { plan: Plan; refusal?: undefined }
  | { plan?: undefined; refusal: PlanRefusal }
  | undefined;

export class PlanLibrary {
  private readonly plans: Plan[] = [];

  register(plan: Plan): void {
    this.plans.push(plan);
  }

  /**
   * Whether any plan declares it serves this goal, regardless of beliefs.
   *
   * Purely static: no trigger runs. This is the check that lets an agent tell
   * "I could never do this" from "I cannot do this yet", and it is only sound
   * because a plan says up front what it does instead of being guessed at from
   * whether its trigger happens to fire for a nonsense goal.
   */
  declares(goalName: string): boolean {
    return this.plans.some((p) => planServes(p, goalName));
  }

  /**
   * The first plan willing to serve this goal, or a refusal from a plan that
   * declares it.
   *
   * A plan that will serve the goal always wins over one that refuses it: two
   * plans can legitimately declare the same goal, and one declining must not
   * preempt the other actually being able to do the work.
   */
  match(beliefs: BeliefBase, goal: Goal): PlanMatch {
    let refusal: PlanRefusal | undefined;

    for (const plan of this.plans) {
      if (!planServes(plan, goal.name)) {
        continue;
      }

      const verdict = plan.trigger(beliefs, goal);
      if (verdict === true) {
        return { plan };
      }
      refusal ??= asRefusal(verdict);
    }

    return refusal ? { refusal } : undefined;
  }

  /** The first plan willing to serve this goal, ignoring any refusal. */
  findApplicable(beliefs: BeliefBase, goal: Goal): Plan | undefined {
    for (const plan of this.plans) {
      if (planServes(plan, goal.name) && plan.trigger(beliefs, goal) === true) {
        return plan;
      }
    }
    return undefined;
  }

  findAll(beliefs: BeliefBase, goal: Goal): Plan[] {
    return this.plans.filter(
      (p) => planServes(p, goal.name) && p.trigger(beliefs, goal) === true,
    );
  }

  all(): Plan[] {
    return [...this.plans];
  }
}
