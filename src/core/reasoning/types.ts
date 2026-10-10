import type { Message, MessageBus, Performative } from "../../bus/index.js";
import type { BeliefBase, BeliefStatus } from "../beliefs.js";
import type { Goal, GoalStatus } from "../goals.js";
import type { ExpressionLibrary, PropositionLibrary } from "../expressions.js";
import type {
  Action,
  ActionResult,
  PlanLibrary,
  RefusalVerdict,
} from "../plans.js";
import type { Delegation, Intention } from "../intentions.js";

/**
 * Re-exported so the refusal vocabulary can be reached from either the plan
 * layer that produces a plan's refusal or the agent layer that sends it.
 */
export type { RefusalVerdict } from "../plans.js";
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

/** Payload of a `delegation:settled` and a `delegation:progress` event. */
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
 * - `delegation:progress` — a delegate sent a progress note: an `inform`
 *   answering the delegation that is not its final `done`.
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
  "delegation:progress": DelegationSettled;
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
