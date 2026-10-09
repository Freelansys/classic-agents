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
    /**
     * Names the message this one answers, when the plan is answering something
     * of its own rather than the request the goal came from. Wins over the
     * `inReplyTo` the goal's `source` would otherwise contribute: a message
     * answered here is one the goal's source never saw.
     */
    inReplyTo?: string;
    /**
     * FIPA's `reply-by`: the latest time, as an ISO 8601 date-time, by which
     * the plan wants a reply. A directive sent without one gets the agent's
     * default (`replyTimeoutMs`); set it here to choose another deadline, or
     * `null` to send the directive with no deadline at all.
     */
    replyBy?: string | null;
    /**
     * FIPA's `reply-to`: the agent the receiver should send its replies to,
     * instead of this one. An exchange whose replies go elsewhere is not
     * tracked by this agent.
     */
    replyTo?: string;
  }>;
  failure?: { reason: string };
  beliefRemovals?: string[];
}

export interface Action {
  name: string;
  execute(intention: Intention, beliefs: BeliefBase): Promise<ActionResult>;
}

/**
 * Which of the decline categories an agent refused a goal under.
 *
 * FIPA separates declining from failing: a `refuse` says the receiver will not
 * perform the action, while a `failure` says it undertook the action and could
 * not carry it out. Only the second ever describes a job that was attempted.
 *
 * This is a library addition, not a FIPA term. FIPA's `refuse` carries a single
 * extra element, φ, which "gives the reason for the refusal" and is treated as
 * a causal explanation of why the agent will not act. That text lives beside
 * this category, in the refusal's `reason` — so `verdict` is the closed
 * vocabulary and `reason` is FIPA's φ. Naming them the other way round would
 * put "capacity" where the spec means a proposition about the world.
 *
 * - `"no-plan"` — no registered plan declares this goal, so the agent has no
 *   way to act on it. The most useful refusal there is, because it is the one
 *   a sender can act on: it is a wiring mistake, not a transient condition.
 *   Asked before the goal is created, so a request the agent could never have
 *   done costs it no queue slot.
 * - `"capacity"` — the agent is at its goal bound and is shedding load.
 *   Recoverable: the same request, offered later, may be agreed to. This is
 *   backpressure, not a judgement about the request. It is also the one verdict
 *   that over-claims against FIPA's own words — see below.
 * - `"unsupported"` — the agent understands the act but does not honour it:
 *   a `cfp`, which asks for a proposal inside a negotiation this library keeps
 *   no state for. (A `cancel` it cannot carry out is answered `failure`, as
 *   FIPA's cancel meta-protocol requires, not `refuse`.) The agent
 *   declines rather than silently doing something else, and a subclass that can
 *   honour it answers for itself; see {@link isUnsupportedDirective}.
 *   (`request-when`, `request-whenever` and `subscribe` were once refused here
 *   too, for want of a condition the bus could carry; named propositions and
 *   expressions supply one, and they are honoured.)
 * - `"middleware"` — the application's `directiveMiddleware` chain declined
 *   before the agent decided on the request, by calling `res.refuse`, by
 *   cancelling, or by throwing. This is the verdict an app-level policy
 *   produces, and it says the application would not rather than the agent could
 *   not: a request it turns away would otherwise have been agreed to. The
 *   refusal's `reason` carries the explanation — the text a `res.refuse` handler
 *   wrote, or the error text where the chain threw.
 *
 * Every category here is decided at admission, before any goal exists, rather
 * than from anything that happened while working: what the agent is able to do,
 * whether it has room, whether it is willing, and whether the ask is something it
 * can represent. Three of the four are facts about the agent; `"middleware"` is
 * the exception, being a decision the application took rather than one the agent
 * reached. Nothing that arises mid-goal produces a `refuse` — by then the agent
 * has already agreed, and the honest ending for work that was undertaken and
 * could not be completed is a `failure`, reported by the plan's own body.
 *
 * A note on how far a refusal reaches. FIPA defines `refuse` as a disconfirmation
 * that the action is feasible, followed by an inform that it was not done and
 * that the sender does not intend it — a permanent claim. `"capacity"` is not
 * that: the action is perfectly feasible, there is simply no room for it right
 * now, and this agent would agree later. FIPA has no act for "not today" and its
 * own request protocol answers a refusal with `refuse`, so reusing the act is
 * protocol-conformant, but the over-claim is real and a sender must read
 * `"capacity"` as transient and the other three as settled. That split is the
 * practical point of having a vocabulary at all.
 */
export type RefusalVerdict =
  "no-plan" | "capacity" | "unsupported" | "middleware";

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

/**
 * A capability: the named sequence of actions the agent can perform.
 *
 * A plan is what the agent can *do*, and its `name` is the goal it does it
 * for. A request names that goal — selection is an RPC by name — so this
 * library keeps no predicate on a plan that could delay or veto the work. A
 * request for a plan the agent declares runs on the next cycle; if the
 * receiver is not ready, its body says so with a `failure`, FIPA's ending for
 * work that was undertaken and could not be completed.
 *
 * Deferring on a condition is not `request`'s business. FIPA puts a condition
 * on the wire in `request-when`, where the *sender* names it; a plan that
 * quietly waited on its own trigger would be a request-when in disguise,
 * promising on the sender's behalf a condition the sender never wrote. So a
 * plan carries no trigger, and the body is the only thing that can stop work
 * once the agent has agreed to it.
 *
 * @example
 * ```ts
 * {
 *   name: "ship",                   // serves goals named "ship"
 *   body: [ /* ... *\/ ],
 * }
 * ```
 */
export interface Plan {
  name: string;
  body: Action[];
  /** Defaults to `"fail"` when omitted. */
  onChildFailure?: ChildFailurePolicy;
  /**
   * Whether a request this plan is working may be withdrawn by its requester's
   * `cancel` once the plan has started. Defaults to `false`: the library cannot
   * know whether stopping between two of this plan's actions leaves the world
   * in a state anyone would want, so only the plan's author can say so.
   *
   * A request that has not started — every goal in it still pending — can be
   * cancelled whatever this says. A started one is cancelled only if every plan
   * working it is cancellable, and never mid-action: an action that is running
   * finishes, and the next one does not start.
   */
  cancellable?: boolean;
  /**
   * Clean-up run when a request this plan was working is cancelled: undo or
   * compensate for what the actions that already ran did. Receives the
   * intention as it was stopped, so `actionIndex` says how far it got. Its
   * belief updates and messages are applied; new goals are not. A clean-up that
   * fails or throws does not stop the cancel — the work is stopped either way —
   * and is reported to the canceller and on `goal:cancelled`.
   */
  onCancel?: Action;
}

/** Whether a plan's name is the goal it serves. */
export function planServes(plan: Plan, goalName: string): boolean {
  return plan.name === goalName;
}

export class PlanLibrary {
  private readonly plans: Plan[] = [];

  register(plan: Plan): void {
    this.plans.push(plan);
  }

  /**
   * Whether any plan serves this goal.
   *
   * The check that lets an agent tell "I cannot do this" from a request it
   * will take on: the set of goals an agent agrees to is exactly the set some
   * plan is named for, so a request it has no plan for is refused as
   * `no-plan` before a goal is created rather than left in the queue with
   * nothing able to serve it.
   */
  declares(goalName: string): boolean {
    return this.plans.some((p) => planServes(p, goalName));
  }

  /**
   * The plan that serves this goal, or `undefined` when the agent has none.
   *
   * Selection is by name alone — an RPC — so the result says whether the agent
   * is *able*, not whether it is ready this cycle. Registration order breaks
   * ties between plans that serve the same goal, which is how a variant can be
   * given precedence.
   */
  match(goal: Goal): Plan | undefined {
    return this.plans.find((plan) => planServes(plan, goal.name));
  }

  all(): Plan[] {
    return [...this.plans];
  }
}
