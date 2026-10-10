import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  hasHearerEffect,
  isUnsupportedDirective,
  isQueryDirective,
  isStandingDirective,
} from "../../bus/performatives.js";
import { validateContent, schemaViolationReason } from "../../bus/schemas.js";
import type { Message, MessageBus } from "../../bus/index.js";
import { InMemoryBeliefBase } from "../beliefs.js";
import type { BeliefBase, BeliefStatus } from "../beliefs.js";
import { GoalQueue, type Goal, type GoalStatus } from "../goals.js";
import { Inbox, DEFAULT_MAX_INBOX_ENTRIES, type InboxEntry } from "../inbox.js";
import { ExpressionLibrary, PropositionLibrary } from "../expressions.js";
import { PlanLibrary } from "../plans.js";
import type { RefusalVerdict } from "../plans.js";
import {
  IntentionStack,
  createIntention,
  openDelegations,
} from "../intentions.js";
import type { Delegation, Intention } from "../intentions.js";
import type { ActionResult, DelegationRequest } from "../plans.js";
import type {
  AgentConfig,
  AgentEvent,
  AgentEventHandler,
  DirectiveMiddleware,
  DirectiveResponse,
  GoalAck,
  GoalRefusal,
  IntentionAdvanced,
  IntentionDelegated,
  IntentionFailed,
  IntentionWaiting,
} from "./types.js";
import type {
  AwaitedReply,
  DirectiveOutcome,
  OpenRequest,
  PendingAgreement,
  PendingCancel,
  PendingOutcome,
  PendingQuery,
  PendingRefusal,
  PendingRejection,
  QueuedCancel,
  SentRequest,
  StandingCommitment,
  Withdrawal,
} from "./internal.js";
import {
  DEFAULT_DELEGATION_TIMEOUT_MS,
  DEFAULT_EVALUATION_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_EVALUATIONS,
  DEFAULT_REPLY_TIMEOUT_MS,
  defaultBeliefKey,
  resolveAgentMaxGoals,
} from "./constants.js";
import { isDone, isRecord, replyAddress, resolveWaitFor } from "./helpers.js";
import {
  awaitReply,
  exchangeKey,
  publishMessage,
  sendMessage,
  sendNotUnderstood,
  sendRefusalReply,
} from "./messaging.js";
import {
  applySettledEvaluations,
  canEvaluate,
  markPendingQuery,
  pendingQueryFor,
  settleQueryAnswer,
  settleUnansweredQuery,
  startEvaluation,
} from "./evaluation.js";
import {
  handleMessage,
  ingestAssertion,
  perceive,
  reviseBeliefs,
} from "./perception.js";
import { admitDirective, answerQuery, goalFromMessage } from "./directives.js";
import {
  applyStandingOutcome,
  admitStanding,
  evaluateStanding,
  fireStanding,
  retryPendingFires,
  sendStandingReply,
  tryFire,
} from "./standing.js";
import {
  cancelRequest,
  handleCancel,
  isWithin,
  processQueuedCancels,
  replyToCancel,
  withdraw,
} from "./cancellation.js";
import {
  handleAgreement,
  handleFailureMessage,
  handleNotUnderstoodMessage,
  handleRefusalMessage,
  pendingCancelFor,
  sentRequestFor,
  settleCancelReply,
  settleRequestInform,
} from "./replies.js";
import {
  declineGoal,
  expireReplies,
  flushDirectiveAnswers,
  flushTerminalAnswers,
  queueOutcome,
  reportRejections,
} from "./answers.js";
import {
  abandonDelegations,
  cancelDelegation,
  delegate,
  endSentRequest,
  expireDelegations,
  failurePolicy,
  localDelegation,
  resumeIntention,
  reviewDelegations,
  settleDelegation,
  withdrawSubGoal,
} from "./delegation.js";
import {
  abandonRemovedGoal,
  failOrphanedIntention,
  onGoalAdded,
  onGoalRejected,
  onGoalRemoved,
  onGoalStatusChanged,
  onIntentionRemoved,
} from "./events.js";

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
  /** @internal */
  readonly bus: MessageBus;
  /** @internal */
  planLibrary: PlanLibrary;
  /** @internal */
  readonly config: Required<AgentConfig>;
  private tickTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private running = false;
  private unsubs: Array<() => void> = [];
  private subscribedTopics = new Set<string>();
  /** @internal */
  pendingAcks: PendingAgreement[] = [];
  /** @internal */
  pendingRefusals: PendingRefusal[] = [];
  /** @internal */
  pendingRejections: PendingRejection[] = [];
  /** @internal */
  pendingOutcomes: PendingOutcome[] = [];
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
  /** @internal */
  openRequests = new Map<string, OpenRequest>();
  /**
   * Queries this agent asked and is still waiting on, keyed by the query's
   * `replyWith`. An entry leaves when the answer, a refusal, a failure or a
   * `not-understood` naming it arrives. A peer that never replies leaves its
   * entry — and the `uncertain` answer belief — in place: there is no reply
   * deadline yet.
   */
  /** @internal */
  readonly pendingQueries = new Map<string, PendingQuery>();
  /**
   * The `request-when`, `request-whenever` and `subscribe` commitments this
   * agent agreed to and is still watching, keyed by the directive's
   * `replyWith`. A `request-when` leaves once it fires; the other two only on
   * `cancel` or an evaluation that fails. Survives `stop()` like goals do.
   */
  /** @internal */
  standing = new Map<string, StandingCommitment>();
  /**
   * Directives this agent sent that still await a first reply, keyed by their
   * `replyWith`. Only directives with a `reply-by` are held here; see
   * {@link AgentConfig.replyTimeoutMs}.
   */
  /** @internal */
  readonly awaitingReply = new Map<string, AwaitedReply>();
  /**
   * Requests this agent sent that have not ended, keyed by their
   * `replyWith`. An entry leaves when the request completes, fails, is
   * refused, is not understood or times out. A `request-whenever` stays until
   * this agent cancels it, since each firing completes or fails on its own.
   */
  /** @internal */
  readonly sentRequests = new Map<string, SentRequest>();
  /**
   * Remote delegations still open, keyed by their request's `replyWith`: the
   * intention waiting on each and its record there. An entry leaves when the
   * request ends (see {@link endSentRequest}) or the intention stops waiting.
   */
  /** @internal */
  remoteDelegations = new Map<
    string,
    { intention: Intention; delegation: Delegation; conversationId?: string }
  >();
  /**
   * The batch of delegations each waiting intention is waiting on, by
   * intention id: where in `intention.delegations` the last delegating action's
   * delegations start, and how many of them must succeed (`waitFor`).
   */
  /** @internal */
  delegationBatches = new Map<string, { from: number; needed: number }>();
  /** Cancels this agent sent that await a reply, keyed by their `replyWith`. */
  /** @internal */
  readonly pendingCancels = new Map<string, PendingCancel>();
  /**
   * Cancels received for a request whose action was running at the time,
   * carried out at the next action boundary.
   */
  /** @internal */
  queuedCancels: QueuedCancel[] = [];
  /** Intentions whose current action is running right now. */
  /** @internal */
  actionsInFlight = new Set<string>();
  /**
   * Proposition and expression evaluations that have settled since they were
   * last applied: the continuation each one runs, in settling order. An
   * evaluation is started without being awaited, so a slow one never holds up
   * the cycle; the tick applies whatever has settled.
   */
  /** @internal */
  settledEvaluations: Array<() => Promise<void>> = [];
  /** How many evaluations are running, so a tick knows whether to wait a beat. */
  /** @internal */
  evaluationsInFlight = 0;
  /**
   * Why a goal that reached `failed` or `dropped` ended that way, recorded
   * beside the transition because the goal itself carries no reason and the
   * event payload is the live object. Read when the terminal answer is built
   * and dropped with it, so this cannot outlive the goal it describes.
   */
  /** @internal */
  goalEndReasons = new Map<string, string>();
  /**
   * The answer each goal's plan returned (`ActionResult.result`), kept until
   * the goal leaves the queue so the terminal `inform` and a waiting parent can
   * both read it.
   */
  /** @internal */
  goalResults = new Map<string, unknown>();
  // The goal queue reports the status a goal ended up in, not the one it left,
  // so the agent remembers the last status it saw per goal to report the
  // transition on `goal:status`. Entries go when the goal is collected, so this
  // does not grow with the number of jobs the agent has run.
  /** @internal */
  lastGoalStatus = new Map<string, GoalStatus>();
  /** @internal */
  readonly emitter = new EventEmitter();

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
   * them (for a networked bus this means no published message can race ahead of
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

  /** @internal */
  canEvaluate(): boolean {
    return canEvaluate(this);
  }

  /** @internal */
  startEvaluation(
    library: ExpressionLibrary,
    name: string,
    message: Message,
    then: (
      outcome: { value: unknown } | { error: unknown },
    ) => Promise<void> | void,
  ): void {
    return startEvaluation(this, library, name, message, then);
  }

  /** @internal */
  applySettledEvaluations(): Promise<void> {
    return applySettledEvaluations(this);
  }

  /** @internal */
  expireReplies(): Promise<void> {
    return expireReplies(this);
  }

  /** @internal */
  exchangeKey(
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
    return exchangeKey(this, prefix, peer, goal, exchange);
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

  /** @internal */
  markPendingQuery(peer: string, query: Message): void {
    return markPendingQuery(this, peer, query);
  }

  /** @internal */
  pendingQueryFor(msg: Message): PendingQuery | undefined {
    return pendingQueryFor(this, msg);
  }

  /** @internal */
  settleQueryAnswer(msg: Message, pending: PendingQuery): Promise<void> {
    return settleQueryAnswer(this, msg, pending);
  }

  /** @internal */
  settleUnansweredQuery(msg: Message, pending: PendingQuery): void {
    return settleUnansweredQuery(this, msg, pending);
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

  /** @internal */
  onGoalAdded(goal: Goal): void {
    return onGoalAdded(this, goal);
  }

  /** @internal */
  onGoalStatusChanged(goal: Goal): void {
    return onGoalStatusChanged(this, goal);
  }

  /** @internal */
  onGoalRemoved(goal: Goal): void {
    return onGoalRemoved(this, goal);
  }

  /** @internal */
  abandonRemovedGoal(goal: Goal): Promise<void> {
    return abandonRemovedGoal(this, goal);
  }

  /** @internal */
  failOrphanedIntention(intention: Intention): Promise<void> {
    return failOrphanedIntention(this, intention);
  }

  /** @internal */
  onIntentionRemoved(intention: Intention): void {
    return onIntentionRemoved(this, intention);
  }

  /** @internal */
  onGoalRejected(goal: Goal): void {
    return onGoalRejected(this, goal);
  }

  /** @internal */
  reportRejections(): Promise<void> {
    return reportRejections(this);
  }

  /** @internal */
  sendRefusalReply(goal: Goal, to: string, reason: string): Promise<void> {
    return sendRefusalReply(this, goal, to, reason);
  }

  /** @internal */
  sendNotUnderstood(msg: Message, reason: string): void {
    return sendNotUnderstood(this, msg, reason);
  }

  /** @internal */
  sendMessage(
    agentId: string,
    message: Message,
    options: { replyBy?: null } = {},
  ): Promise<Message> {
    return sendMessage(this, agentId, message, options);
  }

  /** @internal */
  awaitReply(peer: string, directive: Message, replyBy: string): void {
    return awaitReply(this, peer, directive, replyBy);
  }

  /** @internal */
  publishMessage<T>(topic: string, message: Message<T>): Promise<Message<T>> {
    return publishMessage(this, topic, message);
  }

  /** @internal */
  handleMessage(msg: Message): void {
    return handleMessage(this, msg);
  }

  /** @internal */
  perceive(): InboxEntry[] {
    return perceive(this);
  }

  /** @internal */
  reviseBeliefs(percepts: InboxEntry[]): Promise<void> {
    return reviseBeliefs(this, percepts);
  }

  /**
   * Runs the directive middleware chain, then decides on the directive.
   *
   * The chain runs first and unwrapped: it is the hook that can observe, rewrite
   * or veto a request or query before anything parses it or consults
   * the plan check and the goal bound. A chain that reaches the end triggers
   * the plan check and the goal bound. A chain that reaches the end triggers
   * `admitDirective` for a request and `answerQuery` for a query; a
   * chain that stops early, or throws, declines.
   *
   * Split from `admitDirective` so the interruption point is one function
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

  /** @internal */
  admitDirective(msg: Message, priority: number): void {
    return admitDirective(this, msg, priority);
  }

  /** @internal */
  answerQuery(msg: Message): void {
    return answerQuery(this, msg);
  }

  /** @internal */
  admitStanding(msg: Message): void {
    return admitStanding(this, msg);
  }

  /** @internal */
  evaluateStanding(): void {
    return evaluateStanding(this);
  }

  /** @internal */
  applyStandingOutcome(
    commitment: StandingCommitment,
    outcome: { value: unknown } | { error: unknown },
  ): Promise<void> {
    return applyStandingOutcome(this, commitment, outcome);
  }

  /** @internal */
  tryFire(commitment: StandingCommitment): void {
    return tryFire(this, commitment);
  }

  /** @internal */
  retryPendingFires(): void {
    return retryPendingFires(this);
  }

  /** @internal */
  fireStanding(commitment: StandingCommitment, goalId: string): void {
    return fireStanding(this, commitment, goalId);
  }

  /** @internal */
  sendStandingReply(
    commitment: StandingCommitment,
    performative: "inform" | "failure",
    content: Record<string, unknown>,
  ): Promise<void> {
    return sendStandingReply(this, commitment, performative, content);
  }

  /** @internal */
  handleCancel(msg: Message): Promise<void> {
    return handleCancel(this, msg);
  }

  /** @internal */
  cancelRequest(msg: Message, rootGoalId: string): Promise<void> {
    return cancelRequest(this, msg, rootGoalId);
  }

  /** @internal */
  withdraw(
    goalId: string,
    by: string,
    settle: (outcome: Withdrawal) => Promise<void>,
  ): Promise<void> {
    return withdraw(this, goalId, by, settle);
  }

  /** @internal */
  isWithin(goal: Goal, ancestorId: string): boolean {
    return isWithin(this, goal, ancestorId);
  }

  /** @internal */
  processQueuedCancels(): Promise<void> {
    return processQueuedCancels(this);
  }

  /** @internal */
  replyToCancel(
    msg: Message,
    performative: "inform" | "failure",
    content: Record<string, unknown>,
  ): Promise<void> {
    return replyToCancel(this, msg, performative, content);
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

  /** @internal */
  ingestAssertion(
    msg: Message,
    store?: () => { keys: string[]; status: BeliefStatus },
  ): Promise<boolean> {
    return ingestAssertion(this, msg, store);
  }

  /** @internal */
  handleAgreement(msg: Message): void {
    return handleAgreement(this, msg);
  }

  /** @internal */
  handleRefusalMessage(msg: Message): Promise<void> {
    return handleRefusalMessage(this, msg);
  }

  /** @internal */
  pendingCancelFor(msg: Message): PendingCancel | undefined {
    return pendingCancelFor(this, msg);
  }

  /** @internal */
  settleCancelReply(msg: Message, pending: PendingCancel): Promise<void> {
    return settleCancelReply(this, msg, pending);
  }

  /** @internal */
  sentRequestFor(msg: Message): SentRequest | undefined {
    return sentRequestFor(this, msg);
  }

  /** @internal */
  settleRequestInform(msg: Message, sent: SentRequest): Promise<void> {
    return settleRequestInform(this, msg, sent);
  }

  /** @internal */
  handleFailureMessage(msg: Message): Promise<void> {
    return handleFailureMessage(this, msg);
  }

  /** @internal */
  handleNotUnderstoodMessage(msg: Message): Promise<void> {
    return handleNotUnderstoodMessage(this, msg);
  }

  /** @internal */
  goalFromMessage(
    msg: Message,
    priority: number,
  ): DirectiveOutcome | undefined {
    return goalFromMessage(this, msg, priority);
  }

  /** @internal */
  flushDirectiveAnswers(): Promise<void> {
    return flushDirectiveAnswers(this);
  }

  /** @internal */
  queueOutcome(goal: Goal): void {
    return queueOutcome(this, goal);
  }

  /** @internal */
  flushTerminalAnswers(): Promise<void> {
    return flushTerminalAnswers(this);
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

  /** @internal */
  declineGoal(goal: Goal, verdict: RefusalVerdict, reason?: string): void {
    return declineGoal(this, goal, verdict, reason);
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
    // Nor does work whose goal was removed.
    if (!this.goals.get(intention.goal.id)) {
      await this.failOrphanedIntention(intention);
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

      // The goal was removed while the action ran: the action's result stands,
      // but nothing after it starts.
      if (!this.goals.get(intention.goal.id)) {
        await this.failOrphanedIntention(intention);
        return;
      }

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

  /** @internal */
  async failIntention(intention: Intention, reason: string): Promise<void> {
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
  /** @internal */
  async failWaitingParents(child: Goal, reason: string): Promise<void> {
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

  /** @internal */
  localDelegation(intention: Intention, child: Goal): Delegation {
    return localDelegation(this, intention, child);
  }

  /** @internal */
  settleDelegation(
    intention: Intention,
    delegation: Delegation,
    outcome: { done: unknown } | { failed: string },
  ): Promise<void> {
    return settleDelegation(this, intention, delegation, outcome);
  }

  /** @internal */
  reviewDelegations(
    intention: Intention,
    justFailed: Delegation | undefined,
  ): Promise<void> {
    return reviewDelegations(this, intention, justFailed);
  }

  /** @internal */
  failurePolicy(delegation: Delegation): "fail" | "continue" {
    return failurePolicy(this, delegation);
  }

  /** @internal */
  resumeIntention(intention: Intention): void {
    return resumeIntention(this, intention);
  }

  /** @internal */
  delegate(
    request: DelegationRequest,
    intention: Intention,
  ): Promise<Delegation> {
    return delegate(this, request, intention);
  }

  /** @internal */
  endSentRequest(
    exchange: string,
    outcome: { done: unknown } | { failed: string },
  ): Promise<void> {
    return endSentRequest(this, exchange, outcome);
  }

  /** @internal */
  expireDelegations(): Promise<void> {
    return expireDelegations(this);
  }

  /** @internal */
  abandonDelegations(
    intention: Intention,
    reason: string,
    options: { remoteOnly?: boolean } = {},
  ): Promise<void> {
    return abandonDelegations(this, intention, reason, options);
  }

  /** @internal */
  withdrawSubGoal(delegation: Delegation): Promise<void> {
    return withdrawSubGoal(this, delegation);
  }

  /** @internal */
  cancelDelegation(
    delegation: Delegation,
    conversationId: string | undefined,
  ): Promise<void> {
    return cancelDelegation(this, delegation, conversationId);
  }

  /** @internal */
  async applyActionResult(
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
      this.delegationBatches.set(intention.id, {
        from: intention.delegations.length,
        needed: resolveWaitFor(result.waitFor, result.delegations.length),
      });
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

  /** @internal */
  dropDependentGoals(failedGoalId: string): void {
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
  /** @internal */
  releaseWaitingParents(child: Goal): void {
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
