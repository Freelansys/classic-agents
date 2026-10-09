import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  directivePriority,
  directsAction,
  hasHearerEffect,
  isUnsupportedDirective,
  isQueryDirective,
  isStandingDirective,
  isPropositional,
} from "../bus/performatives.js";
import {
  validateContent,
  schemaViolationReason,
  isKnownPerformative,
} from "../bus/schemas.js";
import type { Message, MessageBus, Performative } from "../bus/index.js";
import { InMemoryBeliefBase, deepEqual } from "./beliefs.js";
import type { BeliefBase, BeliefStatus } from "./beliefs.js";
import {
  GoalQueue,
  isTerminalGoalStatus,
  resolveMaxGoals,
  type Goal,
  type GoalSource,
  type GoalStatus,
} from "./goals.js";
import { Inbox, DEFAULT_MAX_INBOX_ENTRIES, type InboxEntry } from "./inbox.js";
import { ExpressionLibrary, PropositionLibrary } from "./expressions.js";
import { PlanLibrary } from "./plans.js";
import type { RefusalVerdict } from "./plans.js";
import {
  IntentionStack,
  createIntention,
  isAwaitingWork,
  isOpenDelegation,
  openDelegations,
} from "./intentions.js";
import type { ChildFailure, Delegation, Intention } from "./intentions.js";
import type { Action, ActionResult, DelegationRequest } from "./plans.js";

/**
 * Re-exported so the refusal vocabulary can be reached from either the plan
 * layer that produces a plan's refusal or the agent layer that sends it.
 */
export type { RefusalVerdict } from "./plans.js";

/**
 * Default bound on the number of unfinished goals an agent holds, pending and
 * active together, sub-goals included. A goal offered once the bound is reached
 * is admitted and immediately failed rather than queued, and the rejection is
 * reported to whoever asked for the work. Override with
 * `AgentConfig.maxGoals`; `0` means unbounded.
 */
export const DEFAULT_MAX_GOALS = 1000;

/**
 * An acknowledgement received for a request this agent sent, naming the goal id
 * that actually got assigned. The payload of a `goalAcknowledged` event.
 */
/**
 * An agreement received for a directive this agent sent, naming the goal id
 * that actually got assigned. The payload of a `goalAcknowledged` event.
 *
 * Sent as FIPA `agree`: the receiver's answer to a directive, asserting that it
 * will perform the action asked. `goalId` is the assigned id rather than the
 * requested one whenever a pin was lost, so a sender never has to guess which
 * goal it is now responsible for.
 */
export interface GoalAck {
  /** Id of the agent that agreed, i.e. that created the goal. */
  agentId: string;
  goal: string;
  /**
   * The goal id the receiver assigned. Empty for an agreement that commits to
   * no single goal: a `request-whenever`, whose every firing is a goal of its
   * own, or a `subscribe`.
   */
  goalId: string;
  /** FIPA's φ: the proposition a `request-when`/`request-whenever` waits on. */
  when?: string;
  /** The expression an agreed `subscribe` reports on. */
  name?: string;
  conversationId?: string;
  inReplyTo?: string;
}

export type GoalAckHandler = (ack: GoalAck) => void;

/**
 * A refusal received for a directive this agent sent. The payload of a
 * `goalRefused` event.
 *
 * The counterpart to `GoalAck`, and the event that makes an unanswered
 * `request` a dead end rather than a silence: without it, a sender whose
 * directive was declined has nothing to wait on and nothing to report.
 */
export interface GoalRefusal {
  /** Id of the agent that refused. */
  agentId: string;
  /** The goal that was asked for. Empty when the refused directive is a query. */
  goal: string;
  /**
   * For a refused `query-if` or `query-ref`: the name of the proposition or
   * expression that was asked for. A query creates no goal, so this is what
   * says which question was declined.
   */
  query?: string;
  /**
   * Which of {@link RefusalVerdict}s the receiver declined under.
   *
   * Optional, because a peer is free to send a `refuse` without saying why —
   * `refuse` is a standard performative, not one this library owns. The
   * decline an agent makes itself always carries a verdict; one it *receives*
   * carries whatever the sender chose to give.
   */
  verdict?: RefusalVerdict;
  /**
   * FIPA's φ: the receiver's own explanation for declining, meant as a causal
   * account of why it will not act. Free text, and what the two are for is
   * decided — `verdict` says which kind of decline this is, `reason` says why
   * this one. For a monitor or a sender log.
   */
  reason?: string;
  conversationId?: string;
  inReplyTo?: string;
}

export type GoalRefusalHandler = (refusal: GoalRefusal) => void;

/** A goal's status transition, the payload of a `goal:status` event. */
export interface GoalStatusChange {
  /** The goal as the queue holds it — the live object, mutated in place. */
  goal: Goal;
  /** Status the goal held before the change. */
  from: GoalStatus;
  /** Status the goal holds now. */
  to: GoalStatus;
}

/** Payload of an `intention:advanced` event. */
export interface IntentionAdvanced {
  /** The intention as the stack holds it — the live object. */
  intention: Intention;
  /** The action that just ran. */
  action: Action;
  /** What that action returned. */
  result: ActionResult;
}

/** Payload of an `intention:waiting` event. */
export interface IntentionWaiting {
  /** The intention as the stack holds it — the live object. */
  intention: Intention;
  /**
   * Ids of the sub-goals of this agent's the intention is waiting for: a copy,
   * since the intention's own list is trimmed as its children settle.
   */
  children: string[];
  /**
   * The delegations the intention is waiting for, its own sub-goals among
   * them: snapshots, since the intention's records change as they settle.
   */
  delegations: Delegation[];
}

/** Payload of an `intention:delegated` event. */
export interface IntentionDelegated {
  /** The intention as the stack holds it — the live object. */
  intention: Intention;
  /** The delegations the action just made, as made: snapshots. */
  delegations: Delegation[];
}

/** Payload of a `delegation:settled` event. */
export interface DelegationSettled {
  /** The intention that delegated the work — the live object. */
  intention: Intention;
  /** The delegation as it settled: a snapshot. */
  delegation: Delegation;
}

/** Payload of an `intention:failed` event. */
export interface IntentionFailed {
  /** The intention as the stack holds it — the live object. */
  intention: Intention;
  /** Why it failed, as reported by the action or thrown by it. */
  reason: string;
}

/**
 * Every event an `Agent` emits, and the payload it arrives with.
 *
 * Together they are a live view of the reasoning cycle: a monitor can follow
 * an agent's goals, intentions and traffic without polling `goals`,
 * `intentions` or wrapping the bus.
 *
 * - `goal:added` — a goal entered the queue, either added directly or created
 *   from a message or an action's sub-goals.
 * - `goal:status` — a goal changed status, with the status it came from.
 * - `goal:rejected` — a goal was refused because the agent was already holding
 *   `maxGoals` unfinished goals. The goal is failed immediately and never
 *   worked on, so a requester gets a `refuse` instead of silence — unless the
 *   goal is a sub-goal, whose only answer is the parent's `failure`.
 * - `goal:refused` — the agent declined a directive: for want of capacity, for
 *   want of a plan, or because its middleware chain would not admit it, so the
 *   requester gets a `refuse` instead of silence. A sub-goal reports the same
 *   fact here and answers nowhere on the wire: its requester has already had
 *   `agree` for the goal it did ask for, and only the parent's `failure`
 *   carries the news. Distinct from `goal:rejected`, which is the queue's own
 *   backpressure reported as a goal lifecycle; a directive the chain declines
 *   never reaches the queue at all.
 * - `goal:removed` — a finished goal left the queue, collected at the end of
 *   the cycle that finished it. Nothing is ever evicted: a goal only leaves
 *   once it has reached `achieved`, `failed` or `dropped`.
 * - `intention:started` — means-ends reasoning created an intention for an
 *   active goal and set it executing.
 * - `intention:advanced` — an action ran and the intention moved to its next
 *   one. Emitted before `intention:completed` when the action was the plan's
 *   last.
 * - `intention:delegated` — the action delegated sub-goals, to this agent or
 *   another. Emitted before `intention:waiting`.
 * - `intention:waiting` — the action delegated work and the intention is now
 *   waiting for it.
 * - `delegation:settled` — a delegation was done, failed, or cancelled.
 * - `intention:completed` — the plan ran out of actions; its goal is
 *   `achieved`.
 * - `intention:failed` — an action failed, threw, or a sub-goal it was waiting
 *   for failed; its goal is `failed`.
 * - `intention:removed` — a finished intention left the stack, collected at the
 *   end of the cycle that finished it.
 * - `message:received` — a message arrived, point-to-point or on a subscribed
 *   topic, before it is processed. An agent subscribed to a topic receives
 *   what it publishes itself, so this fires for the agent's own sends.
 * - `message:sent` — the agent handed a message to the bus and the bus
 *   accepted it: from an action's result, a goal-request agreement, or a
 *   failure/achieved notice.
 * - `goalAcknowledged` — an `agree` arrived for a directive this agent sent.
 * - `goalRefused` — a `refuse` arrived for a directive this agent sent, so
 *   the sender learns the request will not be acted on rather than waiting on
 *   silence.
 *
 * Payloads are plain data apart from the store objects (`goal`, `intention`),
 * which are the live ones held by the queue and the stack: they are mutated in
 * place as work progresses, so snapshot them (`{ ...goal }`) to keep the state
 * you saw. Handlers run synchronously on the cycle that raised the event, so a
 * handler that throws fails that cycle — hand off to a queue if the work is
 * slow, and never block.
 */
/**
 * An assertion the agent was told about and did not believe.
 *
 * Emitted instead of publishing an observability message, because this is a
 * fact about *this agent's* reasoning rather than anything communicated to
 * anyone: there is no hearer, no performative and no protocol in it. An agent
 * that received it over the bus would have to treat it as a peer's claim, and
 * the trust assumption that governs peers would then apply to the agent's own
 * internal bookkeeping. Keeping it on the event stream is what keeps the bus
 * for communication and nothing else.
 */
/**
 * Why an assertion did not become a belief.
 *
 * A union rather than free text so a consumer can exhaustively handle the ways
 * an assertion can be dropped. The thrown case keeps its detail because the
 * detail is the point — which failure is exactly what a user withdrawing trust
 * needs to see.
 */
export type BeliefRejectionReason =
  "middleware" | `middleware threw: ${string}`;

export interface BeliefRejection {
  /** Id of the agent that declined to believe it. */
  agentId: string;
  /**
   * What stopped the belief.
   *
   * - `middleware` — a middleware returned without calling `next`, the
   *   documented way to cancel.
   * - `middleware threw: …` — a middleware failed, so the rest of the chain was
   *   not run and the write did not happen.
   *
   * There is no third reason, because there is only one gate. An earlier design
   * also carried a class-level `informs` policy, which made "this kind of
   * message is not eligible" a second way to say no. The chain expresses that
   * too, and one thing to understand beats two that overlap.
   */
  reason: BeliefRejectionReason;
  /** The assertion that was not believed. */
  message: Message;
}

/**
 * An assertion the agent believed.
 *
 * The counterpart to {@link BeliefRejection}, and about the same thing: what
 * this agent took in as a result of one message. It exists so that a monitor can
 * account for an assertion end to end — accepted with these keys, or rejected
 * with that reason — without reconstructing either by watching the belief base.
 *
 * `keys` is what the content was stored under, which is the `beliefKey` naming
 * and not the content's own keys. A monitor that only needs the count can use
 * `keys.length`; one correlating with `beliefAdded` needs the names, since that
 * event fires per key and cannot say which message they came from.
 */
export interface BeliefAcceptance {
  /** Id of the agent that believed it. */
  agentId: string;
  /**
   * The stance it was held with: `"negative"` for a `disconfirm`, which the
   * agent took as a position on the content rather than as nothing at all.
   */
  status: BeliefStatus;
  /**
   * The belief keys written. Empty if the assertion had no content keys, which
   * is still an acceptance — the message was believed, and happened to be empty.
   */
  keys: string[];
  /** The assertion that was believed. */
  message: Message;
}

export interface AgentEventMap {
  "goal:added": Goal;
  "goal:status": GoalStatusChange;
  "goal:rejected": GoalRejection;
  "goal:refused": GoalRefusal;
  "goal:removed": Goal;
  "goal:cancelled": GoalCancellation;
  "intention:started": Intention;
  "intention:advanced": IntentionAdvanced;
  "intention:delegated": IntentionDelegated;
  "intention:waiting": IntentionWaiting;
  "delegation:settled": DelegationSettled;
  "intention:completed": Intention;
  "intention:failed": IntentionFailed;
  "intention:removed": Intention;
  "message:received": Message;
  "message:sent": Message;
  "belief:accepted": BeliefAcceptance;
  "belief:rejected": BeliefRejection;
  "reply:timeout": ReplyTimeout;
  "directive:expired": Message;
  goalAcknowledged: GoalAck;
  goalRefused: GoalRefusal;
}

/**
 * Work this agent withdrew: a request, at its requester's `cancel`, or a
 * sub-goal it had delegated to itself and stopped waiting for. The payload of
 * a `goal:cancelled` event.
 */
export interface GoalCancellation {
  agentId: string;
  /**
   * The goal withdrawn — a request's root, or a self-delegated sub-goal — now
   * dropped along with its own sub-goals.
   */
  goal: Goal;
  /**
   * Who withdrew it: the agent that asked for the work, or this agent's own id
   * for a self-delegated sub-goal.
   */
  by: string;
  /**
   * The plans whose `onCancel` clean-up failed, and why. The work was stopped
   * either way; this says what may have been left behind.
   */
  cleanupFailures: Array<{ plan: string; reason: string }>;
}

/**
 * A directive this agent sent whose `reply-by` passed with no reply from the
 * peer. The payload of a `reply:timeout` event.
 *
 * The exchange is closed as unanswered: the uncertain belief it opened is
 * removed, and an `unanswered.<peer>.<name>.<exchange>` record says why. A
 * reply that arrives later is treated as an ordinary message.
 */
export interface ReplyTimeout {
  agentId: string;
  /** The agent that did not reply. */
  peer: string;
  /** The directive that went unanswered. */
  performative: Performative;
  /** The goal (requests) or proposition/expression (queries) it named. */
  name: string;
  /** The directive's `replyWith`, which a reply would have named back. */
  exchange: string;
  replyBy: string;
}

export type AgentEvent = keyof AgentEventMap;

export type AgentEventHandler<E extends AgentEvent> = (
  payload: AgentEventMap[E],
) => void;

/**
 * An answer to a directive, queued while the request is turned into a goal
 * (or refused), telling the sender what this agent decided. Flushed at the end
 * of the cycle that reached the decision.
 */
interface PendingAnswer {
  to: string;
  goal: string;
  conversationId?: string;
  inReplyTo?: string;
}

/**
 * An `agree` to send: the directive was accepted. Names what was committed to —
 * see `agreeContentSchema` for which field each directive uses.
 */
interface PendingAgreement extends PendingAnswer {
  /** The goal id assigned: a `request`'s, or a `request-when`'s in advance. */
  goalId?: string;
  /** FIPA's φ: the proposition a `request-when`/`request-whenever` waits on. */
  when?: string;
  /** The expression a `subscribe` reports on. */
  name?: string;
}

/** A `refuse` to send: the directive was declined, so no goal was created. */
interface PendingRefusal extends PendingAnswer {
  verdict: RefusalVerdict;
  reason?: string;
  /** Set for a refused query: the refusal names the query, not a goal. */
  query?: string;
}

/**
 * The terminal answer owed to the requester of a directive this agent agreed
 * to: an `inform` naming the goal it completed, or a `failure` saying why the
 * work it undertook did not finish.
 *
 * FIPA's request protocol (SC00026) makes `agree` a commitment to answer, so
 * both are queued when the *root* goal reaches a terminal status and flushed
 * from the tick, exactly like `agree` and `refuse` — the reply never leaves
 * from inside the bus's delivery callback or from inside an action.
 *
 * `reason` is present only on the `failure` half.
 */
interface PendingOutcome extends PendingAnswer {
  /** The id the `agree` named, so the answer names the same goal back. */
  goalId: string;
  performative: "inform" | "failure";
  reason?: string;
  /** The goal's answer, for an `inform`: see `ActionResult.result`. */
  result?: unknown;
}

/**
 * A directive this agent agreed to and still owes a terminal answer for.
 *
 * `informed` records that the plan already sent the requester an `inform`
 * answering this exchange. That covers success — the automatic `inform` would
 * be a second one — but not failure: an `inform` is not a terminal answer until
 * the goal is achieved, since a plan may report progress and then fail, and the
 * requester is still owed the `failure`.
 */
interface OpenRequest extends PendingAnswer {
  /** The goal the answer is owed for. */
  goalId: string;
  informed?: boolean;
}

/**
 * A standing commitment this agent agreed to: a `request-when`,
 * `request-whenever` or `subscribe` it is watching on a peer's behalf, keyed by
 * the directive's `replyWith` — the id a `cancel` names to end it.
 *
 * Evaluated every tick against the agent's beliefs and the directive itself, so
 * the arguments the sender put beside the name still apply.
 */
interface StandingCommitment {
  kind: "request-when" | "request-whenever" | "subscribe";
  /** The directive as received: the message every evaluation is given. */
  message: Message;
  /** Who asked, and the only agent that may cancel it. */
  sender: string;
  /** The key this commitment is held under. */
  id: string;
  /** The proposition (`request-when*`) or expression (`subscribe`) watched. */
  name: string;
  /** The goal a `request-when*` creates when it fires. */
  goal?: string;
  /** A `request-when`'s goal id, named in its `agree` before the goal exists. */
  goalId?: string;
  /**
   * What the last evaluation answered: the truth value for a
   * `request-whenever`, the result for a `subscribe`. Absent until the first
   * evaluation, which is how "already true at admission" fires and how a
   * subscription sends its initial value.
   */
  last?: { value: unknown };
  /** A firing that found the goal queue full, retried each tick until it fits. */
  pendingFire?: boolean;
  /** Where its replies go: the directive's `reply-to`, or its sender. */
  replyTo: string;
  /**
   * An evaluation is still running. The next one starts only after it settles,
   * so a slow proposition is never evaluated twice at once.
   */
  evaluating?: boolean;
}

/**
 * A request this agent sent — `request`, `request-when` or `request-whenever` —
 * that has not ended yet, keyed by its `replyWith`. Lets a reply be read as
 * the answer to *this* request: an `inform` with `done: true` completes it, a
 * `failure` ends it, a `refuse` or a timeout closes it unanswered.
 */
interface SentRequest {
  peer: string;
  goal: string;
  performative: Performative;
  exchange: string;
}

/**
 * A `cancel` this agent sent and has not had answered, keyed by the cancel's
 * `replyWith`. Lets the reply be read against the request or subscription it
 * cancels rather than as a stray message.
 */
interface PendingCancel {
  peer: string;
  /** The `replyWith` of the request or subscription being cancelled. */
  target: string;
  kind: "request" | "subscription";
  /** The goal (request) or expression (subscription) it named. */
  name: string;
}

/**
 * A withdrawal that could not be carried out yet, because one of the actions
 * under the goal was mid-flight: a `cancel` this agent received, or a
 * self-delegated sub-goal it stopped waiting for. It is retried at every action
 * boundary.
 */
interface QueuedCancel {
  /** The goal being withdrawn, with everything under it. */
  goalId: string;
  /** Who withdrew it: the requester, or this agent. */
  by: string;
  settle: (outcome: Withdrawal) => Promise<void>;
}

/** How a withdrawal went: see `Agent.withdraw`. */
type Withdrawal =
  | {
      withdrawn: true;
      goal: Goal;
      cleanupFailures: Array<{ plan: string; reason: string }>;
    }
  | { withdrawn: false; goal?: Goal; reason: string };

/**
 * A directive this agent sent that has not had its first reply yet, keyed by
 * the directive's `replyWith`. Closed by any reply from the peer naming it;
 * expired, as unanswered, once its `reply-by` passes.
 */
interface AwaitedReply {
  peer: string;
  performative: Performative;
  /** The goal (requests) or proposition/expression (queries) it named. */
  name: string;
  exchange: string;
  replyBy: string;
  /** `replyBy` as epoch milliseconds. */
  deadline: number;
  /**
   * The uncertain belief this exchange opened, removed if it expires: the
   * `intent.*` of a request. A query's belief is closed through its pending
   * entry instead.
   */
  key?: string;
}

/**
 * A `query-if` or `query-ref` this agent sent and has not had answered yet,
 * keyed by the query's `replyWith` — the id the answer names back as its
 * `inReplyTo`.
 */
interface PendingQuery {
  /** The agent asked, the only one whose reply settles the question. */
  peer: string;
  /** The proposition or expression asked for. */
  name: string;
  /** The question as sent, kept for the record if it goes unanswered. */
  question: unknown;
  /** The `answer.*` belief held `uncertain` until the answer arrives. */
  key: string;
  /** The `replyWith` the answer will name back. */
  exchange: string;
  /**
   * A `subscribe` rather than a query: answered again and again, each update
   * replacing the last, so an answer does not close it. Only a `cancel` this
   * agent sends, or a refusal, failure or `not-understood`, does.
   */
  standing?: boolean;
}

/**
 * What became of a directive turned into a goal: the id assigned, and whether
 * the queue actually took it.
 *
 * `admitted: false` means the goal was refused at admission for want of
 * capacity. The queue still admits it long enough to report the refusal as a
 * lifecycle the event stream can describe, so the caller can decline the
 * directive rather than agree to work nobody will do.
 */
interface DirectiveOutcome {
  goalId: string;
  admitted: boolean;
}

/**
 * A goal refused because the queue was already holding `maxGoals` unfinished
 * goals, queued for reporting at the start of the next cycle. Flushed with the
 * acknowledgements, since it also answers a message the agent has not replied
 * to yet.
 */
interface PendingRejection {
  goal: Goal;
  reason: string;
}

/**
 * A goal the queue refused because the agent was already holding `maxGoals`
 * unfinished goals. The goal is failed rather than queued, so this is the
 * backpressure signal: `rejected: true` distinguishes it from a job that was
 * attempted and failed.
 */
export interface GoalRejection {
  goal: Goal;
  reason: string;
}

/**
 * An interception point in the path from an assertion to a belief, in the shape
 * of an Express middleware: call `next` to continue, or return without calling
 * it to cancel.
 *
 * classic-agents assumes agents are trustworthy and cooperative, so a message
 * from a peer is believed by default. This is the assumption made interruptible
 * — a middleware that does not call `next` stops the write for that message and
 * nothing else changes. The chain is per message, not per belief key, so a
 * middleware sees the whole assertion it is deciding about.
 *
 * `next` is async because real authorization is: checking a capability service or
 * an external policy means I/O, and a synchronous chain would push every caller
 * into blocking or fire-and-forget. A middleware that neither calls `next` nor
 * awaits anything is still free to be trivial.
 *
 * Only the assertion path is guarded. Directives are a different primitive —
 * `request` and its relatives become goals — and are gated by their own chain and
 * the {@link RefusalVerdict} vocabulary instead, so that withdrawing trust in a
 * peer's claims is a separate decision from refusing its work.
 *
 * A middleware that throws cancels the write: the error is reported as a
 * `belief:rejected` event and the message is dropped, because a chain that
 * failed partway has not established that the rest of it should be trusted.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   id: "qualifier",
 *   bus,
 *   planLibrary,
 *   middleware: [
 *     async (msg, next) => {
 *       if (!(await acl.may(msg.sender, "assert", msg.content))) {
 *         return; // cancel: no belief is written
 *       }
 *       await next();
 *     },
 *   ],
 * });
 * ```
 */
export type BeliefMiddleware = (
  msg: Message,
  next: () => Promise<void>,
) => void | Promise<void>;

/**
 * The answer a directive will get back, handed to each
 * {@link DirectiveMiddleware} so it can shape the refusal rather than only
 * cause one.
 *
 * This is why the directive chain takes three arguments where the belief chain
 * takes two. An assertion that is not believed needs no reply, so a belief
 * middleware can express "no" by simply not continuing — there is nothing to
 * shape. A directive compels a hearer effect, so declining it is itself a
 * communicative act, and "no" without a reason is a worse answer than silence:
 * the sender learns that nothing will happen but not whether the agent could
 * not, would not, or has no room. Hence `res`.
 *
 * It exists as an argument rather than a return value because the chain is async
 * and ordered — a middleware cannot hand a verdict back through `next()` without
 * either wrapping the rest of the chain or giving up on it.
 *
 * @example
 * ```ts
 * directiveMiddleware: [
 *   async (req, res, next) => {
 *     if (req.sender !== "ui") {
 *       // Declining with a reason, not just declining.
 *       res.refuse("middleware", "only the UI may direct me");
 *       return;
 *     }
 *     await next();
 *   },
 * ]
 * ```
 */
export interface DirectiveResponse {
  /**
   * Decline the request, telling the sender why.
   *
   * Terminal: once called the request will not be admitted, whatever the rest of
   * the chain does, so the reason is kept from the first handler to supply one
   * — the handler closest to the request has the most specific view of it.
   * Calling `next()` afterwards is harmless but will not admit the goal.
   *
   * @param verdict Which kind of decline this is. Defaults to `"middleware"`,
   *   meaning the application's own chain declined rather than the agent lacking
   *   something. Name a different one when the chain knows more than that —
   *   `res.refuse("capacity", …)` to shed load before the queue is consulted.
   * @param reason FIPA's φ: free text forwarded to the sender verbatim, meant as
   *   a causal account of why this agent will not act. This is where the
   *   explanation a user actually wants to read goes; `verdict` is a fixed
   *   vocabulary and cannot carry one.
   */
  refuse(verdict?: RefusalVerdict, reason?: string): void;
}

/**
 * A middleware guarding whether this agent takes on a directive — the chain
 * that runs before a `request` becomes a goal.
 *
 * The same shape as {@link BeliefMiddleware} plus the {@link DirectiveResponse}
 * it can answer with, and deliberately a separate list: withdrawing trust in a
 * peer's *claims* and refusing its *work* are different decisions, and an
 * application frequently wants one without the other. Each array is
 * independently empty by default, so neither decision is taken on the user's
 * behalf unless they supply a chain.
 *
 * What differs from the belief path is what declining means. An assertion that
 * is not believed needs no answer, so returning without calling `next` cancels
 * the write and that is the end of it. A directive compels a hearer effect, so
 * the same gesture sends `refuse` and reports `goal:refused` instead — the
 * sender can always tell "not heard yet" from "heard and declined", which is the
 * one thing a compelled hearer effect exists to guarantee. Use `res.refuse` when
 * the sender should also learn why.
 *
 * Runs before the content is parsed, so a handler may rewrite `msg.content` to
 * repair or remap a request, and before the plan check, the goal bound and the
 * `agree`, so a decline short-circuits all of them. A middleware that throws
 * declines the request the same way, with the error text as the refusal's reason.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   id: "worker",
 *   bus,
 *   planLibrary,
 *   directiveMiddleware: [
 *     async (req, res, next) => {
 *       if (!(await acl.may(req.sender, "request"))) {
 *         res.refuse("middleware", "sender not permitted to direct me");
 *         return;
 *       }
 *       await next();
 *     },
 *   ],
 * });
 * ```
 */
export type DirectiveMiddleware = (
  req: Message,
  res: DirectiveResponse,
  next: () => Promise<void>,
) => void | Promise<void>;

/**
 * The belief key an accepted assertion's content key is stored under.
 *
 * Defaults to `msg.<key>`, keeping received propositions in their own partition
 * of the belief base, separated from anything the agent concluded for itself.
 * The sender is available to qualify by, which is the difference between a
 * proposal-shaped store and an event-shaped one: the default loses which agent
 * asserted what, and two agents asserting the same key land on the same
 * belief.
 */
export type BeliefKeyFn = (msg: Message, key: string) => string;

/** The default {@link BeliefKeyFn}: content keys land under `msg.`. */
export const defaultBeliefKey: BeliefKeyFn = (_msg, key) => `msg.${key}`;

export interface AgentConfig {
  id: string;
  bus: MessageBus;
  planLibrary: PlanLibrary;
  /**
   * The expressions this agent can name — computations over its beliefs that
   * answer with any value. Optional: an agent that uses none gets an empty
   * library, and a name it does not register is simply unknown.
   *
   * @see {@link ExpressionLibrary}
   */
  expressionLibrary?: ExpressionLibrary;
  /**
   * The conditions this agent can honour — the named propositions a sender can
   * ask it to judge against its own beliefs. Optional: an agent that uses none
   * gets an empty library.
   *
   * @see {@link PropositionLibrary}
   */
  propositionLibrary?: PropositionLibrary;
  beliefs?: BeliefBase;
  maxConcurrentIntentions?: number;
  /**
   * Maximum number of unfinished goals (pending + active, sub-goals included)
   * the agent will hold. A goal offered once the bound is reached is admitted
   * and immediately failed rather than queued, so the agent sheds load instead
   * of growing without limit: it replies `refuse` to whoever asked for the
   * work. Defaults to `DEFAULT_MAX_GOALS`. `0` means unbounded.
   */
  maxGoals?: number;
  /**
   * Middleware run before an assertion reaches the belief base, in order. The
   * last one to call `next` performs the write.
   *
   * Empty by default, which means the write happens — the trust assumption
   * stands. Supplying middleware is how a user withdraws it without giving up the
   * convenience: a sender allowlist is one entry that does not call `next`, and
   * a class-level rule is the same entry with the test hoisted out.
   *
   * This is the only gate on the assertion path. A message stopped by it is
   * reported as a `belief:rejected` event.
   *
   * @see {@link BeliefMiddleware}
   */
  middleware?: BeliefMiddleware[];

  /**
   * Middleware run before a directive becomes a goal, in order. The last one to
   * call `next` triggers the decision to take the work on.
   *
   * Empty by default, which means the agent agrees to every well-formed request
   * it has a plan and capacity for — the same trust-and-capability default
   * cooperative default the assertion path uses, applied to work.
   *
   * Unlike {@link middleware}, a chain that does not reach the decision still
   * answers: cancelling or throwing declines the request with `refuse`, because
   * a directive compels a hearer effect.
   *
   * @see {@link DirectiveMiddleware}
   */
  directiveMiddleware?: DirectiveMiddleware[];
  /**
   * Where an accepted assertion's content keys are stored. Defaults to
   * {@link defaultBeliefKey}, i.e. the `msg.` prefix.
   */
  beliefKey?: BeliefKeyFn;
  /**
   * Maximum number of unperceived messages held before the oldest are dropped.
   * Defaults to `DEFAULT_MAX_INBOX_ENTRIES`. `0` means unbounded, which is only
   * safe for an agent that always ticks.
   */
  maxInboxSize?: number;
  /**
   * How long a peer has to reply to a directive this agent sends — a
   * `request`, `request-when`, `request-whenever`, `subscribe` or query — in
   * milliseconds. Stamped as the FIPA `reply-by` on every outgoing directive
   * that does not set its own, so an exchange never waits forever: when it
   * passes with no reply, the exchange is closed as unanswered and
   * `reply:timeout` is emitted. It bounds the *first* reply (the `agree`,
   * `refuse` or answer), not how long the work takes. Defaults to
   * {@link DEFAULT_REPLY_TIMEOUT_MS}. `0` stamps none.
   */
  replyTimeoutMs?: number;
  /**
   * How long one evaluation of a proposition or expression may run, in
   * milliseconds, before it is abandoned and answered `failure`. Evaluations
   * never block the reasoning cycle; this bounds how long a query or a standing
   * commitment can stay unanswered. Defaults to
   * {@link DEFAULT_EVALUATION_TIMEOUT_MS}. `0` means no limit.
   */
  evaluationTimeoutMs?: number;
  /**
   * How many proposition and expression evaluations may run at once, queries
   * and standing directives together. A query that arrives with the agent at
   * the limit is refused `capacity`, as a request is when the goal queue is
   * full; a standing directive's evaluation waits for a later cycle instead,
   * since it was already agreed to. Evaluations are meant to be quick reads
   * (see `Expression`), so this guards against a slow store or a burst of
   * queries rather than limiting work. Defaults to
   * {@link DEFAULT_MAX_CONCURRENT_EVALUATIONS}. `0` means no limit.
   */
  maxConcurrentEvaluations?: number;
  /**
   * How long a remote delegation's work may take, in milliseconds, from the
   * moment it is asked for, unless the delegation sets its own `timeoutMs`.
   * Where {@link replyTimeoutMs} bounds the first reply, this bounds the
   * outcome: a receiver that agrees and never finishes would otherwise hold
   * the delegating intention forever. When it passes, the delegation fails
   * and the receiver is sent a `cancel`. Defaults to
   * {@link DEFAULT_DELEGATION_TIMEOUT_MS}. `0` means no limit.
   */
  delegationTimeoutMs?: number;
}

/** Default {@link AgentConfig.replyTimeoutMs}: thirty seconds. */
export const DEFAULT_REPLY_TIMEOUT_MS = 30_000;

/**
 * Default {@link AgentConfig.evaluationTimeoutMs}: ten seconds, well inside
 * the default reply timeout, so a slow query is answered `failure` before the
 * asker gives up on it.
 */
export const DEFAULT_EVALUATION_TIMEOUT_MS = 10_000;

/**
 * Default {@link AgentConfig.maxConcurrentEvaluations}: a hundred. Generous
 * for quick reads, and a ceiling on what a burst of queries can pile onto a
 * slow belief store.
 */
export const DEFAULT_MAX_CONCURRENT_EVALUATIONS = 100;

/**
 * Default {@link AgentConfig.delegationTimeoutMs}: five minutes. Long enough
 * for ordinary work, short enough that a delegate that went quiet does not
 * hold the delegating intention indefinitely.
 */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 300_000;

/** `maxGoals` is a count or unbounded, never a negative or fractional one. */
function resolveAgentMaxGoals(value: number | undefined): number {
  return resolveMaxGoals(value, DEFAULT_MAX_GOALS);
}

export class Agent {
  readonly id: string;
  readonly beliefs: BeliefBase;
  readonly goals: GoalQueue;
  readonly intentions: IntentionStack;
  /**
   * The expressions this agent can name, from config or an empty library. A
   * plan body reads them with {@link ExpressionLibrary.evaluate} against the
   * live belief base.
   */
  readonly expressionLibrary: ExpressionLibrary;
  /**
   * The conditions this agent can honour, from config or an empty library. The
   * propositions a directive names are looked up here.
   */
  readonly propositionLibrary: PropositionLibrary;
  /**
   * Messages the bus has delivered but this cycle has not perceived yet.
   *
   * Kept separate from the belief base on purpose: a message is an event and a
   * belief is state, and an agent should only turn the former into the latter
   * by deciding to. Readable for inspection — `peek()` without draining — but
   * `Agent` owns draining it each tick.
   */
  readonly inbox: Inbox;
  private readonly bus: MessageBus;
  private readonly planLibrary: PlanLibrary;
  private readonly config: Required<AgentConfig>;
  private tickTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private running = false;
  private unsubs: Array<() => void> = [];
  private subscribedTopics = new Set<string>();
  private pendingAcks: PendingAgreement[] = [];
  private pendingRefusals: PendingRefusal[] = [];
  private pendingRejections: PendingRejection[] = [];
  private pendingOutcomes: PendingOutcome[] = [];
  /**
   * Directives this agent agreed to and has not answered terminally yet, keyed
   * by the goal id the `agree` named.
   *
   * Present from the moment the `agree` is queued, so the entry is also the
   * record that an `agree` went out at all — a goal shed at admission, declined
   * by the chain, or added directly never gets one, and so is never answered
   * with a terminal reply. An entry leaves when the goal's outcome is queued,
   * when the plan sends its own `failure` for the exchange, or when the goal
   * leaves the queue, so it is bounded by the work in flight. A plan's own
   * `inform` only marks the entry; see {@link OpenRequest}.
   */
  private readonly openRequests = new Map<string, OpenRequest>();
  /**
   * Queries this agent asked and is still waiting on, keyed by the query's
   * `replyWith`. An entry leaves when the answer, a refusal, a failure or a
   * `not-understood` naming it arrives. A peer that never replies leaves its
   * entry — and the `uncertain` answer belief — in place: there is no reply
   * deadline yet.
   */
  private readonly pendingQueries = new Map<string, PendingQuery>();
  /**
   * The `request-when`, `request-whenever` and `subscribe` commitments this
   * agent agreed to and is still watching, keyed by the directive's
   * `replyWith`. A `request-when` leaves once it fires; the other two only on
   * `cancel` or an evaluation that fails. Survives `stop()` like goals do.
   */
  private readonly standing = new Map<string, StandingCommitment>();
  /**
   * Directives this agent sent that still await a first reply, keyed by their
   * `replyWith`. Only directives with a `reply-by` are held here; see
   * {@link AgentConfig.replyTimeoutMs}.
   */
  private readonly awaitingReply = new Map<string, AwaitedReply>();
  /**
   * Requests this agent sent that have not ended, keyed by their
   * `replyWith`. An entry leaves when the request completes, fails, is
   * refused, is not understood or times out. A `request-whenever` stays until
   * this agent cancels it, since each firing completes or fails on its own.
   */
  private readonly sentRequests = new Map<string, SentRequest>();
  /**
   * Remote delegations still open, keyed by their request's `replyWith`: the
   * intention waiting on each and its record there. An entry leaves when the
   * request ends (see {@link endSentRequest}) or the intention stops waiting.
   */
  private readonly remoteDelegations = new Map<
    string,
    { intention: Intention; delegation: Delegation; conversationId?: string }
  >();
  /** Cancels this agent sent that await a reply, keyed by their `replyWith`. */
  private readonly pendingCancels = new Map<string, PendingCancel>();
  /**
   * Cancels received for a request whose action was running at the time,
   * carried out at the next action boundary.
   */
  private queuedCancels: QueuedCancel[] = [];
  /** Intentions whose current action is running right now. */
  private readonly actionsInFlight = new Set<string>();
  /**
   * Proposition and expression evaluations that have settled since they were
   * last applied: the continuation each one runs, in settling order. An
   * evaluation is started without being awaited, so a slow one never holds up
   * the cycle; the tick applies whatever has settled.
   */
  private settledEvaluations: Array<() => Promise<void>> = [];
  /** How many evaluations are running, so a tick knows whether to wait a beat. */
  private evaluationsInFlight = 0;
  /**
   * Why a goal that reached `failed` or `dropped` ended that way, recorded
   * beside the transition because the goal itself carries no reason and the
   * event payload is the live object. Read when the terminal answer is built
   * and dropped with it, so this cannot outlive the goal it describes.
   */
  private readonly goalEndReasons = new Map<string, string>();
  /**
   * The answer each goal's plan returned (`ActionResult.result`), kept until
   * the goal leaves the queue so the terminal `inform` and a waiting parent can
   * both read it.
   */
  private readonly goalResults = new Map<string, unknown>();
  // The goal queue reports the status a goal ended up in, not the one it left,
  // so the agent remembers the last status it saw per goal to report the
  // transition on `goal:status`. Entries go when the goal is collected, so this
  // does not grow with the number of jobs the agent has run.
  private readonly lastGoalStatus = new Map<string, GoalStatus>();
  private readonly emitter = new EventEmitter();

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.bus = config.bus;
    this.planLibrary = config.planLibrary;
    this.beliefs = config.beliefs ?? new InMemoryBeliefBase();
    this.goals = new GoalQueue(undefined, {
      maxGoals: resolveAgentMaxGoals(config.maxGoals),
    });
    this.intentions = new IntentionStack();
    this.expressionLibrary =
      config.expressionLibrary ?? new ExpressionLibrary();
    this.propositionLibrary =
      config.propositionLibrary ?? new PropositionLibrary();
    this.inbox = new Inbox(config.maxInboxSize);
    this.emitter.setMaxListeners(0);

    // Wired in the constructor rather than in start(), so a monitor can listen
    // for goals before the agent runs — and keeps listening across restarts.
    this.goals.on("goalAdded", (goal) => this.onGoalAdded(goal));
    this.goals.on("goalStatusChanged", (goal) =>
      this.onGoalStatusChanged(goal),
    );
    this.goals.on("goalRejected", (goal) => this.onGoalRejected(goal));
    this.goals.on("goalRemoved", (goal) => this.onGoalRemoved(goal));
    this.intentions.on("intentionRemoved", (intention) =>
      this.onIntentionRemoved(intention),
    );

    this.config = {
      maxConcurrentIntentions: 10,
      maxInboxSize: DEFAULT_MAX_INBOX_ENTRIES,
      ...config,
      beliefs: this.beliefs,
      maxGoals: resolveAgentMaxGoals(config.maxGoals),
      beliefKey: config.beliefKey ?? defaultBeliefKey,
      // Resolved after the spread rather than defaulted before it, so an
      // explicitly-passed `undefined` cannot clobber the empty default — a
      // caller that forwards a possibly-absent value would otherwise leave the
      // chain undefined, and reading `.length` off that throws inside the
      // reasoner. Empty means nothing intercepts: an assertion is believed and
      // a request is agreed to, which is the trust-and-cooperation default
      // stated as configuration rather than as an absence of code.
      middleware: config.middleware ?? [],
      directiveMiddleware: config.directiveMiddleware ?? [],
      expressionLibrary: this.expressionLibrary,
      propositionLibrary: this.propositionLibrary,
      replyTimeoutMs: config.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
      evaluationTimeoutMs:
        config.evaluationTimeoutMs ?? DEFAULT_EVALUATION_TIMEOUT_MS,
      maxConcurrentEvaluations:
        config.maxConcurrentEvaluations ?? DEFAULT_MAX_CONCURRENT_EVALUATIONS,
      delegationTimeoutMs:
        config.delegationTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
    };
  }

  /**
   * Start the agent. Registers its mailbox and subscribes every previously
   * requested topic, awaiting the bus once the transport has acknowledged
   * them (for a Redis bus this means no published message can race ahead of
   * the subscription). Resolves when the agent is fully ready. If
   * `tickIntervalMs` is provided, the reasoning cycle runs on a timer;
   * otherwise drive it manually via `tick()`.
   */
  async start(tickIntervalMs?: number): Promise<void> {
    this.running = true;
    this.bus.registerAgent(this.id, this.handleMessage.bind(this));

    const topics = Array.from(this.subscribedTopics);
    const unsubs = await Promise.all(
      topics.map((topic) =>
        this.bus.subscribe(topic, this.handleMessage.bind(this)),
      ),
    );
    this.unsubs.push(...unsubs);

    if (tickIntervalMs) {
      this.tickTimer = setInterval(() => {
        if (this.running) {
          this.tick();
        }
      }, tickIntervalMs);
    }
  }

  /**
   * Stop the agent: unsubscribe and stop the tick timer.
   *
   * This pauses the agent rather than ending its work. Goals, intentions and
   * the requests it agreed to are all kept, so nothing is answered on stop. A
   * restarted agent carries on and answers each agreed request with its
   * terminal `inform` or `failure` when the goal ends. An application that
   * stops an agent for good owes its requesters that answer itself — for
   * example by removing the open goals and running one more `tick()` before
   * stopping, which answers each agreed one with a `failure`.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }

  async tick(): Promise<void> {
    // Yield to the event loop so messages queued on async transports (e.g.
    // Redis Pub/Sub) can be delivered before this reasoning cycle runs. A
    // manual drive loop that awaits tick() in a tight chain runs entirely on
    // microtasks and starves pending socket I/O; this macrotask yield is a
    // correctness requirement, not a timeout.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Perceive, then revise. Beliefs and goals are changed from what the cycle
    // perceived rather than from inside the bus's delivery callback, so what
    // the agent believes is always a decision it took, not a side effect of
    // something having been sent to it.
    await this.reviseBeliefs(this.perceive());
    // A cancel that had to wait for a running action is carried out at the
    // first boundary after it.
    await this.processQueuedCancels();
    // After revision, so a reply that arrived this cycle closes its exchange
    // before the deadline is checked.
    await this.expireReplies();
    // After the replies that settle delegations, so a delegation answered in
    // time is never expired by the same cycle that heard its answer.
    await this.expireDelegations();
    // After the revision that decided them, so the goal id an `agree` names is
    // always one the receiver already holds.
    await this.flushDirectiveAnswers();
    // Evaluations that settled since last cycle, then this cycle's standing
    // evaluations started. Both after the `agree`s have gone out, so a
    // subscription's first value or a condition that already holds never
    // reaches the sender before the agreement does; before deliberation, so a
    // goal a condition created can be worked this same cycle.
    await this.applySettledEvaluations();
    this.retryPendingFires();
    this.evaluateStanding();
    this.deliberate();
    await this.meansEndsReasoning();
    await this.execute();
    await this.processQueuedCancels();
    // Before collection: refusing a sub-goal fails the parent waiting on it, and
    // that cascade has to run while the parent is still waiting. Collection
    // would otherwise release the parent as if the sub-goal had succeeded.
    await this.reportRejections();
    // The terminal answer owed to every requester whose goal finished this
    // cycle — after `reportRejections`, which fails the parents waiting on a
    // refused sub-goal and so queues more of them.
    await this.flushTerminalAnswers();
    // A fast evaluation started this cycle — a belief lookup, a cached value —
    // has settled by now, after one turn of the event loop, and is answered in
    // the same cycle it was asked in. A slow one is not waited for: it is
    // applied by whichever later cycle finds it settled.
    if (this.evaluationsInFlight > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await this.applySettledEvaluations();
    // Last, so the whole event sequence of the jobs that finished this cycle —
    // including the `intention:completed` handlers that still expect to read
    // their goal — is delivered before anything is collected.
    this.collectFinished();
  }

  /** Whether another evaluation may start: see {@link AgentConfig.maxConcurrentEvaluations}. */
  private canEvaluate(): boolean {
    const limit = this.config.maxConcurrentEvaluations;
    return limit <= 0 || this.evaluationsInFlight < limit;
  }

  /**
   * Starts evaluating a proposition or expression without waiting for it, and
   * arranges for `then` to run, inside a later step of a tick, once it
   * settles. This is what keeps a slow evaluation — a service call, a model —
   * from stalling the reasoning cycle: the tick goes on with everything else,
   * and applies the outcome whenever it is ready.
   *
   * Bounded by {@link AgentConfig.evaluationTimeoutMs}: an evaluation still
   * running past it is abandoned and settles as an error, which the caller
   * answers `failure`.
   */
  private startEvaluation(
    library: ExpressionLibrary,
    name: string,
    message: Message,
    then: (
      outcome: { value: unknown } | { error: unknown },
    ) => Promise<void> | void,
  ): void {
    const timeoutMs = this.config.evaluationTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluation = library.evaluate(name, this.beliefs, message);
    const bounded =
      timeoutMs > 0
        ? Promise.race([
            evaluation,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`timed out after ${timeoutMs}ms`)),
                timeoutMs,
              );
              // A pending evaluation must not keep the process alive.
              timer.unref?.();
            }),
          ])
        : evaluation;

    this.evaluationsInFlight++;
    const settle = (outcome: { value: unknown } | { error: unknown }): void => {
      if (timer) clearTimeout(timer);
      this.evaluationsInFlight--;
      this.settledEvaluations.push(async () => {
        await then(outcome);
      });
    };
    bounded.then(
      (value) => settle({ value }),
      (error: unknown) => settle({ error }),
    );
  }

  /** Runs the continuation of every evaluation that has settled, in order. */
  private async applySettledEvaluations(): Promise<void> {
    while (this.settledEvaluations.length > 0) {
      const settled = this.settledEvaluations;
      this.settledEvaluations = [];
      for (const apply of settled) {
        try {
          await apply();
        } catch (error) {
          console.error(`[${this.id}] Failed to apply an evaluation:`, error);
        }
      }
    }
  }

  /**
   * Closes every exchange whose `reply-by` has passed with no reply, as
   * unanswered.
   *
   * No reply says nothing about the answer or about the peer's intentions, so
   * the uncertain belief the exchange opened is removed rather than set
   * negative, and `unanswered.<peer>.<name>.<exchange>` records why — the same
   * rule as a refused query. A reply that arrives afterwards finds nothing open
   * and is treated as an ordinary message.
   */
  private async expireReplies(): Promise<void> {
    const now = Date.now();
    for (const awaited of [...this.awaitingReply.values()]) {
      if (awaited.deadline > now) continue;
      this.awaitingReply.delete(awaited.exchange);

      const pending = this.pendingQueries.get(awaited.exchange);
      if (pending) {
        this.pendingQueries.delete(awaited.exchange);
        this.beliefs.remove(pending.key);
      }
      if (awaited.key && this.beliefs.statusOf(awaited.key) === "uncertain") {
        this.beliefs.remove(awaited.key);
      }
      await this.endSentRequest(awaited.exchange, {
        failed: `no reply by ${awaited.replyBy}`,
      });
      this.beliefs.set(
        this.exchangeKey(
          "unanswered",
          awaited.peer,
          awaited.name,
          awaited.exchange,
        ),
        {
          performative: "timeout",
          ...(pending ? { question: pending.question } : {}),
          reason: `no reply by ${awaited.replyBy}`,
        },
        "positive",
      );
      this.emitter.emit("reply:timeout", {
        agentId: this.id,
        peer: awaited.peer,
        performative: awaited.performative,
        name: awaited.name,
        exchange: awaited.exchange,
        replyBy: awaited.replyBy,
      } satisfies ReplyTimeout);
    }
  }

  /**
   * The belief key recording a peer's stance on a goal.
   *
   * Scope is per exchange — `intent.<peer>.<goal>.<exchange>` — rather than per
   * goal, because two requests for the same goal can end differently and the
   * second must not be able to rewrite the first's record (a refusal to a
   * second `fetch` offer must not flip the first offer's agreement back to
   * negative). The exchange is the `replyWith` of the original request, which
   * arrives back as the reply's `inReplyTo`, so both sides of the same exchange
   * compute the same string. Advertising ids on the type is never forced, so a
   * message that names none — a bare request or reply from a producer that opts
   * out of correlation — simply degrades to `intent.<peer>.<goal>`, the same
   * key such a producer would have produced before correlation existed.
   */
  private exchangeKey(
    prefix:
      | "intent"
      | "infeasible"
      | "failed"
      | "done"
      | "result"
      | "cancelled"
      | "cancel-failed"
      | "answer"
      | "subscription"
      | "unanswered",
    peer: string,
    goal: string,
    exchange?: string,
  ): string {
    return exchange
      ? `${prefix}.${peer}.${goal}.${exchange}`
      : `${prefix}.${peer}.${goal}`;
  }

  /**
   * Sends a directive request to another agent, tracking the outcome in the
   * belief base.
   *
   * Creates an `uncertain` intention belief so the agent can follow the job
   * through to agreement or refusal without guessing ids. Scoped to the
   * exchange, `intent.<receiver>.<goal>.<exchange>` is promoted to `"positive"`
   * on {@link GoalAck} and set to `"negative"` on {@link GoalRefusal}, alongside
   * an `infeasible.<receiver>.<goal>.<exchange>` belief on refusal — the
   * exchange being the request's `replyWith`, so each request tracks its own
   * outcome. Both are readable via {@link BeliefBase.statusOf} and
   * {@link BeliefBase.get}, and prefix-queryable by peer and goal.
   *
   * @param receiver — the agent id that will receive the request
   * @param content — additional message content forwarded verbatim in the body
   * @param exchange — the request's `replyWith`, the id replies will name back
   */
  protected markRequestIntention(
    receiver: string,
    content: unknown,
    exchange?: string,
  ): void {
    const goal =
      isRecord(content) && typeof content.goal === "string" ? content.goal : "";
    if (!goal || !receiver) return;

    const key = this.exchangeKey("intent", receiver, goal, exchange);

    // Do not downgrade an intention that already has a positive stance — an
    // agree may have arrived out of order or the sender sent the same request
    // twice. "uncertain" is only promoted, never demoted by this helper; the
    // refuse path handles that separately.
    if (this.beliefs.statusOf(key) === "positive") {
      return;
    }

    this.beliefs.set(key, content, "uncertain");
  }

  /**
   * Opens the question a `query-if` or `query-ref` asks, the way
   * {@link markRequestIntention} opens a request: an `uncertain` belief at
   * `answer.<peer>.<name>.<exchange>`, with no value yet, settled when the
   * reply naming this query arrives.
   *
   * Scoped to the exchange because the name alone is not the whole question: a
   * proposition is evaluated against the asking message too, so `in-stock` for
   * one SKU and for another are two questions with two answers. Prefix-query
   * `answer.<peer>.<name>.` for every answer to that name.
   *
   * Only point-to-point queries are tracked — a query published to a topic has
   * no single peer whose answer settles it — and only ones that name what they
   * ask, since the key is built from the name.
   *
   * A `subscribe` opens the same way, at `subscription.<peer>.<name>.<exchange>`,
   * but stays open: every update the peer sends replaces the value, until this
   * agent cancels it or the peer refuses, fails or does not understand it.
   */
  private markPendingQuery(peer: string, query: Message): void {
    const name =
      isRecord(query.content) && typeof query.content.name === "string"
        ? query.content.name
        : "";
    if (!name || !query.replyWith) return;

    const standing = query.performative === "subscribe";
    const key = this.exchangeKey(
      standing ? "subscription" : "answer",
      peer,
      name,
      query.replyWith,
    );
    this.pendingQueries.set(query.replyWith, {
      peer,
      name,
      question: query.content,
      key,
      exchange: query.replyWith,
      ...(standing ? { standing } : {}),
    });
    this.beliefs.set(key, undefined, "uncertain");
  }

  /**
   * The open query this message replies to, if any: it names one of this
   * agent's queries as `inReplyTo` and comes from the agent that was asked.
   * Anything else — an `inform` nobody asked for, or one from a third party
   * naming our id — is not an answer, and takes the ordinary path.
   */
  private pendingQueryFor(msg: Message): PendingQuery | undefined {
    if (!msg.inReplyTo) return undefined;
    const pending = this.pendingQueries.get(msg.inReplyTo);
    return pending && pending.peer === msg.sender ? pending : undefined;
  }

  /**
   * Settles an open query with its answer.
   *
   * The answer is an assertion, so it runs the same `middleware` chain as any
   * other: trust gates an answer exactly as it gates a claim nobody asked for.
   * What changes is where it is filed. Rather than one `msg.*` belief per
   * content key — which would leave `msg.name` and `msg.result` overwritten by
   * the next answer, and the result detached from the question — the result
   * goes to the question's own belief, held `positive`.
   *
   * The value carries the truth: a `query-if` answered `false` is
   * `answer.<peer>.<name>.<exchange> = false`, held positive, which is the
   * belief that the proposition does not hold — FIPA's `inform(¬φ)`. A
   * negative stance is never used to say "false"; one encoding, not two.
   *
   * An answer the chain rejects leaves the belief `uncertain`: the question was
   * answered, but not in a way this agent accepts. Either way the exchange is
   * closed.
   */
  private async settleQueryAnswer(
    msg: Message,
    pending: PendingQuery,
  ): Promise<void> {
    // A subscription is answered again on every change, so its answer replaces
    // the last rather than closing the question.
    if (!pending.standing) {
      this.pendingQueries.delete(pending.exchange);
    }
    const content = msg.content;
    const result =
      isRecord(content) && "result" in content ? content.result : content;

    await this.ingestAssertion(msg, () => {
      this.beliefs.set(pending.key, result, "positive");
      return { keys: [pending.key], status: "positive" };
    });
  }

  /**
   * Closes an open query that will not be answered: the peer refused it,
   * failed to evaluate it, or did not understand it.
   *
   * None of those says anything about the proposition or expression itself,
   * so the answer belief is removed rather than set `negative` — under the
   * one-encoding rule a negative stance on it would read as "the proposition
   * does not hold", which nobody said. Why it went unanswered is recorded
   * beside it at `unanswered.<peer>.<name>.<exchange>`, the counterpart of a
   * request's `infeasible.*` record. Held `positive`: it is a fact this agent
   * holds about the exchange.
   */
  private settleUnansweredQuery(msg: Message, pending: PendingQuery): void {
    this.pendingQueries.delete(pending.exchange);
    this.beliefs.remove(pending.key);

    const content = isRecord(msg.content) ? msg.content : {};
    this.beliefs.set(
      this.exchangeKey(
        "unanswered",
        pending.peer,
        pending.name,
        pending.exchange,
      ),
      {
        performative: msg.performative,
        question: pending.question,
        ...(typeof content.verdict === "string"
          ? { verdict: content.verdict }
          : {}),
        ...(typeof content.reason === "string"
          ? { reason: content.reason }
          : {}),
      },
      "positive",
    );
  }

  async subscribe(topic: string): Promise<() => void> {
    if (this.subscribedTopics.has(topic)) {
      return () => {};
    }
    this.subscribedTopics.add(topic);
    if (!this.running) {
      return () => {
        this.subscribedTopics.delete(topic);
      };
    }
    const unsub = await this.bus.subscribe(
      topic,
      this.handleMessage.bind(this),
    );
    this.unsubs.push(unsub);
    return () => {
      unsub();
      this.subscribedTopics.delete(topic);
    };
  }

  /**
   * Observes agent-level events — see `AgentEventMap` for the full list, and
   * `agent.goals`/`agent.beliefs` for the goal queue's and the belief base's
   * own events. The handler is typed per event, so the payload needs no cast.
   *
   * Acks deliberately produce no belief, goal or intention: they report a fact
   * the agent already has (it asked, and the responder owns the goal queue), and
   * the belief base is for what the agent holds about the world, not a log of
   * its own protocol traffic. Correlating ids to threads is the caller's job.
   *
   * Handlers run synchronously, so they must not block. Goal events arrive
   * whether or not the agent is running, and everything here covers only this
   * agent's own work — a bus-wide view of the run is something the user builds
   * from these events, mapping them onto their own channel or telemetry.
   *
   * Returns an unsubscribe function.
   *
   * @example
   * ```ts
   * agent.on("intention:failed", ({ intention, reason }) => {
   *   console.error(`${intention.goal.name}: ${reason}`);
   * });
   * ```
   */
  on<E extends AgentEvent>(
    event: E,
    handler: AgentEventHandler<E>,
  ): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }

  private onGoalAdded(goal: Goal): void {
    const stored = this.goals.get(goal.id) ?? goal;
    this.lastGoalStatus.set(stored.id, stored.status);
    this.emitter.emit("goal:added", stored);
  }

  private onGoalStatusChanged(goal: Goal): void {
    const from = this.lastGoalStatus.get(goal.id) ?? goal.status;
    this.lastGoalStatus.set(goal.id, goal.status);
    this.emitter.emit("goal:status", {
      goal,
      from,
      to: goal.status,
    } satisfies GoalStatusChange);

    // The terminal transition is where the request protocol's answer is owed,
    // so it is taken from there rather than from the handful of call sites that
    // reach it: `completeIntention`, `failIntention`, a goal dropped by
    // `dependsOn`, and anything else that finishes an agreed goal. One choke
    // point, so no path can end silently.
    if (isTerminalGoalStatus(goal.status)) {
      this.queueOutcome(goal);
    }
  }

  /**
   * A goal left the queue. Releases the intentions waiting on it and drops the
   * remembered status, so neither outlives the goal.
   *
   * A goal collected after finishing has already had its terminal answer
   * queued, so its open request is gone by now. One still open means the goal
   * was taken out before it finished — an explicit `goals.remove()` — and the
   * requester, who holds an `agree` for it, is owed the `failure` here: no
   * terminal transition is coming that would send it.
   */
  private onGoalRemoved(goal: Goal): void {
    this.lastGoalStatus.delete(goal.id);
    const open = this.openRequests.get(goal.id);
    if (open) {
      this.openRequests.delete(goal.id);
      this.pendingOutcomes.push({
        ...open,
        performative: "failure",
        reason: "goal removed before it finished",
      });
    }
    this.goalEndReasons.delete(goal.id);
    // Read by the parent's release, so dropped only after it.
    this.releaseWaitingParents(goal);
    this.goalResults.delete(goal.id);
    this.emitter.emit("goal:removed", goal);
  }

  private onIntentionRemoved(intention: Intention): void {
    this.emitter.emit("intention:removed", intention);
  }

  /**
   * Queues a refusal for the next cycle. Reporting is deferred, like the goal
   * acknowledgements, so a goal that arrives from a message is answered on a
   * tick rather than from inside the bus's synchronous delivery.
   */
  private onGoalRejected(goal: Goal): void {
    const rejection = {
      goal,
      reason: `rejected: goal queue is full (limit ${this.config.maxGoals})`,
    } satisfies GoalRejection;
    this.pendingRejections.push(rejection);
    this.emitter.emit("goal:rejected", rejection);
  }

  /**
   * Reports every goal refused since the last cycle: a `refuse` reply to whoever
   * asked for the work, and — for a refused sub-goal — the same treatment its
   * parent gets when a sub-goal it was waiting for fails.
   *
   * The reply is a `refuse` rather than the `failure` this library once sent:
   * a goal shed for capacity was declined, not attempted and abandoned. It goes
   * out only for a root goal. A sub-goal carries its parent's `source`, so the
   * sender it would answer is the one already holding an `agree` for the goal
   * it actually asked for, and FIPA allows no `refuse` after `agree` (SC00026):
   * the sub-goal's refusal ends the root goal, and the cascade below is what
   * puts that single `failure` on the wire.
   */
  private async reportRejections(): Promise<void> {
    if (this.pendingRejections.length === 0) {
      return;
    }

    const rejections = this.pendingRejections;
    this.pendingRejections = [];

    for (const { goal, reason } of rejections) {
      const to = goal.source ? replyAddress(goal.source) : "";
      if (
        !goal.parentGoalId &&
        goal.source?.sender !== this.id &&
        to &&
        to !== this.id
      ) {
        await this.sendRefusalReply(goal, to, reason);
      }

      if (goal.parentGoalId) {
        await this.failWaitingParents(goal, reason);
      }
    }
  }

  /**
   * Tells the requester its goal was declined, since no `agree` went out. Only
   * ever a root goal's requester: see {@link reportRejections}.
   */
  private async sendRefusalReply(
    goal: Goal,
    to: string,
    reason: string,
  ): Promise<void> {
    const source = goal.source;
    try {
      await this.sendMessage(to, {
        performative: "refuse",
        sender: this.id,
        receiver: to,
        content: {
          goal: goal.name,
          goalId: goal.id,
          // Distinguishes the verdict from the reason for it: this goal was shed
          // by the queue's own bound, whatever the human-readable reason says.
          verdict: "capacity",
          reason,
        },
        ...(source?.conversationId
          ? { conversationId: source.conversationId }
          : {}),
        ...(source?.inReplyTo ? { inReplyTo: source.inReplyTo } : {}),
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${this.id}] Failed to report goal rejection to ${to}:`,
        error,
      );
    }
  }

  /**
   * Answers a message this agent heard but could not understand.
   *
   * The reply keeps the message it answers in reach: it inherits the
   * conversation and names the message as `inReplyTo`, so the sender can tie a
   * `not-understood` to the exact message that produced it. Every case a reply
   * is needed — an unknown performative, content that violates a schema — goes
   * through here, because five call sites building the same envelope five times
   * is how a correlation field gets left off one of them.
   */
  private sendNotUnderstood(msg: Message, reason: string): void {
    // Callers guard this too, to decide their own control flow; the guard here
    // is what makes the helper safe to reach from a site that forgets it. A
    // message with no sender cannot be answered, and answering ourselves is
    // the loop the outer guards exist to prevent.
    const to = replyAddress(msg);
    if (!msg.sender || msg.sender === this.id || !to || to === this.id) {
      return;
    }
    void this.sendMessage(to, {
      performative: "not-understood",
      sender: this.id,
      receiver: to,
      content: { event: msg.performative, reason },
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
      timestamp: Date.now(),
    });
  }

  /**
   * Sends through the bus and reports the message as sent. The event waits for
   * the bus to accept the message, so a monitor never sees traffic that did
   * not go out.
   *
   * Stamps `conversationId` and `replyWith` for anything missing them. Both are
   * optional on {@link Message} so adopting the framework does not force an
   * opinion on a producer that already stamps its own ids — but a message this
   * library sends is part of an exchange, and without `conversationId` a peer
   * cannot tell it apart from its reply, and without `replyWith` no reply can
   * name it back. Only absent values are filled in, so a caller with ids that
   * mean something keeps them.
   *
   * Returns the message as sent rather than the one handed in, since the ids
   * are added here: a caller wanting to wait for *this* request rather than the
   * next one for the same goal needs the stamped copy, and an unmutated
   * argument would quietly deny it that.
   *
   * Tracks request performatives in the belief base: a request creates an
   * `uncertain` intention belief that is promoted on {@link GoalAck} and set to
   * `"negative"` on {@link GoalRefusal}, alongside an `infeasible` belief on
   * refusal. This runs here so every request — whether sent directly or from an
   * action result — is tracked without any caller having to remember.
   */
  private async sendMessage(
    agentId: string,
    message: Message,
    options: { replyBy?: null } = {},
  ): Promise<Message> {
    // A directive gets the agent's default `reply-by` unless it set its own,
    // or opted out with `replyBy: null`. Anything else expects no reply, so a
    // deadline on it would mean nothing.
    const timeoutMs = this.config.replyTimeoutMs;
    const replyBy =
      message.replyBy ??
      (options.replyBy !== null &&
      timeoutMs > 0 &&
      hasHearerEffect(message.performative)
        ? new Date(Date.now() + timeoutMs).toISOString()
        : undefined);
    const stamped: Message = {
      ...message,
      conversationId: message.conversationId ?? randomUUID(),
      replyWith: message.replyWith ?? randomUUID(),
      ...(replyBy !== undefined ? { replyBy } : {}),
    };
    const exchange = stamped.replyWith!;

    // Replies only come back here when the directive did not send them
    // elsewhere with `reply-to`. A question whose answer goes to a third agent
    // is that agent's to track, not ours.
    const repliesHere =
      stamped.replyTo === undefined || stamped.replyTo === this.id;

    // A conditional request is a request too: its `agree` promotes the same
    // `intent.*` belief, it just fires later.
    const isRequest =
      stamped.performative === "request" ||
      stamped.performative === "request-when" ||
      stamped.performative === "request-whenever";
    if (isRequest && repliesHere && stamped.receiver !== undefined) {
      this.markRequestIntention(stamped.receiver, stamped.content, exchange);
      const goal = isRecord(stamped.content) ? stamped.content.goal : undefined;
      if (typeof goal === "string" && goal) {
        this.sentRequests.set(exchange, {
          peer: agentId,
          goal,
          performative: stamped.performative,
          exchange,
        });
      }
    }
    const isQuestion =
      isQueryDirective(stamped.performative) ||
      stamped.performative === "subscribe";
    if (isQuestion && repliesHere) {
      this.markPendingQuery(agentId, stamped);
    }
    if ((isRequest || isQuestion) && repliesHere && replyBy !== undefined) {
      this.awaitReply(agentId, stamped, replyBy);
    }
    // A cancel of one of our own requests or subscriptions is tracked until
    // its reply says whether it took: only an `inform` ends the request here.
    // Until then the request stays open, so its own replies still land.
    if (stamped.performative === "cancel" && stamped.inReplyTo !== undefined) {
      const request = this.sentRequests.get(stamped.inReplyTo);
      const subscription = this.pendingQueries.get(stamped.inReplyTo);
      if (request?.peer === agentId) {
        this.pendingCancels.set(exchange, {
          peer: agentId,
          target: stamped.inReplyTo,
          kind: "request",
          name: request.goal,
        });
      } else if (subscription?.standing && subscription.peer === agentId) {
        this.pendingCancels.set(exchange, {
          peer: agentId,
          target: stamped.inReplyTo,
          kind: "subscription",
          name: subscription.name,
        });
      }
    }
    await this.bus.send(agentId, stamped);
    this.emitter.emit("message:sent", stamped);
    return stamped;
  }

  /**
   * Starts the clock on a directive's first reply. Any reply from the peer
   * naming the directive stops it (see `reviseBeliefs`); if `replyBy` passes
   * first, {@link expireReplies} closes the exchange as unanswered.
   */
  private awaitReply(peer: string, directive: Message, replyBy: string): void {
    const deadline = Date.parse(replyBy);
    const exchange = directive.replyWith;
    if (Number.isNaN(deadline) || !exchange) return;

    const content = isRecord(directive.content) ? directive.content : {};
    // A request names its goal; a query or subscription names what it asks.
    const isRequest =
      directsAction(directive.performative) ||
      directive.performative === "request-when" ||
      directive.performative === "request-whenever";
    const named = isRequest ? content.goal : content.name;
    if (typeof named !== "string" || !named) return;
    const name = named;

    this.awaitingReply.set(exchange, {
      peer,
      performative: directive.performative,
      name,
      exchange,
      replyBy,
      deadline,
      ...(isRequest
        ? { key: this.exchangeKey("intent", peer, name, exchange) }
        : {}),
    });
  }

  private async publishMessage<T>(
    topic: string,
    message: Message<T>,
  ): Promise<Message<T>> {
    // Topic traffic is stamped exactly as point-to-point traffic is: the
    // envelope parameters are optional on the type, but a message this library
    // sends is always part of some exchange, and a subscriber that wants to
    // name a notification back has a `replyWith` to do it with. Builders that
    // inherit from a goal's source set those first; this fills in what they
    // left absent, so a notification about a goal nobody asked for simply gets
    // a fresh pair rather than none.
    const stamped: Message<T> = {
      ...message,
      conversationId: message.conversationId ?? randomUUID(),
      replyWith: message.replyWith ?? randomUUID(),
    };
    await this.bus.publish(topic, stamped);
    this.emitter.emit("message:sent", stamped);
    return stamped;
  }

  private handleMessage(msg: Message): void {
    // Reported before queueing, so a monitor sees every message that
    // arrives — including the ones no performative produces anything from.
    this.emitter.emit("message:received", msg);
    // Queued rather than acted on. The bus calls this synchronously, from
    // inside a `publish` or a `send`, so anything decided here would be
    // decided on the sender's stack, before the receiver had reasoned about
    // anything.
    this.inbox.push(msg);
  }

  /**
   * Takes everything the bus has delivered since the last cycle.
   *
   * Percept of the cycle: the events that happened, in the order they did.
   * They are passed straight to {@link reviseBeliefs} and not retained — a
   * percept is not a belief, and holding one past the decision would make it
   * state after all.
   */
  private perceive(): InboxEntry[] {
    return this.inbox.drain();
  }

  /**
   * Turns this cycle's percepts into beliefs and goals, by performative.
   *
   * The split is the point of FIPA-ACL's communicative-act classes, and it is
   * what separates what a message *asks* from what it *claims*:
   *
   * - a **directive** is the one performative with a compelled hearer effect.
   *   `request` is offered to the goal queue — and only because this library
   *   chooses to comply; FIPA leaves the receiver free to `refuse`, and a
   *   request can come back declined, for want of capacity or for want of a
   *   plan, before a goal ever exists. `query-if` and `query-ref` are
   *   directives too, but ones the receiver *answers* rather than works: they
   *   run the same middleware chain and are then evaluated against the agent's
   *   knowledge, creating no goal. `request-when`, `request-whenever` and
   *   `subscribe` leave a standing commitment instead, watched every tick.
   * - an **assertion** asks nothing of the receiver. FIPA's rational effect is
   *   that the receiver believes it, but that is the sender's aim, not a
   *   duty, so becoming a belief is a decision the agent makes under its
   *   `middleware` chain, never a consequence of having received it.
   * - everything else — an expressive, a commissive, an unclassified act — is
   *   about the conversation rather than the world, and produces no state.
   *   `cancel` included: it withdraws a commitment.
   *
   * The standing directives are classed assertive as well, because SC00037J
   * defines them as an `inform` of the sender's intention. What they assert is
   * that intention, not their content, so a directive's content never reaches
   * the belief base.
   */
  private async reviseBeliefs(percepts: InboxEntry[]): Promise<void> {
    for (const { message } of percepts) {
      // An unknown performative cannot be understood — there is no handler for
      // it. Answer `not-understood` so the sender can tell "heard and unknown"
      // from "never heard". The sender is required so we do not loop-reply to
      // ourselves.
      if (
        !isKnownPerformative(message.performative) &&
        message.sender &&
        message.sender !== this.id
      ) {
        const reason = `unknown performative: "${message.performative}"`;
        this.sendNotUnderstood(message, reason);
        continue;
      }

      // Any reply from the peer naming one of our directives is its first
      // reply, whatever it says, so the `reply-by` clock on it stops.
      if (
        message.inReplyTo !== undefined &&
        this.awaitingReply.get(message.inReplyTo)?.peer === message.sender
      ) {
        this.awaitingReply.delete(message.inReplyTo);
      }

      // A directive whose `reply-by` passed before this agent got to it is
      // dropped unanswered: its sender has already closed the exchange, so
      // agreeing or working would be for nobody. Reported locally instead.
      if (
        hasHearerEffect(message.performative) &&
        message.sender !== this.id &&
        isPast(message.replyBy)
      ) {
        this.emitter.emit("directive:expired", message);
        continue;
      }

      // The reply to a cancel this agent sent settles the request or
      // subscription it named, whatever the reply's act.
      const pendingCancel = this.pendingCancelFor(message);
      if (pendingCancel) {
        await this.settleCancelReply(message, pendingCancel);
        continue;
      }

      // A reply to one of this agent's own queries settles the question it
      // asked, before any other reading of the message. Matched by
      // `inReplyTo`, never by the content's shape, so an `inform` nobody asked
      // for is still an ordinary assertion.
      const pendingQuery = this.pendingQueryFor(message);
      if (pendingQuery) {
        switch (message.performative) {
          case "inform":
          case "inform-if":
          case "inform-ref":
          case "confirm":
            await this.settleQueryAnswer(message, pendingQuery);
            continue;
          case "agree":
            // FIPA's query protocol lets the receiver agree before answering.
            // The question stays open; the answer is still to come.
            continue;
          case "refuse":
            this.settleUnansweredQuery(message, pendingQuery);
            await this.handleRefusalMessage(message);
            continue;
          case "failure":
          case "not-understood":
            // The query went unanswered; the record says why. The generic
            // assertion path is skipped, so the reply does not also land as
            // loose `msg.*` beliefs detached from the question.
            this.settleUnansweredQuery(message, pendingQuery);
            continue;
        }
      }

      // An `inform` answering one of this agent's requests is that request's
      // result, filed under its exchange rather than as loose `msg.*`
      // beliefs: `done: true` completes it, anything else is a note on it.
      const sentRequest = this.sentRequestFor(message);
      if (
        sentRequest &&
        (message.performative === "inform" ||
          message.performative === "inform-if" ||
          message.performative === "inform-ref" ||
          message.performative === "confirm")
      ) {
        await this.settleRequestInform(message, sentRequest);
        continue;
      }

      // The answer to a directive, before anything about the world: an
      // agreement or refusal is bookkeeping about a conversation, and must not
      // reach the belief base even though both are class-assertive.
      if (message.performative === "agree") {
        this.handleAgreement(message);
        continue;
      }

      if (message.performative === "refuse") {
        await this.handleRefusalMessage(message);
        continue;
      }

      // `failure` and `not-understood` are asserts in FIPA's own model (§3): their
      // rational effect is `Bj α`, the same shape as `inform`. They carry a
      // proposition about what happened (a failed attempt, a perceived problem)
      // and the receiver decides whether to believe it under its middleware.
      // In addition to the standard assertion path, we store a semantic belief
      // so plans can query what other agents have failed on or not understood.
      if (message.performative === "failure") {
        await this.handleFailureMessage(message);
        continue;
      }

      if (message.performative === "not-understood") {
        await this.handleNotUnderstoodMessage(message);
        continue;
      }

      // `cancel` withdraws a standing commitment this agent holds for the
      // sender. It is about the conversation, not the world, so it never
      // reaches the belief base either.
      if (message.performative === "cancel") {
        await this.handleCancel(message);
        continue;
      }

      // Every directive this agent honours runs the same middleware chain, then
      // takes its own path: a request becomes a goal, a query is answered by
      // evaluating, and a standing directive — `request-when`,
      // `request-whenever`, `subscribe` — is agreed to and watched every tick.
      //
      // A directive this agent cannot act on does not go through
      // `considerDirective`. That is `cfp` alone: it asks for a proposal inside
      // a negotiation this library keeps no state for, and is answered
      // `unsupported` — FIPA's own latitude, the hearer of a directive may
      // refuse — rather than quietly doing something else.
      if (
        isQueryDirective(message.performative) ||
        isStandingDirective(message.performative)
      ) {
        await this.considerDirective(
          message,
          directivePriority(message.performative) ?? 5,
        );
      } else if (isUnsupportedDirective(message.performative)) {
        await this.handleUnsupportedDirective(message);
      } else if (directsAction(message.performative)) {
        await this.considerDirective(
          message,
          directivePriority(message.performative) ?? 5,
        );
      }

      // Only what the sender asserts reaches the belief base. `request-when`,
      // `request-whenever` and `subscribe` are classed assertive too, since
      // SC00037J defines them as an `inform` of the sender's intention, but
      // what they assert is that *intention* — not their content. Storing `{ goal, when }` as beliefs
      // would have the receiver believe its own instructions.
      if (
        isPropositional(message.performative) &&
        !hasHearerEffect(message.performative)
      ) {
        // A message carries no stance: the sender of an `inform` believes what
        // it says (FIPA's feasibility precondition), so the receiver's stance
        // follows from the act alone — see `ingestAssertion`.
        await this.ingestAssertion(message);
      }
    }
  }

  /**
   * Runs the directive middleware chain, then decides on the directive.
   *
   * The chain runs first and unwrapped: it is the hook that can observe, rewrite
   * or veto a request or query before anything parses it or consults
   * the plan check and the goal bound. A chain that reaches the end triggers
   * {@link admitDirective} for a request and {@link answerQuery} for a query; a
   * chain that stops early, or throws, declines.
   *
   * Split from {@link admitDirective} so the interruption point is one function
   * rather than interleaved with the admission rules, and so an override can
   * choose to re-enter admission itself.
   */
  protected async considerDirective(
    msg: Message,
    priority: number,
  ): Promise<void> {
    const middleware = this.config.directiveMiddleware;
    const index = { at: 0 };
    let decided = false;

    // What the chain decided the answer should be. Kept here rather than
    // returned from `refuse`, because a handler declining through `res` has not
    // necessarily stopped the chain — it may go on to `next`, and later
    // handlers still run and still get a say.
    let answer: { verdict: RefusalVerdict; reason?: string } | undefined;

    const res: DirectiveResponse = {
      refuse: (verdict, reason) => {
        // First decline wins: the handler closest to the request has the most
        // specific view of it, and a later handler should not overwrite an
        // explanation that was already given.
        if (answer) {
          return;
        }
        answer = {
          verdict: verdict ?? "middleware",
          ...(reason !== undefined ? { reason } : {}),
        };
      },
    };

    const decide = async (): Promise<void> => {
      if (index.at >= middleware.length) {
        decided = true;
        // `res.refuse` outranks reaching the decision. Calling `next` after
        // declining is a no-op rather than an error, so a handler that declines
        // and then falls through does not accidentally admit the work.
        if (answer) {
          this.declineDirective(msg, answer.verdict, {
            ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
          });
          return;
        }

        // After the middleware has had a chance to repair the content, check
        // that it now satisfies the schema. A directive whose content is still
        // malformed cannot be understood, so answer `not-understood` rather than
        // dropping it silently. The middleware can still repair a missing goal
        // name, but if it cannot the sender is told.
        if (
          !validateContent(msg.performative, msg.content) &&
          msg.sender &&
          msg.sender !== this.id
        ) {
          const reason = schemaViolationReason(msg.performative, msg.content);
          this.sendNotUnderstood(msg, reason);
          return;
        }

        if (isQueryDirective(msg.performative)) {
          // A query is answered, not worked: the chain has said who may ask, and
          // the answer is the evaluation of the named proposition or expression
          // that alone follows. No goal exists, so nothing is agreed, queued or
          // refused beyond the chain's own say-so.
          this.answerQuery(msg);
          return;
        }

        if (isStandingDirective(msg.performative)) {
          // Agreed to here and watched every tick from now on; see
          // `evaluateStanding`.
          this.admitStanding(msg);
          return;
        }

        this.admitDirective(msg, priority);
        return;
      }
      const current = middleware[index.at++];
      await current(msg, res, decide);
    };

    try {
      await decide();
    } catch (error) {
      // A chain that threw has not established that the rest of it should be
      // trusted, so the work is not taken on and the rest is not run. Caught
      // rather than rethrown: one bad middleware should not end the tick, and
      // the sender is owed an answer either way.
      this.declineDirective(msg, "middleware", {
        reason: `middleware threw: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    // The decision itself answers — an `agree`, a refusal from `res`, or a
    // refusal from the admission rules — so nothing is sent here when the chain
    // ran all the way through. Answering again would put two replies on the wire
    // for one request.
    if (!decided) {
      if (answer) {
        // Declined through `res`, but the chain ended before the terminal step
        // that would have sent it. The same answer goes out now.
        this.declineDirective(msg, answer.verdict, {
          ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
        });
        return;
      }

      // The chain returned without reaching the decision, which is the
      // documented way to cancel. Declining rather than returning quietly is the
      // point: `request` compels a hearer effect, so the sender must be told
      // something. Silence would be indistinguishable from not having received
      // the request at all. No verdict is available, because a handler that just
      // stops said nothing about why — but the reason text still is, and it is
      // what separates a deliberate cancel from a chain that fell off the end.
      this.declineDirective(msg, "middleware", {
        reason: "cancelled by middleware",
      });
    }
  }

  /**
   * Decides whether to take on a directive, and acts on the decision.
   *
   * FIPA-ACL gives `request` a compelled hearer effect but does not make it an
   * obligation: the receiver may decline. So the directive is a request, and
   * this is where saying yes or no happens — before any goal exists, so a
   * declined directive consumes no queue slot and leaves nothing to collect.
   *
   * Reached only when the whole {@link DirectiveMiddleware} chain called
   * `next`, so by this point the application has declined anything it wanted to
   * decline. The agent agrees to every well-formed request it has capacity for,
   * declining on the two facts only it can know: whether a plan serves the
   * goal, and whether the queue has room. That is a choice, not a rule of FIPA:
   * it is what "compliant" means for an agent that has not been told otherwise.
   * Queries never reach here; {@link answerQuery} is their terminal step.
   */
  private admitDirective(msg: Message, priority: number): void {
    const goalName = isRecord(msg.content)
      ? (msg.content.goal as string)
      : undefined;

    if (!goalName) {
      // A request with no goal in its content cannot be served: there is no
      // plan to consult and nothing sensible to put in the queue. Instead of
      // dropping it silently, refuse so the sender gets an answer. Every
      // directive schema requires a goal name — a query creates no goal, so
      // only `request` reaches here — and reaching this branch means the
      // middleware chain replaced the content with something unreadable, and
      // the agent still owes the sender a reply.
      this.declineDirective(msg, "unsupported", {
        reason: `this agent does not implement "${msg.performative}"`,
      });
      return;
    }

    // Asked before the goal exists, which is the only place worth asking from.
    // A plan library is fixed for the agent's lifetime and a plan declares the
    // goal it serves, so "no plan can do this" is a fact about the agent, not
    // a question about current beliefs. Answering here rather than leaving the
    // goal in the queue is what keeps an unservable request from holding a
    // `maxGoals` slot for the rest of the run: with nothing able to select a
    // plan for it, such a goal would never reach a terminal status, and the
    // agent would slowly brick itself, agreeing to work it could never do and
    // refusing the work it could.
    if (!this.planLibrary.declares(goalName)) {
      this.declineDirective(msg, "no-plan", {
        reason: `no plan serves "${goalName}"`,
      });
      return;
    }

    const outcome = this.goalFromMessage(msg, priority);
    if (!outcome) {
      return;
    }

    if (!outcome.admitted) {
      // The queue refused the goal at admission, for want of capacity. The
      // queue is what declined it, so it also owns the reply: reportRejections
      // has already queued the `refuse`, naming the id it assigned and the
      // bound it hit. Re-declining here would send the sender two refusals for
      // one request, so this only raises the local event, leaving the queue's
      // answer as the single one that goes out.
      this.declineDirective(msg, "capacity", { send: false });
    }
  }

  /**
   * Answers a `query-if` or `query-ref` from the agent's knowledge, after the
   * directive middleware chain has admitted the question.
   *
   * A query is a directive the receiver *answers*, not a piece of work: it
   * names a {@link Proposition} (`query-if`) or an {@link Expression}
   * (`query-ref`) and the agent evaluates it against its own beliefs and the
   * message that asked. The two map one-to-one onto the libraries chosen at
   * construction, so nothing here parses the subject — the wire carries a
   * name, and the receiver owns the implementation behind it. No goal is
   * created, nothing is queued, and apart from the middleware chain's say-so
   * there is nothing to refuse: the answer is the evaluation.
   *
   * The answer is a plain `inform` carrying `{ name, result }`, in the same
   * exchange as the question — the conversation, and `in-reply-to` naming it —
   * so the sender pairs it with its query. An unknown name is `not-understood`:
   * the agent does not know that condition, which is a different answer from
   * knowing it to be false, and it is how the sender learns whether the name
   * is a question this agent can read at all. Whether a name is known is
   * asked of the library's registry (`has`), never inferred from the result.
   * A registered expression that finds nothing — answers `undefined` — is
   * answered `result: null`: "none" is an answer. An evaluation that throws is
   * a `failure { name, reason }` in the same exchange: the question was read
   * and an answer attempted, and it could not be completed.
   */
  private answerQuery(msg: Message): void {
    const to = replyAddress(msg);
    if (!msg.sender || msg.sender === this.id || !to || to === this.id) {
      return;
    }

    const content = isRecord(msg.content) ? msg.content : {};
    const name = content.name;
    if (typeof name !== "string" || name.length === 0) {
      const kind =
        msg.performative === "query-if" ? "proposition" : "expression";
      this.sendNotUnderstood(msg, `a "${msg.performative}" names no ${kind}`);
      return;
    }

    const isProposition = msg.performative === "query-if";
    const kind = isProposition ? "proposition" : "expression";
    const library = isProposition
      ? this.propositionLibrary
      : this.expressionLibrary;

    // Asked before evaluating, so "this agent does not know that name" is
    // decided by the registry alone. A registered body that answers
    // `undefined` has answered; it must not read as an unknown name.
    if (!library.has(name)) {
      this.sendNotUnderstood(msg, `no ${kind} named "${name}" is registered`);
      return;
    }

    const reply = {
      sender: this.id,
      receiver: to,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
    };

    // At the limit, the question is declined for now rather than queued: the
    // same backpressure a full goal queue answers a request with, and the
    // same transient verdict, so the asker may ask again.
    if (!this.canEvaluate()) {
      void this.sendMessage(to, {
        ...reply,
        performative: "refuse",
        content: {
          name,
          verdict: "capacity",
          reason: `evaluation limit reached (${this.config.maxConcurrentEvaluations} at once)`,
        },
        timestamp: Date.now(),
      });
      return;
    }

    // Started, not awaited: a slow proposition answers on a later cycle
    // rather than holding this one up. See `startEvaluation`.
    this.startEvaluation(library, name, msg, async (outcome) => {
      if ("error" in outcome) {
        // The agent read the question and tried to answer it, and the
        // evaluation could not complete (it threw, or ran past the evaluation
        // timeout): FIPA's `failure`, not a refusal.
        const error = outcome.error;
        await this.sendMessage(to, {
          ...reply,
          performative: "failure",
          content: {
            name,
            reason: `${kind} "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          timestamp: Date.now(),
        });
        return;
      }

      // "Nothing matches" is an answer, not a failure to understand: the
      // question was read and evaluated, and its referent is none. It goes on
      // the wire as `null` because JSON drops `undefined` — `{ name, result:
      // undefined }` would arrive as `{ name }`, and the asker could not tell
      // an empty answer from a malformed one.
      const result = outcome.value;
      await this.sendMessage(to, {
        ...reply,
        performative: "inform",
        content: { name, result: result === undefined ? null : result },
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Agrees to a `request-when`, `request-whenever` or `subscribe` and starts
   * watching it, after the directive middleware chain has admitted it.
   *
   * Declines on the facts only this agent knows, as admission does for a
   * request: a conditional request whose goal no plan serves is refused
   * `no-plan`, and a name the libraries do not hold (the condition of a
   * `request-when*`, the expression of a `subscribe`) is `not-understood`, as
   * an unregistered name is for a query. Capacity is not asked here: nothing is
   * queued until the condition holds, and a firing that finds the queue full
   * waits for room rather than being refused after the `agree`.
   *
   * The `agree` names what was committed to. For a conditional request it
   * carries FIPA's φ as `when`, which is what `agree(⟨i, act⟩, φ)` means: I
   * will act, but not until φ. A `request-when` also gets its goal id now, so
   * the sender can follow the goal that will exist later.
   */
  private admitStanding(msg: Message): void {
    const to = replyAddress(msg);
    if (
      !msg.sender ||
      msg.sender === this.id ||
      !to ||
      to === this.id ||
      !isRecord(msg.content)
    ) {
      return;
    }
    const kind = msg.performative as StandingCommitment["kind"];
    const content = msg.content;
    const id = msg.replyWith ?? `standing-${randomUUID()}`;

    const agreement: PendingAgreement = {
      to,
      goal: "",
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
    };

    if (kind === "subscribe") {
      const name = content.name as string;
      if (!this.expressionLibrary.has(name)) {
        this.sendNotUnderstood(
          msg,
          `no expression named "${name}" is registered`,
        );
        return;
      }
      this.standing.set(id, {
        kind,
        message: msg,
        sender: msg.sender,
        replyTo: to,
        id,
        name,
      });
      this.pendingAcks.push({ ...agreement, name });
      return;
    }

    const goal = content.goal as string;
    const when = content.when as string;
    if (!this.planLibrary.declares(goal)) {
      this.declineDirective(msg, "no-plan", {
        reason: `no plan serves "${goal}"`,
      });
      return;
    }
    if (!this.propositionLibrary.has(when)) {
      this.sendNotUnderstood(
        msg,
        `no proposition named "${when}" is registered`,
      );
      return;
    }

    const goalId = kind === "request-when" ? `goal-${randomUUID()}` : undefined;
    this.standing.set(id, {
      kind,
      message: msg,
      sender: msg.sender,
      replyTo: to,
      id,
      name: when,
      goal,
      ...(goalId !== undefined ? { goalId } : {}),
    });
    this.pendingAcks.push({
      ...agreement,
      goal,
      when,
      ...(goalId !== undefined ? { goalId } : {}),
    });
  }

  /**
   * Evaluates every standing commitment against the agent's current beliefs
   * and the directive that created it, and acts on what changed. Runs once a
   * tick.
   *
   * - **`request-when`** fires the first time its proposition holds,
   *   including at once if it already holds when agreed to, and is then an
   *   ordinary request: its goal is created under the id the `agree` named,
   *   and answered `inform` or `failure` when it ends.
   * - **`request-whenever`** fires each time its proposition goes from not
   *   holding to holding (and once at the start, if it already holds), each
   *   firing a goal of its own with its own terminal answer, until cancelled.
   * - **`subscribe`** sends `inform { name, result }` with the expression's
   *   value now, and again each time the value changes, until cancelled.
   *
   * A firing that finds the goal queue full is kept and retried next tick: the
   * agent agreed to the work, so shedding it with a `refuse` now would break
   * that agreement. An evaluation that throws ends the commitment with a
   * `failure`, FIPA's ending for something undertaken and not completed.
   */
  private evaluateStanding(): void {
    for (const commitment of [...this.standing.values()]) {
      // One evaluation at a time per commitment: a slow proposition is not
      // started again while the last run is still out.
      if (commitment.evaluating) continue;
      // At the limit, it is evaluated on a later cycle: it was agreed to, so
      // it waits for room rather than being declined.
      if (!this.canEvaluate()) return;
      commitment.evaluating = true;

      const library =
        commitment.kind === "subscribe"
          ? this.expressionLibrary
          : this.propositionLibrary;
      this.startEvaluation(
        library,
        commitment.name,
        commitment.message,
        async (outcome) => {
          commitment.evaluating = false;
          // Cancelled, or ended by an earlier outcome, while this one ran.
          if (this.standing.get(commitment.id) !== commitment) return;
          await this.applyStandingOutcome(commitment, outcome);
        },
      );
    }
  }

  /**
   * Acts on one evaluation of a standing commitment: reports a subscription's
   * new value, fires a conditional request whose proposition just came to
   * hold, or ends the commitment with `failure` when the evaluation threw or
   * timed out.
   */
  private async applyStandingOutcome(
    commitment: StandingCommitment,
    outcome: { value: unknown } | { error: unknown },
  ): Promise<void> {
    if ("error" in outcome) {
      this.standing.delete(commitment.id);
      const kind =
        commitment.kind === "subscribe" ? "expression" : "proposition";
      const error = outcome.error;
      await this.sendStandingReply(commitment, "failure", {
        ...(commitment.goal ? { goal: commitment.goal } : {}),
        name: commitment.name,
        reason: `${kind} "${commitment.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    if (commitment.kind === "subscribe") {
      // `null` for "nothing matches", as a query answers it: JSON would drop
      // `undefined` from the content.
      const result = outcome.value === undefined ? null : outcome.value;
      if (commitment.last && deepEqual(commitment.last.value, result)) {
        return;
      }
      commitment.last = { value: result };
      await this.sendStandingReply(commitment, "inform", {
        name: commitment.name,
        result,
      });
      return;
    }

    const holds = outcome.value === true;
    const rose = holds && commitment.last?.value !== true;
    commitment.last = { value: holds };
    if (rose) {
      commitment.pendingFire = true;
    }
    this.tryFire(commitment);
  }

  /**
   * Fires a conditional request that is due, if the goal queue has room. A
   * firing that finds it full stays due and is tried again each tick (see
   * {@link retryPendingFires}): the agent agreed to the work, so shedding it
   * with a `refuse` now would break that agreement.
   */
  private tryFire(commitment: StandingCommitment): void {
    if (!commitment.pendingFire || this.goals.atCapacity()) {
      return;
    }
    commitment.pendingFire = false;
    this.fireStanding(commitment, commitment.goalId ?? `goal-${randomUUID()}`);
    if (commitment.kind === "request-when") {
      // Fired once, it is an ordinary request now, answered when its goal
      // ends; there is nothing left to watch or to cancel.
      this.standing.delete(commitment.id);
    }
  }

  /** Retries every firing that was waiting for room in the goal queue. */
  private retryPendingFires(): void {
    for (const commitment of [...this.standing.values()]) {
      this.tryFire(commitment);
    }
  }

  /**
   * Creates the goal a conditional request asked for, sourced from the
   * directive exactly as a request's goal is, and opens the terminal answer it
   * is owed: the same `openRequests` entry an agreed request gets, so the reply
   * on completion or failure is the request protocol's.
   */
  private fireStanding(commitment: StandingCommitment, goalId: string): void {
    const msg = commitment.message;
    const source: GoalSource = {
      sender: commitment.sender,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
    };
    const content = isRecord(msg.content) ? msg.content : {};

    this.openRequests.set(goalId, {
      to: commitment.replyTo,
      goal: commitment.goal ?? "",
      goalId,
      ...(source.conversationId
        ? { conversationId: source.conversationId }
        : {}),
      ...(source.inReplyTo ? { inReplyTo: source.inReplyTo } : {}),
    });
    this.goals.add({
      id: goalId,
      name: commitment.goal ?? "",
      priority: directivePriority(msg.performative) ?? 5,
      status: "pending",
      data: content,
      dependsOn: Array.isArray(content.dependsOn)
        ? (content.dependsOn as string[])
        : undefined,
      source,
    });
  }

  /** Sends a reply a standing commitment owes, in the directive's exchange. */
  private async sendStandingReply(
    commitment: StandingCommitment,
    performative: "inform" | "failure",
    content: Record<string, unknown>,
  ): Promise<void> {
    const msg = commitment.message;
    try {
      await this.sendMessage(commitment.replyTo, {
        performative,
        sender: this.id,
        receiver: commitment.replyTo,
        content,
        ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
        ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${this.id}] Failed to report on ${commitment.kind} "${commitment.name}" to ${commitment.replyTo}:`,
        error,
      );
    }
  }

  /**
   * Withdraws a standing commitment at its sender's request.
   *
   * FIPA's `cancel(j, a)` is `disconfirm(j, I_i Done(a))`: the sender no longer
   * intends that this agent go on with it. The commitment is named by the
   * `cancel`'s `inReplyTo` (the directive's `replyWith`) or, when the cancel
   * names no message, by its conversation. Only the agent that asked may
   * cancel. The reply follows FIPA's cancel meta-protocol: `inform` once it is
   * withdrawn, `failure` when there is nothing of the sender's to withdraw.
   *
   * Cancelling an ordinary request already in progress, including a
   * `request-when` that has fired, is not supported and is refused
   * `unsupported`: it would mean tearing down a running intention.
   */
  private async handleCancel(msg: Message): Promise<void> {
    const sender = msg.sender;
    const to = replyAddress(msg);
    if (!sender || sender === this.id || !to || to === this.id) {
      return;
    }

    const byExchange =
      msg.inReplyTo !== undefined
        ? this.standing.get(msg.inReplyTo)
        : undefined;
    const commitment =
      byExchange && byExchange.sender === sender
        ? byExchange
        : msg.inReplyTo === undefined && msg.conversationId !== undefined
          ? [...this.standing.values()].find(
              (c) =>
                c.sender === sender &&
                c.message.conversationId === msg.conversationId,
            )
          : undefined;

    if (commitment) {
      this.standing.delete(commitment.id);
      await this.replyToCancel(msg, "inform", {
        cancelled: commitment.kind,
        ...(commitment.goal ? { goal: commitment.goal } : {}),
        name: commitment.name,
      });
      return;
    }

    // Matched on who asked for the goal, not where its replies go: only the
    // requester may cancel, even when it routed its replies elsewhere.
    const open = [...this.openRequests.values()].find(
      (o) =>
        o.inReplyTo !== undefined &&
        o.inReplyTo === msg.inReplyTo &&
        this.goals.get(o.goalId)?.source?.sender === sender,
    );
    if (open) {
      await this.cancelRequest(msg, open.goalId);
      return;
    }

    await this.replyToCancel(msg, "failure", { reason: "nothing to cancel" });
  }

  /**
   * Withdraws an agreed request at its requester's `cancel`, and answers the
   * canceller: `inform { cancelled: "request", goal }` once the work has
   * stopped, `failure` when it cannot be. The requester asked for the work to
   * end, so the request gets no `failure` of its own. See {@link withdraw} for
   * when work can be withdrawn.
   */
  private async cancelRequest(msg: Message, rootGoalId: string): Promise<void> {
    await this.withdraw(rootGoalId, msg.sender, async (outcome) => {
      if (outcome.withdrawn) {
        await this.replyToCancel(msg, "inform", {
          cancelled: "request",
          goal: outcome.goal.name,
          ...(outcome.cleanupFailures.length > 0
            ? { cleanupFailures: outcome.cleanupFailures }
            : {}),
        });
        return;
      }
      await this.replyToCancel(msg, "failure", {
        ...(outcome.goal ? { goal: outcome.goal.name } : {}),
        reason: outcome.reason,
      });
    });
  }

  /**
   * Withdraws a goal and everything under it — its sub-goals, and the
   * intentions working them — then calls `settle` with how it went. Two
   * things withdraw work: a requester's `cancel` of an agreed request, and
   * this agent itself, when it stops waiting for a sub-goal it delegated to
   * itself (the delegation timed out, or the intention waiting on it failed).
   * Both follow the same rules, which are the ones a remote delegate applies to
   * the `cancel` it is sent in the second case.
   *
   * Whether stopping is safe is the plan author's call, not the library's: an
   * action may have half-written a record or charged a card. So:
   *
   * - **Nothing started** — every goal in the tree is still pending — is
   *   always withdrawable: nothing has run that could need undoing.
   * - **Work started** is withdrawable only if every plan with a live
   *   intention in the tree is marked `cancellable: true`. Otherwise nothing
   *   is withdrawn, and the work carries on.
   * - **Never mid-action.** An action is never interrupted. If one of the
   *   tree's actions is running, the withdrawal waits for it and is carried
   *   out at the next action boundary; no further action starts meanwhile.
   *
   * Withdrawing runs each started plan's `onCancel` clean-up (deepest first),
   * cancels the remote delegations those intentions were waiting on, drops the
   * goals, and reports `goal:cancelled`.
   */
  private async withdraw(
    goalId: string,
    by: string,
    settle: (outcome: Withdrawal) => Promise<void>,
  ): Promise<void> {
    const top = this.goals.get(goalId);
    if (!top || isTerminalGoalStatus(top.status)) {
      await settle({ withdrawn: false, reason: "nothing to cancel" });
      return;
    }

    const tree = this.goals
      .getUnfinished()
      .filter((g) => this.isWithin(g, goalId));
    const started = tree.flatMap((g) =>
      this.intentions
        .getByGoal(g.id)
        .filter(
          (i) =>
            i.status === "pending" ||
            i.status === "executing" ||
            i.status === "waiting",
        ),
    );

    const stubborn = started.find((i) => i.plan.cancellable !== true);
    if (stubborn) {
      await settle({
        withdrawn: false,
        goal: top,
        reason: `not cancellable: plan "${stubborn.plan.name}" has started and is not marked cancellable`,
      });
      return;
    }

    if (started.some((i) => this.actionsInFlight.has(i.id))) {
      // Carried out at the next action boundary; nothing new starts until then.
      if (!this.queuedCancels.some((q) => q.goalId === goalId)) {
        this.queuedCancels.push({ goalId, by, settle });
      }
      return;
    }

    // A withdrawn request is answered by the cancel, so no terminal reply is
    // owed any more. Only a request's root has an entry; a sub-goal has none.
    this.openRequests.delete(goalId);

    // Clean-up runs deepest first, so a sub-goal undoes its part before the
    // plan that spawned it.
    const depth = (goal: Goal): number => {
      let d = 0;
      let parent = goal.parentGoalId;
      while (parent) {
        d++;
        parent = this.goals.get(parent)?.parentGoalId;
      }
      return d;
    };
    const ordered = [...started].sort((a, b) => depth(b.goal) - depth(a.goal));
    const cleanupFailures: Array<{ plan: string; reason: string }> = [];
    for (const intention of ordered) {
      const onCancel = intention.plan.onCancel;
      if (onCancel) {
        try {
          const result = await onCancel.execute(intention, this.beliefs);
          // A clean-up may write beliefs and send messages; it may not start
          // work in a request that is being withdrawn.
          await this.applyActionResult(
            { ...result, spawn: undefined, delegations: undefined },
            intention,
          );
          if (result.failure) {
            cleanupFailures.push({
              plan: intention.plan.name,
              reason: result.failure.reason,
            });
          }
        } catch (error) {
          cleanupFailures.push({
            plan: intention.plan.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.intentions.fail(intention.id, "cancelled");
      // Its own sub-goals are in the tree, and are dropped below.
      await this.abandonDelegations(intention, "cancelled", {
        remoteOnly: true,
      });
    }

    for (const goal of tree) {
      this.goalEndReasons.set(goal.id, "cancelled");
      this.goals.setStatus(goal.id, "dropped");
    }
    // Work that was waiting on this goal will not get it.
    this.dropDependentGoals(goalId);

    this.emitter.emit("goal:cancelled", {
      agentId: this.id,
      goal: top,
      by,
      cleanupFailures,
    } satisfies GoalCancellation);

    await settle({ withdrawn: true, goal: top, cleanupFailures });
  }

  /**
   * Whether a goal is `ancestorId` or lies under it. Walked through
   * `parentGoalId` while the ancestors are still held, with `rootGoalId` for a
   * request's root, whose descendants all name it.
   */
  private isWithin(goal: Goal, ancestorId: string): boolean {
    if (goal.id === ancestorId || goal.rootGoalId === ancestorId) return true;
    let parent = goal.parentGoalId;
    while (parent) {
      if (parent === ancestorId) return true;
      parent = this.goals.get(parent)?.parentGoalId;
    }
    return false;
  }

  /** Carries out every queued withdrawal whose tree has no action running. */
  private async processQueuedCancels(): Promise<void> {
    if (this.queuedCancels.length === 0) return;
    const queued = this.queuedCancels;
    this.queuedCancels = [];
    for (const { goalId, by, settle } of queued) {
      await this.withdraw(goalId, by, settle);
    }
  }

  /** Answers a `cancel` in its own exchange, at its `reply-to`. */
  private async replyToCancel(
    msg: Message,
    performative: "inform" | "failure",
    content: Record<string, unknown>,
  ): Promise<void> {
    const to = replyAddress(msg);
    try {
      await this.sendMessage(to, {
        performative,
        sender: this.id,
        receiver: to,
        content,
        ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
        ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(`[${this.id}] Failed to answer a cancel to ${to}:`, error);
    }
  }

  /**
   * Handles a directive this agent cannot act on: {@link isUnsupportedDirective}
   * compels the hearer, but is not one of the performatives whose receiver takes
   * on work, so there is nothing to schedule and nothing to agree to.
   *
   * Declines with `reason: "unsupported"` by default. FIPA grants the hearer of
   * a directive the right to refuse, and refusing is the honest answer here: the
   * performative is not one this library knows how to represent, so admitting the
   * goal would mean quietly doing something the sender did not ask for.
   *
   * The refusal is about the work, not the sender — a {@link DirectiveMiddleware}
   * chain that would have declined the message anyway does not get to change the
   * reason, and does not get to be consulted first.
   *
   * Async because a subclass that hands the performative to ordinary admission
   * calls {@link considerDirective}, which is itself a chain, and that has to be
   * awaited before the tick considers the message done.
   *
   * Split out from {@link considerDirective} so a subclass that *can* honour the
   * performative overrides only this and inherits the rest of admission: the
   * plan check, the queue bound and the `agree`. An override that
   * decides the work is wanted calls {@link considerDirective} once, which runs
   * the ordinary path for it. The assertion half is ingested upstream either
   * way, so admitting the work does not also cost the sender its belief update.
   */
  protected handleUnsupportedDirective(msg: Message): Promise<void> {
    this.declineDirective(msg, "unsupported", {
      reason: `this agent does not implement "${msg.performative}"`,
    });
    return Promise.resolve();
  }

  /**
   * Declines a directive this agent will not act on, with a reason of its own.
   *
   * Reports it locally on `goal:refused` and queues the `refuse` the sender
   * will receive, so the refusal is visible to a monitor watching the agent's
   * own event stream as well as to the sender. Protected rather than private so
   * an override of {@link handleUnsupportedDirective} can answer in the same
   * shape as everything else — one event, one wire message, the same
   * `RefusalVerdict` vocabulary — instead of sending a bare `refuse`.
   *
   * `send: false` reports without answering, for a decline another path has
   * already taken responsibility for answering.
   */
  protected declineDirective(
    msg: Message,
    verdict: RefusalVerdict,
    options: { reason?: string; send?: boolean } = {},
  ): void {
    if (!isRecord(msg.content)) {
      return;
    }

    // A query or a subscription creates no goal, so its refusal names the
    // proposition or expression that was asked for instead. A `goal` of ""
    // would tell the sender a refusal arrived, but not what it declined.
    const query =
      (isQueryDirective(msg.performative) ||
        msg.performative === "subscribe") &&
      typeof msg.content.name === "string"
        ? msg.content.name
        : undefined;
    const goalName =
      query === undefined ? ((msg.content.goal as string) ?? "") : "";
    const refusal: GoalRefusal = {
      agentId: this.id,
      goal: goalName,
      ...(query !== undefined ? { query } : {}),
      verdict,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
    };

    this.emitter.emit("goal:refused", refusal);

    // Answering ourselves would be noise: a subscribed agent receives its own
    // publishes, and it was never going to wait on its own agreement.
    const to = replyAddress(msg);
    if (
      options.send === false ||
      !msg.sender ||
      msg.sender === this.id ||
      !to ||
      to === this.id
    ) {
      return;
    }

    this.pendingRefusals.push({
      to,
      goal: goalName,
      ...(query !== undefined ? { query } : {}),
      verdict,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
    });
  }

  /**
   * Runs an assertion's content into the belief base, through the configured
   * middleware that cancelled or threw before it.
   *
   * The chain is built per message: the terminal step performs the write, and
   * each middleware either calls `next` or cancels by returning. Both the chain
   * and the write are async, since a middleware is allowed to do I/O.
   *
   * Trust is the default and lives here: an agent with no middleware believes
   * what it is told. Everything that makes that interruptible is above the write,
   * not inside it, so a user withdrawing the assumption never has to reimplement
   * the storing.
   *
   * `store` replaces the default write — one belief per content key under the
   * act's own stance — for an assertion the agent files somewhere specific,
   * such as the answer to a query it asked. The chain in front of it is the
   * same, so trust gates an answer exactly as it gates any other claim.
   */
  /**
   * Runs an assertion through the belief middleware and, if the chain lets it
   * through, stores it. Resolves to whether it was stored — believed.
   */
  private async ingestAssertion(
    msg: Message,
    store?: () => { keys: string[]; status: BeliefStatus },
  ): Promise<boolean> {
    // Captured rather than re-read inside the chain: the narrowing from
    // `isRecord` would not survive a property access inside a closure. A
    // custom `store` files the whole content itself, so it does not need a
    // record to iterate.
    const content = isRecord(msg.content) ? msg.content : undefined;
    if (!content && !store) {
      return false;
    }
    const middleware = this.config.middleware;
    const index = { at: 0 };

    // At most one outcome per message, decided by the first thing that speaks
    // to it: the middleware that cancelled or threw before the write. Collected
    // and reported once below, so a single message can never produce two
    // notices.
    let outcome: { reason: BeliefRejectionReason } | undefined;
    let reachedWrite = false;
    let stored: string[] | undefined;
    let statusOf: BeliefStatus = "positive";

    // Terminal step: the write the chain exists to be able to interrupt.
    const write = async (): Promise<void> => {
      reachedWrite = true;

      if (store) {
        const written = store();
        stored = written.keys;
        statusOf = written.status;
        return;
      }

      // SC00037 gives disconfirm the rational effect Bj ¬φ — the receiver comes
      // to hold the *negation*, not merely to stop holding φ. The store keeps a
      // stance beside each value, so that is a write held "negatively": the key
      // is still there, still named the same content, and the sender's stance
      // toward it was the opposite. Reading that stance as *not p* needs an
      // ontology, so the reading stays with the user and classic-agents records
      // only the stance. Every other propositional act asserts its content, so
      // it is held "positively".
      //
      // The stance is the receiver's, derived from the act and never read off
      // the wire. FIPA has no uncertain `inform` — its sender must believe what
      // it says — so a message asserts or denies, and `"uncertain"` is only
      // ever something an agent holds about its own open questions. A `state`
      // key in the content is ordinary content like any other.
      statusOf =
        msg.performative === "disconfirm"
          ? ("negative" as const)
          : ("positive" as const);

      const beliefKey = this.config.beliefKey;
      // Reached only with a record: without one, `store` was required above.
      const fields = content ?? {};
      stored = Object.keys(fields).map((key) => beliefKey(msg, key));
      for (const [key, value] of Object.entries(fields)) {
        this.beliefs.set(beliefKey(msg, key), value, statusOf);
      }
    };

    const step = async (): Promise<void> => {
      if (index.at >= middleware.length) {
        await write();
        return;
      }
      const current = middleware[index.at++];
      try {
        await current(msg, step);
      } catch (error) {
        // A chain that threw has not established that the rest of it should be
        // trusted, so the write does not happen and the rest is not run. Caught
        // rather than rethrown: one bad middleware should not end the tick.
        outcome = {
          reason: `middleware threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };

    await step();

    // Reaching the write with nothing to say means the belief was stored — that
    // is the accepting case, reported as its own event. Reaching it without
    // either means the chain ended short: some middleware returned without calling
    // `next`, the documented way to cancel.
    if (outcome === undefined && !reachedWrite) {
      outcome = { reason: "middleware" };
    }
    if (outcome) {
      this.emitter.emit("belief:rejected", {
        agentId: this.id,
        reason: outcome.reason,
        message: msg,
      });
    } else if (stored) {
      this.emitter.emit("belief:accepted", {
        agentId: this.id,
        keys: stored,
        status: statusOf,
        message: msg,
      });
    }
    return outcome === undefined && reachedWrite;
  }

  /**
   * An `agree` arrived for a directive this agent sent: the receiver has the
   * goal and will work on it.
   *
   * Reports the id the receiver actually assigned rather than the one requested,
   * so a sender whose pin lost a race can follow the right goal instead of
   * tracking one it cannot name.
   */
  private handleAgreement(msg: Message): void {
    if (!isRecord(msg.content)) {
      return;
    }

    // An agree that names nothing it commits to — no goal id, condition or
    // expression — cannot be correlated with any directive, so it is not
    // understood rather than silently dropped. The sender gets a
    // not-understood so it knows the reply was heard but malformed.
    if (
      !validateContent(msg.performative, msg.content) &&
      msg.sender &&
      msg.sender !== this.id
    ) {
      const reason = schemaViolationReason(msg.performative, msg.content);
      this.sendNotUnderstood(msg, reason);
      return;
    }

    const goalId =
      typeof msg.content.goalId === "string" ? msg.content.goalId : "";
    const when =
      typeof msg.content.when === "string" ? msg.content.when : undefined;
    const name =
      typeof msg.content.name === "string" ? msg.content.name : undefined;
    if (!goalId && when === undefined && name === undefined) {
      return;
    }

    this.emitter.emit("goalAcknowledged", {
      agentId: msg.sender,
      goal: typeof msg.content.goal === "string" ? msg.content.goal : "",
      goalId,
      ...(when !== undefined ? { when } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
    } satisfies GoalAck);

    // A delegation the peer agreed to is now its work, under the id it chose.
    const delegated =
      msg.inReplyTo !== undefined
        ? this.remoteDelegations.get(msg.inReplyTo)
        : undefined;
    if (
      delegated &&
      delegated.delegation.receiver === msg.sender &&
      delegated.delegation.status === "sent"
    ) {
      delegated.delegation.status = "agreed";
      if (goalId) delegated.delegation.goalId = goalId;
    }

    // Close the request cycle: update the intention belief from uncertain to
    // positive. The sender created an `uncertain` belief when it sent the
    // request; an agree confirms that the receiver will work on it.
    const goal = typeof msg.content.goal === "string" ? msg.content.goal : "";
    if (goal && msg.sender) {
      this.beliefs.setStatus(
        this.exchangeKey(
          "intent",
          msg.sender,
          goal,
          msg.inReplyTo ?? msg.conversationId,
        ),
        "positive",
      );
    }
  }

  /**
   * A `refuse` arrived for a directive this agent sent: nobody will work on it
   * *yet*, and for three of the four verdicts never will.
   *
   * This is what turns a declined request from silence into an answer. Without
   * it a sender waits on a reply that is never coming, and has no way to tell
   * "declined" from "still deciding".
   *
   * The verdict is what makes the answer actionable. FIPA's `refuse` is a
   * permanent claim — it disconfirms that the action is feasible and informs
   * that the agent has no intention to perform it — so read literally it says
   * the work will never happen. That is true of `"no-plan"` and `"unsupported"`
   * and false of `"capacity"`, which is backpressure: the same offer may be
   * agreed to later. All four verdicts are kept on receipt, in the event and in
   * the `infeasible.*` record, so a plan can tell the transient from the
   * settled; see {@link RefusalVerdict}.
   *
   * Note the asymmetry with `goal:refused`, which is the same fact seen from
   * the receiving side: this one means *this* agent's request was declined.
   */
  private async handleRefusalMessage(msg: Message): Promise<void> {
    if (!isRecord(msg.content)) {
      return;
    }

    // A refuse that names neither a goal nor a query cannot tell the sender
    // which directive was declined, so it is not understood rather than
    // silently dropped. The sender gets a not-understood so it knows the reply
    // was heard but malformed.
    if (
      !validateContent(msg.performative, msg.content) &&
      msg.sender &&
      msg.sender !== this.id
    ) {
      const reason = schemaViolationReason(msg.performative, msg.content);
      this.sendNotUnderstood(msg, reason);
      return;
    }

    const goal = typeof msg.content.goal === "string" ? msg.content.goal : "";
    // A refused query names the proposition or expression it declines rather
    // than a goal, and creates no intention belief to close.
    const query =
      typeof msg.content.name === "string" ? msg.content.name : undefined;
    const rawVerdict = msg.content.verdict;

    // A refusal from a peer that does not use this library's vocabulary is
    // still a refusal, and is still reported. Only a verdict actually given,
    // and one of the vocabulary's, is believed: attributing one to a sender
    // that never said so, or reading a word we do not define, would put a word
    // in its mouth. Every verdict in the vocabulary is kept — the permanent
    // ones (`no-plan`, `unsupported`) most of all, since they are what tells a
    // plan "never ask this peer for this" apart from "not right now".
    const verdict: RefusalVerdict | undefined = isRefusalVerdict(rawVerdict)
      ? rawVerdict
      : undefined;

    this.emitter.emit("goalRefused", {
      agentId: msg.sender,
      goal,
      ...(query !== undefined ? { query } : {}),
      ...(verdict ? { verdict } : {}),
      ...(typeof msg.content.reason === "string"
        ? { reason: msg.content.reason }
        : {}),
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
    } satisfies GoalRefusal);

    // Close the request cycle: update the intention belief to negative and
    // record that this exchange's request is not feasible for that agent. The
    // sender created an `uncertain` belief when it sent the request; a refuse
    // overrides both. Scoping the record to the exchange keeps the claim honest:
    // a capacity refusal of one offer never asserts the peer could not take a
    // later one.
    const reason =
      typeof msg.content.reason === "string" ? msg.content.reason : undefined;
    if (goal && msg.sender) {
      const exchange = msg.inReplyTo ?? msg.conversationId;
      this.beliefs.setStatus(
        this.exchangeKey("intent", msg.sender, goal, exchange),
        "negative",
      );
      this.beliefs.set(
        this.exchangeKey("infeasible", msg.sender, goal, exchange),
        { verdict, reason },
        "negative",
      );
    }

    // A refused request is over; nothing more will answer it.
    const sent = this.sentRequestFor(msg);
    if (sent) {
      await this.endSentRequest(sent.exchange, {
        failed: `refused${verdict ? ` (${verdict})` : ""}${reason ? `: ${reason}` : ""}`,
      });
    }
  }

  /** The cancel this reply answers, if any, from the agent it was sent to. */
  private pendingCancelFor(msg: Message): PendingCancel | undefined {
    if (!msg.inReplyTo) return undefined;
    const pending = this.pendingCancels.get(msg.inReplyTo);
    return pending && pending.peer === msg.sender ? pending : undefined;
  }

  /**
   * Settles a cancel this agent sent, from the peer's reply.
   *
   * - **`inform`** — it took. The request or subscription is over: its
   *   tracking ends, `intent.*` is removed (the requester ended it; nobody
   *   refused or failed), and `cancelled.<peer>.<name>.<exchange>` records it.
   *   A subscription keeps its last value, which no update replaces any more.
   *   Read through the trust chain, as any `inform`.
   * - **Anything else** (`failure`, a `refuse` from an older peer,
   *   `not-understood`) — it did not take. The request carries on and is
   *   still tracked, so its own `done`/`failure` still lands;
   *   `cancel-failed.<peer>.<name>.<exchange>` records why.
   */
  private async settleCancelReply(
    msg: Message,
    pending: PendingCancel,
  ): Promise<void> {
    this.pendingCancels.delete(msg.inReplyTo!);
    const content = isRecord(msg.content) ? msg.content : {};
    const reason =
      typeof content.reason === "string" ? content.reason : undefined;

    if (msg.performative !== "inform") {
      this.beliefs.set(
        this.exchangeKey(
          "cancel-failed",
          pending.peer,
          pending.name,
          pending.target,
        ),
        { performative: msg.performative, ...(reason ? { reason } : {}) },
        "positive",
      );
      return;
    }

    // The cancel took whether or not its `inform` is believed: the peer has
    // stopped and will say nothing more about the request.
    if (pending.kind === "request") {
      await this.endSentRequest(pending.target, { failed: "cancelled" });
    }
    await this.ingestAssertion(msg, () => {
      const key = this.exchangeKey(
        "cancelled",
        pending.peer,
        pending.name,
        pending.target,
      );
      this.beliefs.set(key, content, "positive");
      if (pending.kind === "request") {
        this.beliefs.remove(
          this.exchangeKey(
            "intent",
            pending.peer,
            pending.name,
            pending.target,
          ),
        );
      } else {
        this.pendingQueries.delete(pending.target);
      }
      this.awaitingReply.delete(pending.target);
      return { keys: [key], status: "positive" };
    });
  }

  /**
   * The request this reply answers, if any: it names one of this agent's open
   * requests as `inReplyTo` and comes from the agent that was asked.
   */
  private sentRequestFor(msg: Message): SentRequest | undefined {
    if (!msg.inReplyTo) return undefined;
    const sent = this.sentRequests.get(msg.inReplyTo);
    return sent && sent.peer === msg.sender ? sent : undefined;
  }

  /**
   * Files an `inform` that answers a request this agent sent, through the
   * trust chain like any assertion.
   *
   * - `done: true` is the request's terminal reply (see
   *   {@link recordPlanAnswer}): `done.<peer>.<goal>.<exchange>` records its
   *   content, held positive, and `intent.<peer>.<goal>.<exchange>` is
   *   removed. The intention was discharged, not denied, so it is not set
   *   negative: negative stays for "the peer won't" (`refuse`, `failure`).
   *   The request is over. A `request-whenever` is the exception: each firing
   *   completes on its own and the standing intention remains until cancelled.
   * - Anything else is a note on the request (progress, a partial result):
   *   `result.<peer>.<goal>.<exchange>` holds the latest one, and the request
   *   stays open.
   */
  private async settleRequestInform(
    msg: Message,
    sent: SentRequest,
  ): Promise<void> {
    const content = msg.content;
    const standing = sent.performative === "request-whenever";
    if (!isDone(content)) {
      await this.ingestAssertion(msg, () => {
        const key = this.exchangeKey(
          "result",
          sent.peer,
          sent.goal,
          sent.exchange,
        );
        this.beliefs.set(key, content, "positive");
        return { keys: [key], status: "positive" };
      });
      return;
    }

    const believed = await this.ingestAssertion(msg, () => {
      const key = this.exchangeKey("done", sent.peer, sent.goal, sent.exchange);
      this.beliefs.set(key, content, "positive");
      if (!standing) {
        this.beliefs.remove(
          this.exchangeKey("intent", sent.peer, sent.goal, sent.exchange),
        );
      }
      return { keys: [key], status: "positive" };
    });
    // The request is over whether or not the middleware believed the peer:
    // it has sent its terminal reply and will send no other. What the
    // middleware decides is only whether this agent takes the work as done —
    // a delegation whose result it will not believe has failed.
    if (!standing) {
      await this.endSentRequest(
        sent.exchange,
        believed
          ? { done: isRecord(content) ? content.result : undefined }
          : { failed: "result not accepted by belief middleware" },
      );
    }
  }

  private async handleFailureMessage(msg: Message): Promise<void> {
    if (!isRecord(msg.content)) {
      return;
    }

    const goal = typeof msg.content.goal === "string" ? msg.content.goal : "";
    const sender = msg.sender;
    if (!goal || !sender) {
      // A failure that names no goal answers nothing this agent can file it
      // under, so it is an ordinary claim on the ordinary path.
      await this.ingestAssertion(msg);
      return;
    }

    // FIPA's `failure` informs that the action was attempted, was not done,
    // and is no longer intended: `¬Done(a) ∧ ¬I_i Done(a)`. So it closes the
    // exchange its request opened. The peer's intention is held negative —
    // a fact the failure states, as a `refuse` does — and the failure itself
    // is recorded per exchange, so a second failure for the same goal never
    // rewrites the first. Filed through the trust chain like any assertion,
    // but under the exchange rather than as loose `msg.*` beliefs detached
    // from the request.
    const exchange = msg.inReplyTo ?? msg.conversationId;
    const reason =
      typeof msg.content.reason === "string" ? msg.content.reason : undefined;
    // A `request-whenever` fails per firing; the standing intention behind it
    // goes on until cancelled, so only its record is written.
    const sent = this.sentRequestFor(msg);
    const standing = sent?.performative === "request-whenever";
    await this.ingestAssertion(msg, () => {
      const failedKey = this.exchangeKey("failed", sender, goal, exchange);
      this.beliefs.set(failedKey, { reason }, "positive");
      const keys = [failedKey];
      if (!standing) {
        const intentKey = this.exchangeKey("intent", sender, goal, exchange);
        if (this.beliefs.setStatus(intentKey, "negative")) {
          keys.push(intentKey);
        }
      }
      return { keys, status: "positive" };
    });
    // Closed whether or not the failure is believed: the peer has given up
    // either way, and will send nothing more for this request.
    if (sent && !standing) {
      await this.endSentRequest(sent.exchange, { failed: reason ?? "failed" });
    }
  }

  private async handleNotUnderstoodMessage(msg: Message): Promise<void> {
    // A request the peer could not read will not be answered either.
    const sent = this.sentRequestFor(msg);
    if (sent) {
      const reason =
        isRecord(msg.content) && typeof msg.content.reason === "string"
          ? msg.content.reason
          : undefined;
      await this.endSentRequest(sent.exchange, {
        failed: `not understood${reason ? `: ${reason}` : ""}`,
      });
    }

    if (!isRecord(msg.content)) {
      return;
    }

    // Same shape as `failure`: an inform about a perceived problem, so it goes
    // through the standard assertion path and also stores a semantic record.
    await this.ingestAssertion(msg);

    const event =
      typeof msg.content.event === "string" ? msg.content.event : "";
    if (event && msg.sender) {
      this.beliefs.set(
        `not-understood.${msg.sender}.${event}`,
        {
          reason:
            typeof msg.content.reason === "string"
              ? msg.content.reason
              : undefined,
        },
        "positive",
      );
    }
  }

  /**
   * Turns a directive that carries a goal name — today only `request` — into a
   * goal, recording where it came from so the sender can follow it through
   * decomposition and failure notices.
   *
   * A caller may pin the id with `content.goalId`; it is honoured only while
   * free, since a taken id would otherwise silently overwrite an existing goal.
   * Either way the sender is told which id was assigned via an `agree`, so it
   * never has to guess.
   */
  private goalFromMessage(
    msg: Message,
    priority: number,
  ): DirectiveOutcome | undefined {
    if (!isRecord(msg.content)) {
      return undefined;
    }

    const content = msg.content;
    const goalName = content.goal as string;
    if (!goalName) {
      return undefined;
    }

    const requestedId =
      typeof content.goalId === "string" && content.goalId.trim()
        ? content.goalId
        : undefined;

    const goalId =
      requestedId && !this.goals.get(requestedId)
        ? requestedId
        : `goal-${randomUUID()}`;

    const source: GoalSource = {
      sender: msg.sender,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
    };

    this.goals.add({
      id: goalId,
      name: goalName,
      priority,
      status: "pending",
      data: content,
      dependsOn: Array.isArray(content.dependsOn)
        ? (content.dependsOn as string[])
        : undefined,
      source,
    });

    // The queue fails a goal it has no room for, having first admitted it so
    // the refusal is a lifecycle the event stream can describe. Read that back
    // rather than predicting it: the bound is checked inside the queue.
    const admitted = this.goals.get(goalId)?.status !== "failed";

    // Agreed here, on admission, because by this point every question that can
    // be answered "no" has been: the middleware chain admitted it, the plan
    // library said it is able, and the queue said there is room. A plain
    // request carries no condition to defer on — the work starts on the next
    // cycle — so taking it on is the whole of the commitment.
    //
    // Answering ourselves would just be noise: an agent subscribed to a
    // topic receives its own publishes.
    const to = replyAddress(msg);
    if (
      admitted &&
      msg.sender &&
      msg.sender !== this.id &&
      to &&
      to !== this.id
    ) {
      const agreement: PendingAgreement = {
        to,
        goal: goalName,
        goalId,
        ...(source.conversationId
          ? { conversationId: source.conversationId }
          : {}),
        ...(source.inReplyTo ? { inReplyTo: source.inReplyTo } : {}),
      };
      this.pendingAcks.push(agreement);
      // Opened with the `agree`, because agreeing is what makes a terminal
      // answer owed: from here until the goal settles, this exchange is
      // waiting for exactly one `inform` or `failure`.
      this.openRequests.set(goalId, { ...agreement, goalId });
    }

    return { goalId, admitted };
  }

  /**
   * Sends the answers to directives decided since the last cycle: an `agree` for
   * each goal taken on, a `refuse` for each declined.
   *
   * Deliveries happen here rather than in the message handler, which the bus
   * calls synchronously, so a failed send stays a catchable error instead of an
   * unhandled rejection — and so the reply to a directive leaves from a tick of
   * its own, never from inside the sender's `publish`.
   *
   * FIPA defines both acts as compositions — `agree` as an inform, `refuse` as a
   * disconfirm followed by an inform — and neither is emitted as its parts. The
   * decomposition *defines* the act; it is not a demand that the encoding spell
   * it out, and one act stays one message so that one request keeps one reply to
   * correlate against. The cost is that a peer wanting `¬I Done(a)` as a
   * proposition in its own belief base must build it from the refusal rather
   * than read it off the wire.
   *
   * A plain request's `agree` carries no condition, because it has none: the
   * work begins on the next cycle. A condition belongs to `request-when` and
   * `request-whenever`, where the *sender* names it, and their `agree` carries
   * it back as `when` — FIPA's φ in `agree(⟨i, act⟩, φ)`.
   */
  private async flushDirectiveAnswers(): Promise<void> {
    const agreements = this.pendingAcks;
    const refusals = this.pendingRefusals;
    this.pendingAcks = [];
    this.pendingRefusals = [];

    for (const ack of agreements) {
      try {
        await this.sendMessage(ack.to, {
          performative: "agree",
          sender: this.id,
          receiver: ack.to,
          // Names what was committed to: the goal id for a request, FIPA's φ
          // as `when` for a conditional one, the expression for a subscription.
          content: {
            ...(ack.goal ? { goal: ack.goal } : {}),
            ...(ack.goalId !== undefined ? { goalId: ack.goalId } : {}),
            ...(ack.when !== undefined ? { when: ack.when } : {}),
            ...(ack.name !== undefined ? { name: ack.name } : {}),
          },
          ...(ack.conversationId ? { conversationId: ack.conversationId } : {}),
          ...(ack.inReplyTo ? { inReplyTo: ack.inReplyTo } : {}),
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error(
          `[${this.id}] Failed to agree to ${ack.goalId ?? ack.name ?? ack.goal} with ${ack.to}:`,
          error,
        );
      }
    }

    for (const refusal of refusals) {
      try {
        await this.sendMessage(refusal.to, {
          performative: "refuse",
          sender: this.id,
          receiver: refusal.to,
          // A refused query names the question it declines; a refused request
          // names its goal. Either way the content says what was refused.
          content: {
            ...(refusal.query !== undefined
              ? { name: refusal.query }
              : { goal: refusal.goal }),
            verdict: refusal.verdict,
            ...(refusal.reason ? { reason: refusal.reason } : {}),
          },
          ...(refusal.conversationId
            ? { conversationId: refusal.conversationId }
            : {}),
          ...(refusal.inReplyTo ? { inReplyTo: refusal.inReplyTo } : {}),
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error(
          `[${this.id}] Failed to refuse ${refusal.query !== undefined ? `query ${refusal.query}` : `goal ${refusal.goal}`} for ${refusal.to}:`,
          error,
        );
      }
    }
  }

  /**
   * Queues the terminal answer FIPA's request protocol owes the requester of a
   * goal this agent agreed to: `inform` when it was achieved, `failure` when it
   * failed or was dropped.
   *
   * Called from the goal's own terminal transition, which is the one place all
   * the ways a goal can end pass through. Three rules keep one request to one
   * reply:
   *
   * - **Only root goals answer.** A sub-goal inherits `source` so it can be
   *   traced, but its requester is whoever asked for its parent, and a chain of
   *   decomposed work would otherwise put a reply on the wire per level.
   * - **Only agreed goals answer.** The entry in `openRequests` is written when
   *   the `agree` is, so a goal shed at admission or declined before a goal
   *   existed — which answered with `refuse` — is not answered again.
   * - **Only once.** The entry is consumed here, and a plan that sends its own
   *   `failure` consumes it before the goal settles. A plan's own `inform`
   *   only stands in for the automatic one when the goal is achieved: if the
   *   goal fails after the plan informed the requester of something, the
   *   `failure` still goes out, because that `inform` was not the outcome.
   *
   * The reply is queued rather than sent: it leaves from the tick, never from
   * inside an action or the bus's delivery callback.
   */
  private queueOutcome(goal: Goal): void {
    const reason = this.goalEndReasons.get(goal.id);
    this.goalEndReasons.delete(goal.id);

    if (goal.parentGoalId) {
      return;
    }

    const open = this.openRequests.get(goal.id);
    if (!open) {
      return;
    }
    this.openRequests.delete(goal.id);

    const achieved = goal.status === "achieved";
    if (achieved && open.informed) {
      return;
    }
    const result = achieved ? this.goalResults.get(goal.id) : undefined;
    this.pendingOutcomes.push({
      ...open,
      performative: achieved ? "inform" : "failure",
      ...(result !== undefined ? { result } : {}),
      ...(achieved
        ? {}
        : {
            reason:
              reason ??
              (goal.status === "dropped" ? "goal dropped" : "goal failed"),
          }),
    });
  }

  /**
   * Sends the terminal answers decided since the last flush: an `inform` for
   * each goal this agent achieved on a requester's behalf, a `failure` for each
   * it failed or dropped.
   *
   * Same reasoning as {@link flushDirectiveAnswers} for why this happens on a
   * tick of its own — a reply to a directive must not leave from inside the
   * sender's `publish`, and a failed send must stay a catchable error. Called
   * after `reportRejections`, which can fail the parents waiting on a refused
   * sub-goal and so produce more of these.
   *
   * Correlation comes from the request itself: the conversation the goal's
   * `source` recorded, and `inReplyTo` naming the request's own `replyWith`.
   * Both `agree` and the answer that closes it therefore pair against the same
   * message, which is what lets a sender tell two concurrent requests for the
   * same goal apart.
   */
  private async flushTerminalAnswers(): Promise<void> {
    const outcomes = this.pendingOutcomes;
    this.pendingOutcomes = [];

    for (const outcome of outcomes) {
      try {
        await this.sendMessage(outcome.to, {
          performative: outcome.performative,
          sender: this.id,
          receiver: outcome.to,
          // The `failure` carries FIPA's φ as the reason; the `inform` names
          // the goal the same way the `agree` did, plus the `done` marker that
          // says the action went through rather than merely being agreed to.
          content:
            outcome.performative === "inform"
              ? {
                  goal: outcome.goal,
                  goalId: outcome.goalId,
                  done: true,
                  ...(outcome.result !== undefined
                    ? { result: outcome.result }
                    : {}),
                }
              : { goal: outcome.goal, reason: outcome.reason },
          ...(outcome.conversationId
            ? { conversationId: outcome.conversationId }
            : {}),
          ...(outcome.inReplyTo ? { inReplyTo: outcome.inReplyTo } : {}),
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error(
          `[${this.id}] Failed to report the outcome of ${outcome.goal} to ${outcome.to}:`,
          error,
        );
      }
    }
  }

  /**
   * Drops everything that finished this cycle. Nothing is ever evicted: a goal
   * or intention leaves only once it has reached a terminal status, so the queue
   * and the stack stay bounded by the work in flight rather than by the number
   * of jobs the agent has ever run.
   */
  private collectFinished(): void {
    this.goals.flush();
    this.intentions.flush();
  }

  /**
   * Promotes the highest-priority eligible pending goal to active.
   *
   * Only this. Work starts because a goal says it should: a plan that ran with
   * no goal behind it could not say what it was for, could not be correlated
   * with the request that occasioned it, and could not be declined.
   */
  private deliberate(): void {
    const nextGoal = this.goals.selectNext();
    if (nextGoal) {
      this.goals.setStatus(nextGoal.id, "active");
    }
  }

  private async meansEndsReasoning(): Promise<void> {
    const activeGoals = this.goals.getByStatus("active");
    const activeIntentions = this.intentions.getActive();

    if (activeGoals.length === 0) {
      return;
    }

    if (activeIntentions.length >= this.config.maxConcurrentIntentions) {
      return;
    }

    const activeGoalIds = new Set(activeIntentions.map((i) => i.goal.id));
    // Only goals that actually declare dependencies need the achieved set, so an
    // agent whose goals have no `dependsOn` never pays for building it. Read
    // from the queue's record rather than its status index: an achieved
    // dependency is collected at the end of the cycle that finished it, so by
    // the time this runs it is no longer in `getByStatus("achieved")`.
    const needsAchieved = activeGoals.some((g) => g.dependsOn?.length);
    const achievedGoalIds = needsAchieved
      ? this.goals.achievedIds()
      : undefined;

    for (const goal of activeGoals) {
      if (activeGoalIds.has(goal.id)) {
        continue;
      }

      if (
        goal.dependsOn &&
        !goal.dependsOn.every((depId) => achievedGoalIds!.has(depId))
      ) {
        continue;
      }

      // A goal that reached the queue without passing through directive
      // admission: a sub-goal an action spawned, or one added directly. The
      // same no-plan answer applies, and it has to be given here as well or
      // these goals would be the ones that leak. A directive-admitted goal
      // never reaches this: admission already refused it if nothing served it.
      const plan = this.planLibrary.match(goal);

      if (!plan) {
        this.declineGoal(goal, "no-plan", `no plan serves "${goal.name}"`);
        continue;
      }

      const intention = createIntention(goal, plan);
      intention.status = "executing";
      this.intentions.push(intention);
      this.emitter.emit("intention:started", intention);
    }
  }

  /**
   * Declines a goal that is already in the queue: reports the refusal, fails
   * the goal so its slot is released, and fails any parent that was waiting on
   * it.
   *
   * Reached only for goals that never passed through directive admission: a
   * sub-goal an action spawned, or one added directly, for which no plan
   * declares an ability. The requester is answered when the goal is a root
   * one, directive or not: there is a live exchange to close.
   *
   * A sub-goal is never answered on the wire. It carries its parent's
   * `source`, so its "requester" is whoever asked for the parent and has
   * already been agreed to for the goal it did name — and after `agree` the
   * only negative ending FIPA allows is `failure` (SC00026). The refusal is
   * still reported on `goal:refused`, and {@link failWaitingParents} below
   * carries it up to the root goal, which is what answers the requester.
   *
   * A goal that *did* come from a directive is never declined here. It was
   * either agreed to at admission or refused there, so there is no question
   * left to answer once it is in the queue.
   */
  private declineGoal(
    goal: Goal,
    verdict: RefusalVerdict,
    reason?: string,
  ): void {
    const refusal: GoalRefusal = {
      agentId: this.id,
      goal: goal.name,
      verdict,
      ...(reason ? { reason } : {}),
      ...(goal.source?.conversationId
        ? { conversationId: goal.source.conversationId }
        : {}),
      ...(goal.source?.inReplyTo ? { inReplyTo: goal.source.inReplyTo } : {}),
    };
    this.emitter.emit("goal:refused", refusal);

    const to = goal.source ? replyAddress(goal.source) : "";
    if (
      !goal.parentGoalId &&
      goal.source &&
      goal.source.sender !== this.id &&
      to &&
      to !== this.id
    ) {
      this.pendingRefusals.push({
        to,
        goal: goal.name,
        verdict,
        ...(reason ? { reason } : {}),
        ...(goal.source.conversationId
          ? { conversationId: goal.source.conversationId }
          : {}),
        ...(goal.source.inReplyTo ? { inReplyTo: goal.source.inReplyTo } : {}),
      });
      // A refusal is itself a terminal answer, so it closes whatever the agent
      // may still owe for this goal. Unreachable for a goal that came through
      // directive admission — those are agreed to or refused there — but the
      // terminal transition below cannot tell the difference, and one request
      // must never get two replies.
      this.openRequests.delete(goal.id);
    }

    // Terminal, so `collectFinished` releases the slot this cycle. Leaving it
    // active would let an unservable goal hold capacity indefinitely. The
    // reason is recorded first so a requester that was agreed to — which this
    // path cannot reach, but the terminal transition does not know that — would
    // be told why rather than left with a bare `failure`.
    this.goalEndReasons.set(goal.id, reason ?? verdict);
    this.goals.setStatus(goal.id, "failed");

    if (goal.parentGoalId) {
      void this.failWaitingParents(goal, reason ?? verdict);
    }
  }

  private async execute(): Promise<void> {
    // Only the intentions with an action to run: a waiting one is blocked on
    // its sub-goals, and a finished one has nothing left to advance.
    const active = this.intentions.getRunnable();

    const results = await Promise.allSettled(
      active.map((intention) => this.executeIntention(intention)),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`[${this.id}] Intention execution error:`, result.reason);
      }
    }
  }

  private async executeIntention(intention: Intention): Promise<void> {
    // Work being withdrawn starts no further action.
    if (
      this.queuedCancels.some((q) => this.isWithin(intention.goal, q.goalId))
    ) {
      return;
    }

    const action = intention.plan.body[intention.actionIndex];
    if (!action) {
      this.completeIntention(intention, intention.result ?? {});
      return;
    }

    let result: ActionResult | undefined;
    try {
      this.actionsInFlight.add(intention.id);
      try {
        result = await action.execute(intention, this.beliefs);
      } finally {
        this.actionsInFlight.delete(intention.id);
      }

      // Every other effect the action reports is applied even when it also
      // reports a failure: partial progress is real progress, and dropping it
      // would lose the beliefs, sub-goals and messages the action did produce.
      const hasChildren = await this.applyActionResult(result, intention);

      if (result.failure) {
        await this.failIntention(intention, result.failure.reason);
        return;
      }

      this.intentions.advance(intention.id);
      this.emitter.emit("intention:advanced", {
        intention,
        action,
        result,
      } satisfies IntentionAdvanced);

      // Waiting is decided before completion: work an action hands off is
      // part of the plan's outcome, even from its last action, so the plan is
      // not done until that work is. Once it settles, the intention resumes
      // with no action left and completes then.
      if (hasChildren) {
        intention.result = result;
        this.intentions.setStatus(intention.id, "waiting");
        this.emitter.emit("intention:waiting", {
          intention,
          children: [...intention.children],
          delegations: openDelegations(intention).map((d) => ({ ...d })),
        } satisfies IntentionWaiting);
        return;
      }

      const nextAction = intention.plan.body[intention.actionIndex];
      if (!nextAction) {
        this.completeIntention(intention, result);
        return;
      }
    } catch (error) {
      // An action that reported a failure stays failed for the reason it
      // reported, even if applying its other results then threw.
      const reason =
        result?.failure?.reason ??
        (error instanceof Error ? error.message : String(error));
      await this.failIntention(intention, reason);
    }
  }

  /**
   * Completes an intention and its goal in that order, so a listener on
   * `intention:completed` already sees the goal as `achieved`.
   */
  private completeIntention(intention: Intention, result: ActionResult): void {
    this.intentions.complete(intention.id, result);
    this.goals.setStatus(intention.goal.id, "achieved");
    this.emitter.emit("intention:completed", intention);
  }

  private async failIntention(
    intention: Intention,
    reason: string,
  ): Promise<void> {
    this.intentions.fail(intention.id, reason);
    await this.abandonDelegations(intention, reason);
    // Recorded before the transition, which is what will read it: the goal
    // carries no reason, and the requester is owed one with its `failure`.
    this.goalEndReasons.set(intention.goal.id, reason);
    this.goals.setStatus(intention.goal.id, "failed");
    this.emitter.emit("intention:failed", {
      intention,
      reason,
    } satisfies IntentionFailed);
    this.dropDependentGoals(intention.goal.id);
    await this.failWaitingParents(intention.goal, reason);
  }

  /**
   * A sub-goal that fails must not leave its parent waiting forever: the parent
   * either fails with it or resumes, so the slot it holds in `getActive()` is
   * always released. Failing parents cascade the same way, so the whole chain
   * of waiting ancestors unwinds up to the top-level goal.
   *
   * Takes the child goal rather than its intention, so a goal that was refused
   * at admission — which never had one — takes the same path.
   */
  private async failWaitingParents(child: Goal, reason: string): Promise<void> {
    if (!child.parentGoalId) {
      return;
    }

    const parents = this.intentions
      .getByGoal(child.parentGoalId)
      .filter((i) => i.status === "waiting" && i.children.includes(child.id));

    for (const parent of parents) {
      await this.settleDelegation(parent, this.localDelegation(parent, child), {
        failed: reason,
      });
    }
  }

  /**
   * The record of the self-delegation that created a sub-goal. Every sub-goal
   * an action creates has one; an intention whose `children` were filled in by
   * hand gets one made up on the spot, so it settles the same way.
   */
  private localDelegation(intention: Intention, child: Goal): Delegation {
    const found = intention.delegations.find(
      (d) => d.receiver === this.id && d.goalId === child.id,
    );
    if (found) return found;
    const made: Delegation = {
      receiver: this.id,
      goal: child.name,
      status: "agreed",
      goalId: child.id,
    };
    intention.delegations.push(made);
    return made;
  }

  /**
   * Settles one of an intention's delegations — its own sub-goal or a remote
   * request — and decides what the intention does about it. The one place a
   * waiting intention is released, whatever kind of work it was waiting for.
   *
   * - **Done**: the record keeps the result, and an intention with nothing
   *   else outstanding resumes.
   * - **Failed**: the plan's `onChildFailure` decides. `"fail"` fails the
   *   intention, which cascades to its own waiting parents and cancels its
   *   other open delegations; `"continue"` records the failure in
   *   `childFailures` and resumes once nothing is outstanding.
   *
   * A delegation already settled is left alone, so a late or repeated answer
   * changes nothing.
   */
  private async settleDelegation(
    intention: Intention,
    delegation: Delegation,
    outcome: { done: unknown } | { failed: string },
  ): Promise<void> {
    if (!isOpenDelegation(delegation)) {
      return;
    }
    if ("done" in outcome) {
      delegation.status = "done";
      if (outcome.done !== undefined) delegation.result = outcome.done;
    } else {
      delegation.status = "failed";
      delegation.reason = outcome.failed;
    }
    const local = delegation.exchange === undefined;
    if (local) {
      intention.children = intention.children.filter(
        (id) => id !== delegation.goalId,
      );
    }
    this.emitter.emit("delegation:settled", {
      intention,
      delegation: { ...delegation },
    } satisfies DelegationSettled);

    if (intention.status !== "waiting") {
      return;
    }

    if (!("failed" in outcome)) {
      if (!isAwaitingWork(intention)) {
        this.intentions.setStatus(intention.id, "executing");
      }
      return;
    }

    if (intention.plan.onChildFailure === "continue") {
      intention.childFailures.push({
        ...(delegation.goalId !== undefined
          ? { goalId: delegation.goalId }
          : {}),
        goal: delegation.goal,
        reason: outcome.failed,
        ...(local
          ? {}
          : { receiver: delegation.receiver, exchange: delegation.exchange }),
      } satisfies ChildFailure);
      if (!isAwaitingWork(intention)) {
        this.intentions.setStatus(intention.id, "executing");
      }
      return;
    }

    await this.failIntention(
      intention,
      local
        ? `sub-goal "${delegation.goal}" failed: ${outcome.failed}`
        : `delegation of "${delegation.goal}" to ${delegation.receiver} failed: ${outcome.failed}`,
    );
  }

  /**
   * Hands one goal off for an action, and records the delegation on the
   * intention. A self-delegation becomes a sub-goal; any other a `request`.
   */
  private async delegate(
    request: DelegationRequest,
    intention: Intention,
  ): Promise<Delegation> {
    const receiver = request.receiver ?? this.id;
    const local = receiver === this.id;
    const timeoutMs =
      request.timeoutMs === null
        ? 0
        : (request.timeoutMs ?? (local ? 0 : this.config.delegationTimeoutMs));
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
    const parent = intention.goal;

    if (local) {
      const goalId = `goal-${randomUUID()}`;
      const delegation: Delegation = {
        receiver,
        goal: request.goal,
        status: "agreed",
        goalId,
        ...(deadline !== undefined ? { deadline } : {}),
      };
      intention.delegations.push(delegation);
      intention.children.push(goalId);
      this.goals.add({
        id: goalId,
        name: request.goal,
        priority: request.priority ?? 5,
        status: "pending",
        data: request.view,
        parentGoalId: parent.id,
        rootGoalId: parent.rootGoalId ?? parent.id,
        // Inherited so the original sender stays traceable however deep the
        // decomposition goes.
        ...(parent.source ? { source: parent.source } : {}),
      });
      return delegation;
    }

    // A request of the goal's conversation, but an exchange of its own: no
    // `inReplyTo` (it answers nothing) and a fresh `replyWith`, which every
    // reply names back and which keys the delegation.
    const conversationId = parent.source?.conversationId;
    const sent = await this.sendMessage(receiver, {
      performative: "request",
      sender: this.id,
      receiver,
      content: { ...request.view, goal: request.goal },
      ...(conversationId ? { conversationId } : {}),
      timestamp: Date.now(),
    });
    const exchange = sent.replyWith!;
    const delegation: Delegation = {
      receiver,
      goal: request.goal,
      status: "sent",
      exchange,
      ...(deadline !== undefined ? { deadline } : {}),
    };
    intention.delegations.push(delegation);
    this.remoteDelegations.set(exchange, {
      intention,
      delegation,
      ...(sent.conversationId ? { conversationId: sent.conversationId } : {}),
    });
    return delegation;
  }

  /**
   * A request this agent sent has ended — done, failed, refused, not
   * understood, unanswered, or cancelled. Stops tracking it, and settles the
   * delegation it carried, if it carried one.
   *
   * Every way a request ends comes through here, so no path can leave a
   * delegating intention waiting on a request that is already over.
   */
  private async endSentRequest(
    exchange: string,
    outcome: { done: unknown } | { failed: string },
  ): Promise<void> {
    this.sentRequests.delete(exchange);
    const delegated = this.remoteDelegations.get(exchange);
    if (!delegated) {
      return;
    }
    this.remoteDelegations.delete(exchange);
    await this.settleDelegation(
      delegated.intention,
      delegated.delegation,
      outcome,
    );
  }

  /**
   * Fails every open delegation whose deadline has passed, and asks its work
   * to stop: a remote receiver is sent a `cancel`, and a self-delegated
   * sub-goal is withdrawn under the same rules (see {@link withdraw}).
   */
  private async expireDelegations(): Promise<void> {
    const now = Date.now();
    for (const intention of this.intentions.getByStatus("waiting")) {
      for (const delegation of openDelegations(intention)) {
        if (delegation.deadline === undefined || delegation.deadline > now) {
          continue;
        }
        const reason = `not done by ${new Date(delegation.deadline).toISOString()}`;
        if (delegation.exchange !== undefined) {
          const conversationId = this.remoteDelegations.get(
            delegation.exchange,
          )?.conversationId;
          this.remoteDelegations.delete(delegation.exchange);
          await this.cancelDelegation(delegation, conversationId);
        }
        await this.settleDelegation(intention, delegation, { failed: reason });
        if (delegation.exchange === undefined) {
          await this.withdrawSubGoal(delegation);
        }
      }
    }
  }

  /**
   * An intention stopped waiting — it failed, or was cancelled — with
   * delegations still open. Each is marked `cancelled` and its work asked to
   * stop, so nobody goes on working for nobody: a remote receiver is sent a
   * `cancel`, and a self-delegated sub-goal is withdrawn the way that receiver
   * would treat it (see {@link withdraw}).
   *
   * `remoteOnly` leaves the sub-goals to the caller: a withdrawal already
   * drops every goal in its tree.
   */
  private async abandonDelegations(
    intention: Intention,
    reason: string,
    options: { remoteOnly?: boolean } = {},
  ): Promise<void> {
    const local: Delegation[] = [];
    for (const delegation of intention.delegations) {
      if (!isOpenDelegation(delegation)) {
        continue;
      }
      if (delegation.exchange === undefined && options.remoteOnly) {
        continue;
      }
      delegation.status = "cancelled";
      delegation.reason = reason;
      this.emitter.emit("delegation:settled", {
        intention,
        delegation: { ...delegation },
      } satisfies DelegationSettled);
      if (delegation.exchange === undefined) {
        intention.children = intention.children.filter(
          (id) => id !== delegation.goalId,
        );
        local.push(delegation);
        continue;
      }
      const conversationId = this.remoteDelegations.get(
        delegation.exchange,
      )?.conversationId;
      this.remoteDelegations.delete(delegation.exchange);
      void this.cancelDelegation(delegation, conversationId);
    }
    for (const delegation of local) {
      await this.withdrawSubGoal(delegation);
    }
  }

  /**
   * Withdraws a self-delegated sub-goal nobody waits for any more. If it
   * cannot be withdrawn — a started plan is not `cancellable` — it runs on,
   * as a remote delegate that answered the `cancel` with `failure` would.
   */
  private async withdrawSubGoal(delegation: Delegation): Promise<void> {
    if (delegation.goalId === undefined) return;
    await this.withdraw(delegation.goalId, this.id, async () => {});
  }

  /**
   * Asks a delegation's receiver to stop: a `cancel` naming the request as
   * `inReplyTo`. Its reply is filed like that of any cancel this agent sends.
   */
  private async cancelDelegation(
    delegation: Delegation,
    conversationId: string | undefined,
  ): Promise<void> {
    try {
      await this.sendMessage(delegation.receiver, {
        performative: "cancel",
        sender: this.id,
        receiver: delegation.receiver,
        content: {
          goal: delegation.goal,
          ...(delegation.goalId !== undefined
            ? { goalId: delegation.goalId }
            : {}),
        },
        ...(conversationId ? { conversationId } : {}),
        inReplyTo: delegation.exchange!,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${this.id}] Failed to cancel ${delegation.goal} with ${delegation.receiver}:`,
        error,
      );
    }
  }

  private async applyActionResult(
    result: ActionResult,
    intention: Intention,
  ): Promise<boolean> {
    if (result.result !== undefined) {
      this.goalResults.set(intention.goal.id, result.result);
    }

    if (result.beliefUpdates) {
      for (const { key, value } of result.beliefUpdates) {
        this.beliefs.set(key, value);
      }
    }

    if (result.beliefRemovals) {
      for (const key of result.beliefRemovals) {
        this.beliefs.remove(key);
      }
    }

    // Independent work: root goals with no parent and no source, which this
    // intention neither waits for nor answers for.
    if (result.spawn) {
      for (const goal of result.spawn) {
        this.goals.add({
          id: `goal-${randomUUID()}`,
          name: goal.name,
          priority: goal.priority,
          status: "pending",
          data: goal.data,
        });
      }
    }

    let hasChildren = false;
    if (result.delegations && result.delegations.length > 0) {
      const made: Delegation[] = [];
      for (const request of result.delegations) {
        made.push(await this.delegate(request, intention));
      }
      this.emitter.emit("intention:delegated", {
        intention,
        delegations: made.map((d) => ({ ...d })),
      } satisfies IntentionDelegated);
      hasChildren = true;
    }

    if (result.messages) {
      const source = intention.goal.source;
      for (const msg of result.messages) {
        // `in-reply-to` names the earlier message *this* one answers (SC00061),
        // so it only means anything to the agent that sent that message — the
        // requester, whose `replyWith` is what `source` recorded. A third agent
        // or a topic subscriber never saw it, and inheriting it would have them
        // reading a reply to nothing. `conversationId` names the thread rather
        // than a message, so the decomposition stays in one conversation
        // wherever it speaks, and the fresh `replyWith` `sendMessage` and
        // `publishMessage` stamp keeps each leg distinguishable. An explicit
        // `inReplyTo` on the action's own message wins: the plan may be
        // answering something the goal's source knows nothing about.
        //
        // Only a point-to-point message can answer the requester: a topic
        // message is heard by every subscriber, whatever `receiver` it also
        // names. And only an act that is not itself a directive answers
        // anything — a `request` or `query-if` back to the requester opens a
        // new exchange rather than replying to the old one.
        const toRequester =
          msg.topic === undefined &&
          msg.receiver !== undefined &&
          source !== undefined &&
          msg.receiver === replyAddress(source);
        const answersRequester =
          toRequester && !hasHearerEffect(msg.performative);
        const inReplyTo =
          msg.inReplyTo ?? (answersRequester ? source?.inReplyTo : undefined);
        const correlation = {
          ...(source?.conversationId
            ? { conversationId: source.conversationId }
            : {}),
          ...(inReplyTo ? { inReplyTo } : {}),
        };

        // A plan may set its own `reply-by`, or opt out of the agent's default
        // with `null`, and may route the replies elsewhere with `reply-to`.
        const routing = {
          ...(typeof msg.replyBy === "string" ? { replyBy: msg.replyBy } : {}),
          ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
        };

        if (msg.topic !== undefined) {
          await this.publishMessage(msg.topic, {
            performative: msg.performative,
            sender: this.id,
            topic: msg.topic,
            ...correlation,
            ...routing,
            content: msg.content,
            timestamp: Date.now(),
          });
        } else if (msg.receiver !== undefined) {
          await this.sendMessage(
            msg.receiver,
            {
              performative: msg.performative,
              sender: this.id,
              receiver: msg.receiver,
              ...correlation,
              ...routing,
              content: msg.content,
              timestamp: Date.now(),
            },
            msg.replyBy === null ? { replyBy: null } : {},
          );
          if (answersRequester && inReplyTo === source?.inReplyTo) {
            this.recordPlanAnswer(
              intention.goal,
              msg.performative,
              msg.content,
            );
          }
        } else {
          throw new Error(
            "ActionResult message must specify a topic or a receiver",
          );
        }
      }
    }

    return hasChildren;
  }

  /**
   * Records that the plan has answered the exchange its goal was requested
   * under itself. Only called for a point-to-point message to the requester
   * whose `inReplyTo` names the request — a message answering something else
   * says nothing about this exchange.
   *
   * A `failure` is terminal and closes the exchange, so the automatic one does
   * not follow it. An `inform` is terminal only when it says so with
   * `done: true` in its content — the marker the automatic `inform` carries —
   * and then it stands in for the automatic one if the goal is achieved. Any
   * other `inform` is a note (progress, a partial result) and changes nothing:
   * the requester still gets `inform { done: true }` on success, so it always
   * has one reply it can close the request on. A plan that marks its result
   * done and then fails still owes the requester its `failure`. FIPA's request
   * protocol asks for exactly one terminal reply after `agree`, and which of
   * the plan's messages was terminal is only known once the goal ends.
   *
   * Keyed on the root goal: a sub-goal's messages inherit the same `source`,
   * so they answer the same request the root does.
   */
  private recordPlanAnswer(
    goal: Goal,
    performative: string,
    content: unknown,
  ): void {
    const rootId = goal.rootGoalId ?? goal.id;
    if (performative === "failure") {
      this.openRequests.delete(rootId);
      return;
    }
    if (performative === "inform" && isDone(content)) {
      const open = this.openRequests.get(rootId);
      if (open) {
        open.informed = true;
      }
    }
  }

  private dropDependentGoals(failedGoalId: string): void {
    for (const goal of this.goals.getUnfinished()) {
      if (goal.dependsOn?.includes(failedGoalId)) {
        // Recorded before the transition: a goal dropped this way never ran,
        // so nothing else can say why, and a requester that was agreed to is
        // owed that much with its `failure`.
        const reason = `dropped: dependency "${failedGoalId}" failed`;
        this.goalEndReasons.set(goal.id, reason);
        this.goals.setStatus(goal.id, "dropped");
        // A parent waiting on it will not get it.
        if (goal.parentGoalId) {
          void this.failWaitingParents(goal, reason);
        }
      }
    }
  }

  /**
   * Releases the intentions waiting on a sub-goal that has just left the queue,
   * so a parent never waits on a goal that is gone. An achieved one settles
   * its delegation as done; one that left any other way — taken out with
   * `goals.remove()` before it finished — as failed. A sub-goal that failed or
   * was dropped has already settled by the time it is collected.
   *
   * Driven by collection rather than by a sweep over every waiting intention:
   * the sub-goal knows its parent, and the parent knows its own goal, so both
   * lookups are direct.
   */
  private releaseWaitingParents(child: Goal): void {
    if (!child.parentGoalId) {
      return;
    }

    for (const intention of this.intentions.getByGoal(child.parentGoalId)) {
      if (
        intention.status !== "waiting" ||
        !intention.children.includes(child.id)
      ) {
        continue;
      }

      void this.settleDelegation(
        intention,
        this.localDelegation(intention, child),
        child.status === "achieved"
          ? { done: this.goalResults.get(child.id) }
          : { failed: "removed before it finished" },
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a FIPA `reply-by` has passed. An absent or unparseable one never
 * has: a deadline nobody can read cannot be held against anyone.
 */
function isPast(replyBy: string | undefined): boolean {
  if (replyBy === undefined) return false;
  const deadline = Date.parse(replyBy);
  return !Number.isNaN(deadline) && deadline <= Date.now();
}

/**
 * Where replies to a message go: its FIPA `reply-to` when it names one,
 * otherwise its sender.
 */
function replyAddress(msg: { sender?: string; replyTo?: string }): string {
  return msg.replyTo ?? msg.sender ?? "";
}

/** Whether a received verdict is one of this library's {@link RefusalVerdict}s. */
function isRefusalVerdict(value: unknown): value is RefusalVerdict {
  return (
    value === "no-plan" ||
    value === "capacity" ||
    value === "unsupported" ||
    value === "middleware"
  );
}

/**
 * Whether an `inform` answering a request is its terminal reply: content
 * carrying `done: true`, as the automatic success reply does. Any other
 * `inform` in the exchange is a note — progress, a partial result.
 */
function isDone(content: unknown): boolean {
  return isRecord(content) && content.done === true;
}
