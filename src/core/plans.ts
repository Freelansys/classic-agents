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
 * - `"unsupported"` — the performative is a directive that does not ask the
 *   receiver to do the thing: `request-when`, which makes an action contingent
 *   on a condition evaluated against the **receiver's** own beliefs, or
 *   `subscribe`, which asks the receiver to monitor a proposition. Neither
 *   becomes a goal, and neither can be honoured by dropping the part that is
 *   hard — the condition is receiver-owned state the JSON bus cannot carry as a
 *   predicate, and there is no monitor. So the agent declines rather than
 *   silently doing something else, and a subclass that can represent it answers
 *   for itself; see {@link isUnsupportedDirective}.
 * - `"middleware"` — the application's `directiveMiddleware` chain declined
 *   before the agent decided on the request, by calling `res.refuse`, by
 *   cancelling, or by throwing. This is the reason an app-level policy produces,
 *   and it says the application would not rather than the agent could not: a
 *   request it turns away would otherwise have been agreed to. `detail` carries
 *   the explanation — the text a `res.refuse` handler wrote, or the error text
 *   where the chain threw.
 *
 * Every reason here is decided at admission, before any goal exists, rather
 * than from anything that happened while working: what the agent is able to do,
 * whether it has room, whether it is willing, and whether the ask is something it
 * can represent. Three of the four are facts about the agent; `"middleware"` is
 * the exception, being a decision the application took rather than one the agent
 * reached. Nothing that arises mid-goal produces a `refuse` — by then the agent
 * has already agreed, and the honest ending for work that was undertaken and
 * could not be completed is a `failure`, reported by the plan's own body.
 */
export type RefusalReason =
  "no-plan" | "capacity" | "unsupported" | "middleware";

/**
 * Decides whether a plan can start working a goal *right now*.
 *
 * Runs once per eligible goal per cycle, so keep it cheap and side-effect
 * free. Read `goal.data` to react to what the requester actually asked for and
 * `goal.source` to see who is asking; `beliefs` is the agent's own state.
 *
 * `true` starts an intention; `false` means *not yet* — the goal stays in the
 * queue, re-evaluated every cycle, and becomes servable if the fact it was
 * missing arrives.
 *
 * A trigger cannot decline. Whether this agent takes on a goal at all is
 * settled before a goal exists, by whether any plan {@link Plan.can} it, so by
 * the time a trigger runs the requester has already been sent an `agree` and
 * that commitment is not this function's to withdraw. Use `false` for a
 * precondition that has not arrived yet, and let the plan's body report a
 * `failure` if the work turns out to be impossible once attempted.
 */
export type TriggerFunction = (beliefs: BeliefBase, goal: Goal) => boolean;

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
   * The goal this plan declares it can do. Defaults to the plan's own name.
   *
   * This is the agent's capability, and it is what makes declining honest: the
   * set of goals an agent will agree to is exactly the set some plan declares
   * here, so a request it has no plan for is refused before it becomes a goal
   * rather than sitting in the queue forever with nothing able to serve it.
   *
   * Declaring is separate from deciding. `can` says this agent is *able* to do
   * this sort of work, which is FIPA's precondition on the receiver and is a
   * static fact about the agent. {@link Plan.trigger} then says whether *this*
   * goal, in *these* beliefs, can start *now*. Splitting them is what lets a
   * plan say "not yet" without being mistaken for "never".
   *
   * @example
   * ```ts
   * {
   *   name: "ship-order",
   *   can: "ship",                    // can do goals named "ship"
   *   trigger: (beliefs) => beliefs.has("order"), // not yet, until it arrives
   *   body: [ /* ... *\/ ],
   * }
   * ```
   */
  can?: string;
  trigger: TriggerFunction;
  body: Action[];
  /** Defaults to `"fail"` when omitted. */
  onChildFailure?: ChildFailurePolicy;
}

/** The goal name a plan declares it can do. */
export function planServes(plan: Plan, goalName: string): boolean {
  return (plan.can ?? plan.name) === goalName;
}

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
   * The first plan that can start this goal now, or `undefined` if none can
   * yet.
   *
   * `undefined` is not an answer to the requester — it means the goal waits —
   * so it says nothing about whether the agent is willing, only about whether
   * the preconditions are in place this cycle. Registration order breaks ties
   * between plans that can both serve a goal.
   */
  match(beliefs: BeliefBase, goal: Goal): Plan | undefined {
    for (const plan of this.plans) {
      if (planServes(plan, goal.name) && plan.trigger(beliefs, goal)) {
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
