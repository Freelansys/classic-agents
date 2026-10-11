import type { BeliefBase } from "./beliefs.js";
import type { Performative } from "../bus/performatives.js";
import type { Goal } from "./goals.js";
import type { Intention } from "./intentions.js";

export interface ActionResult {
  beliefUpdates?: Array<{ key: string; value: unknown }>;
  /**
   * The answer the goal produced. When the goal is achieved it goes back with
   * the work: as `result` in the `inform { goal, goalId, done: true }` sent to
   * whoever requested it, and as `Delegation.result` on an intention that
   * delegated it to this agent. An action that sets it again replaces it, so
   * the last one set before the goal is achieved is the answer.
   *
   * This is how a request returns a computed answer — the counterpart of a
   * query, which only reads what the agent already knows. Must be
   * JSON-serialisable to cross the bus.
   */
  result?: unknown;
  /**
   * New root goals for this agent: independent work the plan starts and does
   * not wait for. A spawned goal has no parent and no `source` — it is not
   * part of the request this intention serves, so it is not dropped when this
   * goal fails, not withdrawn by a `cancel` of it, and not answered to anyone.
   *
   * To start work and wait for it, delegate it instead (`delegations`), to this
   * agent or another.
   */
  spawn?: Array<{ name: string; priority: number; data?: unknown }>;
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
  /**
   * Sub-goals the intention waits for, served by this agent or another. The
   * intention waits until every delegation has settled; one that fails is a
   * failed child, handled by its `onFailure`. See
   * {@link DelegationRequest}.
   */
  delegations?: DelegationRequest[];
  /**
   * How many of this action's `delegations` must succeed before the intention
   * resumes: `"all"` (the default), `"any"`, or a number (capped at how many
   * there are). Once that many are done, the rest are no longer needed and
   * are cancelled — a remote delegate is sent a `cancel`, a sub-goal is
   * withdrawn — so `"any"` is a race: ask several, take the first answer.
   *
   * A race suits interchangeable, idempotent work only: every delegate does
   * the whole job, and a losing one may refuse the cancel or finish before it
   * arrives, so its work may still take effect. Choosing among providers by
   * what they offer, where only the chosen one should act, is the Contract
   * Net's job (`cfp`/`propose`/`accept-proposal`), not a race.
   *
   * A failure on the way is recorded in `intention.childFailures` and fails
   * nothing while the target can still be met. Once it cannot, the intention
   * fails if any of the failures was one its delegation's `onFailure` says
   * must not be tolerated, and otherwise resumes as soon as nothing is left
   * open. With `"all"`, that is the familiar rule: one failure under `"fail"`
   * fails the intention.
   */
  waitFor?: "all" | "any" | number;
  /**
   * Calls for proposals the intention opens and waits on, from the FIPA
   * Contract Net protocol. Each sends a `cfp` to one or more agents (or
   * publishes one to a topic) and collects their `propose`/`refuse` replies;
   * the intention is `waiting` until every call has closed, then the next
   * action awards the bids with {@link ActionResult.awards}.
   *
   * See {@link CallRequest}.
   */
  calls?: CallRequest[];
  /**
   * Awards of a call's proposals: each turns the chosen bid into a delegation,
   * and every bid not awarded is rejected automatically. Only valid in the
   * action that follows the one that made the call, which is where the
   * proposals are read. See {@link AwardRequest}.
   */
  awards?: AwardRequest[];
  failure?: { reason: string };
  beliefRemovals?: string[];
}

/**
 * A sub-goal a plan hands off and waits for, from
 * {@link ActionResult.delegations}. Where the work runs is the only
 * difference between the two kinds.
 *
 * **To this agent** (`receiver` omitted, or this agent's own id), it is a
 * sub-goal: it records the delegating goal as its parent and the request it
 * serves as its `source`, so it is cancelled with that request, and its
 * failure — including having no plan, or no room in the queue — is the
 * parent's child failure. Achieving it completes the delegation.
 *
 * **To another agent**, it is a FIPA `request` for `goal`, with `view` as the
 * rest of its content. It belongs to the delegating goal's conversation and
 * opens an exchange of its own, so every reply pairs with it. The receiver's
 * `inform` with `done: true` completes it; its `refuse`, `failure` or
 * `not-understood` — or no reply by the request's `reply-by` — fails it. When
 * the delegating intention stops waiting for it (it failed, or its own request
 * was cancelled), the receiver is sent a `cancel`.
 *
 * Either kind is withdrawn the same way once nobody waits for it — its
 * deadline passed, or the delegating intention failed or was cancelled: a
 * remote receiver is sent a `cancel`, and a sub-goal is withdrawn under the
 * rules a receiver applies to one (dropped if it has not started; stopped at
 * the next action boundary, with its `onCancel` clean-up, if every started
 * plan is `cancellable`; otherwise left to run).
 *
 * A remote delegation has a deadline on the work — `timeoutMs`, or the agent's
 * `delegationTimeoutMs` — after which it fails. A self-delegation has one only
 * when `timeoutMs` sets it.
 */
export interface DelegationRequest {
  /**
   * The agent to do the work. Omitted, or this agent's own id, makes it a
   * sub-goal of this agent's.
   */
  receiver?: string;
  /** The goal it is asked to achieve: the name a plan of the receiver serves. */
  goal: string;
  /**
   * The rest of the request's content, forwarded verbatim beside `goal`. For a
   * self-delegation, the sub-goal's `data`.
   */
  view?: Record<string, unknown>;
  /**
   * What this delegation's failure does: `"fail"` (the default) makes it one
   * the intention cannot do without, `"continue"` one it can. See
   * {@link ActionResult.waitFor} for how failures and the target combine.
   */
  onFailure?: ChildFailurePolicy;
  /** Priority of a self-delegated sub-goal. Defaults to 5. Not sent on the wire. */
  priority?: number;
  /**
   * How long the work may take, in milliseconds, from the moment it is asked
   * for. For a remote delegation, overrides the agent's
   * `delegationTimeoutMs`, and `null` sets no deadline; a self-delegation has
   * none unless this sets one.
   */
  timeoutMs?: number | null;
}

/**
 * A call for proposals an action opens, from {@link ActionResult.calls}. The
 * initiator sends one `cfp` per receiver — a message carries a single
 * receiver — or one published to a `topic`. The `cfp` names `goal` and carries
 * `view` verbatim beside it, the same shape a `request` uses.
 *
 * The intention waits until the call closes: every invited agent that answers
 * has answered (a `propose`, a `refuse` or a `not-understood`), or the
 * `deadlineMs` passes. A topic call closes only on the deadline, since the set
 * of subscribers is not known.
 */
export interface CallRequest {
  /** The job proposals are asked for: the name a bidder's plan serves. */
  goal: string;
  /** The agents to ask. Omitted for a topic call. */
  receivers?: string[];
  /** A topic to publish the `cfp` to, instead of naming receivers. */
  topic?: string;
  /** The rest of the `cfp`'s content, forwarded verbatim beside `goal`. */
  view?: Record<string, unknown>;
  /**
   * How long a bid may be made, in milliseconds, stamped as the `cfp`'s
   * `reply-by`. Defaults to the agent's `replyTimeoutMs`.
   */
  deadlineMs?: number;
}

/**
 * An award of one proposal, from {@link ActionResult.awards}. The chosen bid's
 * proposer is sent an `accept-proposal`, and the award is recorded on the
 * intention as a delegation (`status: "agreed"`), so the winner's final
 * `inform`/`failure` settles it exactly as a request does.
 *
 * Every proposal in the call that is not awarded is sent a `reject-proposal`
 * automatically, so choosing a winner is one step of the plan rather than
 * several messages.
 */
export interface AwardRequest {
  /**
   * The award's proposal id: the `replyWith` of the `propose` being accepted,
   * as listed on the intention's call record.
   */
  proposal: string;
  /**
   * What the winner's failure does: `"fail"` (the default) makes it one the
   * intention cannot do without, `"continue"` one it can. See
   * {@link ActionResult.waitFor}.
   */
  onFailure?: ChildFailurePolicy;
  /**
   * How long the awarded work may take, in milliseconds, from the moment it is
   * awarded. Overrides the agent's `delegationTimeoutMs`; `null` sets no
   * deadline.
   */
  timeoutMs?: number | null;
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
 * - `"unsupported"` — the agent understands the act but does not honour it.
 *   This library honours every act in the CAL vocabulary, so nothing produces
 *   this verdict today; it stays in the vocabulary as the answer a directive
 *   this agent cannot represent gets, and {@link isUnsupportedDirective} is the
 *   guard that would produce it. A subclass that can honour such an act answers
 *   for itself; see `Agent.handleUnsupportedDirective`.
 * - `"declined"` — the agent could propose but chooses not to on these terms:
 *   the bid expression for a `cfp` answered no bid (`null`/`undefined`) or
 *   failed. This is `cfp`'s counterpart of a request's refusal, and it is
 *   deliberately distinct from `"unsupported"`: the agent is able and willing
 *   to bid, just not on this call, so a later call may be answered `propose`.
 *   See {@link Plan.bid}.
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
 * whether it has room, whether it is willing, whether the ask is something it
 * can represent, and whether it wants this particular job. All but
 * `"middleware"` are facts about the agent; `"middleware"` is the exception,
 * being a decision the application took rather than one the agent reached.
 * Nothing that arises mid-goal produces a `refuse` — by then the agent
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
  "no-plan" | "capacity" | "unsupported" | "declined" | "middleware";

/**
 * Whether an intention can do without a delegation that failed.
 *
 * - `"fail"` (default): it cannot. Once the action's `waitFor` can no longer be
 *   met, the waiting intention fails too, with the delegation's reason, and the
 *   failure keeps cascading to its own waiting parents.
 * - `"continue"`: it can. The failure is recorded in `intention.childFailures`
 *   for the next action to inspect, and the intention resumes once nothing is
 *   left open.
 *
 * Set per delegation with `DelegationRequest.onFailure`.
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
  /**
   * The expression naming the bid this plan makes when it is asked to propose
   * on a goal, from the FIPA Contract Net protocol. Optional: a plan without
   * one refuses a `cfp` with `verdict: "unsupported"`, which is how an agent
   * that has not opted in keeps today's behaviour.
   *
   * The name is looked up in the agent's `expressionLibrary` and evaluated
   * with the `cfp` as its message, so a bidder reads its own pricing beliefs
   * and the particulars the call named. The value it answers with is the
   * `propose`'s `terms`; `null` or `undefined` is refused
   * `verdict: "declined"` — "not on these terms" — and an error or timeout is
   * declined with the reason. A bid must be a quick read, like any
   * {@link Expression}: one that needs real work is out of scope.
   *
   * @example
   * ```ts
   * {
   *   name: "ship",
   *   bid: "quote-ship",   // an Expression in the agent's expressionLibrary
   *   body: [ /* does the job, on the terms in goal.data.terms *\/ ],
   * }
   * ```
   */
  bid?: string;
  /**
   * Whether a request this plan is working may be withdrawn by its requester's
   * `cancel` once the plan has started — and likewise a self-delegated
   * sub-goal, once the plan that delegated it stops waiting for it. Defaults to `false`: the library cannot
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
   * Clean-up run when a request this plan was working is cancelled, or when a
   * sub-goal it was working is withdrawn because the delegating plan stopped
   * waiting for it: undo or compensate for what the actions that already ran
   * did. Receives the
   * intention as it was stopped, so `actionIndex` says how far it got. Its
   * belief updates and messages are applied; spawned goals and delegations
   * are not. A clean-up that
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
