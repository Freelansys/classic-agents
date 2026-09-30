import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  directivePriority,
  directsAction,
  isPropositional,
} from "../bus/performatives.js";
import type { Message, MessageBus } from "../bus/index.js";
import { InMemoryBeliefBase, type BeliefBase } from "./beliefs.js";
import {
  GoalQueue,
  resolveMaxGoals,
  type Goal,
  type GoalSource,
  type GoalStatus,
} from "./goals.js";
import { Inbox, DEFAULT_MAX_INBOX_ENTRIES, type InboxEntry } from "./inbox.js";
import { PlanLibrary } from "./plans.js";
import type { RefusalReason } from "./plans.js";
import { IntentionStack, createIntention } from "./intentions.js";
import type { ChildFailure, Intention } from "./intentions.js";
import type { Action, ActionResult } from "./plans.js";

/**
 * Re-exported so the refusal vocabulary can be reached from either the plan
 * layer that produces a plan's refusal or the agent layer that sends it.
 */
export type { RefusalReason, PlanRefusal } from "./plans.js";

/** Topic every agent publishes a failure notification on. */
export const FAILURE_TOPIC = "__failure__";

/**
 * Topic every agent publishes a completion notice on when a goal reaches
 * `achieved`. The achieved counterpart of `FAILURE_TOPIC`, so a monitor can
 * watch both ends of a job without inferring success from silence.
 *
 * Completion notices go to monitors only. Replying to whoever requested a goal
 * is left to the plan that requested it, which knows the reply shape its
 * caller needs.
 */
export const GOAL_ACHIEVED_TOPIC = "__goal_achieved__";

/**
 * Default bound on the number of unfinished goals an agent holds, pending and
 * active together, sub-goals included. A goal offered once the bound is reached
 * is admitted and immediately failed rather than queued, and the rejection is
 * reported on `FAILURE_TOPIC` and to whoever asked for the work. Override with
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
  goalId: string;
  conversationId?: string;
  messageId?: string;
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
  /** The goal that was asked for. */
  goal: string;
  /**
   * Which of {@link RefusalReason}s the receiver declined under.
   *
   * Optional, because a peer is free to send a `refuse` without saying why —
   * `refuse` is a standard performative, not one this library owns. The
   * decline an agent makes itself always carries a reason; one it *receives*
   * carries whatever the sender chose to give.
   */
  reason?: RefusalReason;
  /** The receiver's own explanation, for a monitor or a sender log. */
  detail?: string;
  conversationId?: string;
  messageId?: string;
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
   * Ids of the sub-goals the intention is waiting for: a copy, since the
   * intention's own list is trimmed as its children settle.
   */
  children: string[];
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
 *   worked on, so the requester gets a `refuse` instead of silence.
 * - `goal:refused` — the agent declined a directive, for want of capacity or
 *   because a `canAccept` predicate said no, so the requester gets a `refuse`
 *   instead of silence. Distinct from `goal:rejected`, which is the queue's own
 *   backpressure reported as a goal lifecycle; a directive declined by
 *   `canAccept` never reaches the queue at all.
 * - `goal:removed` — a finished goal left the queue, collected at the end of
 *   the cycle that finished it. Nothing is ever evicted: a goal only leaves
 *   once it has reached `achieved`, `failed` or `dropped`.
 * - `intention:started` — means-ends reasoning created an intention for an
 *   active goal and set it executing.
 * - `intention:advanced` — an action ran and the intention moved to its next
 *   one. Emitted before `intention:completed` when the action was the plan's
 *   last.
 * - `intention:waiting` — the action created sub-goals and the intention is
 *   now waiting for them.
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
export interface AgentEventMap {
  "goal:added": Goal;
  "goal:status": GoalStatusChange;
  "goal:rejected": GoalRejection;
  "goal:refused": GoalRefusal;
  "goal:removed": Goal;
  "intention:started": Intention;
  "intention:advanced": IntentionAdvanced;
  "intention:waiting": IntentionWaiting;
  "intention:completed": Intention;
  "intention:failed": IntentionFailed;
  "intention:removed": Intention;
  "message:received": Message;
  "message:sent": Message;
  goalAcknowledged: GoalAck;
  goalRefused: GoalRefusal;
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
  messageId?: string;
}

/** An `agree` to send: the directive was accepted and the goal now exists. */
interface PendingAgreement extends PendingAnswer {
  goalId: string;
}

/** A `refuse` to send: the directive was declined, so no goal was created. */
interface PendingRefusal extends PendingAnswer {
  reason: RefusalReason;
  detail?: string;
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
 * What the agent does with an incoming message that asserts something about
 * the world — the FIPA assertives and declaratives, so `inform`, `confirm`,
 * `declare`, `disagree` and the rest.
 *
 * FIPA-ACL gives an assertion no effect on the hearer, so this is the agent's
 * own policy and not a protocol obligation. The three choices:
 *
 * - `"beliefs"` — accept the assertion, and write its content keys into the
 *   belief base under `msg.`. The default, and the behaviour this library has
 *   always had.
 * - `"ignore"` — perceive the message and act on it not at all. The message
 *   still surfaces on `message:received` and still reaches plans, which see
 *   the inbox; only the belief base is left untouched.
 * - a predicate — decide per message, e.g. trust only the agents you know.
 *
 * A predicate is consulted for every propositional message, so keep it cheap.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   id: "qualifier",
 *   bus,
 *   planLibrary,
 *   informs: (msg) => msg.sender === "trusted-scout",
 * });
 * ```
 */
export type InformPolicy = "beliefs" | "ignore" | ((msg: Message) => boolean);

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
  beliefs?: BeliefBase;
  enableIntentionReconsideration?: boolean;
  maxConcurrentIntentions?: number;
  /**
   * Maximum number of unfinished goals (pending + active, sub-goals included)
   * the agent will hold. A goal offered once the bound is reached is admitted
   * and immediately failed rather than queued, so the agent sheds load instead
   * of growing without limit: it publishes a notice on `FAILURE_TOPIC` and
   * replies `refuse` to whoever asked for the work. Defaults to
   * `DEFAULT_MAX_GOALS`. `0` means unbounded.
   */
  maxGoals?: number;
  /**
   * What to do with incoming assertions about the world. Defaults to
   * `"beliefs"`; see {@link InformPolicy}. Has no effect on directives, which
   * become goals regardless, nor on messages that assert nothing.
   */
  informs?: InformPolicy;
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
   * Whether to accept a directive, before it becomes a goal. Returning `false`
   * declines it and replies `refuse`; returning a string declines it *with your
   * reason*, which the sender receives and any monitor reads on `goal:refused`.
   *
   * This is the FIPA point where a directive stops obliging the receiver. Under
   * FIPA-ACL a `request` asks; it does not command, and the receiver is free to
   * decline — so by default this agent agrees to every well-formed directive it
   * has capacity for, and declines only on capacity. Give it a predicate to
   * decline on its own terms.
   *
   * Consulted during the revision step, after the message is perceived and
   * before the goal exists, so a declined directive leaves no goal behind and
   * no queue slot consumed. Keep it cheap and side-effect free: it runs inside
   * the reasoning cycle.
   *
   * @example
   * ```ts
   * new Agent({
   *   id: "qualifier",
   *   bus,
   *   planLibrary,
   *   canAccept: (msg) =>
   *     msg.sender === "user-proxy"
   *       ? true
   *       : `only the user-proxy may direct me, not ${msg.sender}`,
   * });
   * ```
   */
  canAccept?: (msg: Message) => boolean | string;
}

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
  // Goals taken from a directive that have not been answered yet, keyed by goal
  // id. They are admitted — they hold a `maxGoals` slot while they wait — but
  // still owe the requester either an `agree` or a `refuse`, and which one is
  // not known until a plan rules on the goal. Entries go when the goal is
  // answered or collected, so this cannot outlive the goals it names.
  private readonly unacknowledged = new Map<
    string,
    Omit<PendingAgreement, "goalId">
  >();
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
      enableIntentionReconsideration: false,
      maxConcurrentIntentions: 10,
      informs: "beliefs",
      maxInboxSize: DEFAULT_MAX_INBOX_ENTRIES,
      ...config,
      beliefs: this.beliefs,
      maxGoals: resolveAgentMaxGoals(config.maxGoals),
      beliefKey: config.beliefKey ?? defaultBeliefKey,
      // Accept everything by default. The default agent is one that has not
      // been told otherwise, and FIPA does not make a request an obligation;
      // it makes declining the receiver's right. A caller that wants the
      // receiver to be selective supplies the predicate.
      canAccept: config.canAccept ?? (() => true),
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

    this.unsubs.push(
      this.beliefs.on("beliefAdded", () => this.onBeliefChange()),
      this.beliefs.on("beliefUpdated", () => this.onBeliefChange()),
    );

    if (tickIntervalMs) {
      this.tickTimer = setInterval(() => {
        if (this.running) {
          this.tick();
        }
      }, tickIntervalMs);
    }
  }

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
    this.reviseBeliefs(this.perceive());
    // After the revision that decided them, so the goal id an `agree` names is
    // always one the receiver already holds.
    await this.flushDirectiveAnswers();
    this.deliberate();
    await this.meansEndsReasoning();
    await this.execute();
    // Before collection: refusing a sub-goal fails the parent waiting on it, and
    // that cascade has to run while the parent is still waiting. Collection
    // would otherwise release the parent as if the sub-goal had succeeded.
    await this.reportRejections();
    // Last, so the whole event sequence of the jobs that finished this cycle —
    // including the `intention:completed` handlers that still expect to read
    // their goal — is delivered before anything is collected.
    this.collectFinished();
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
   * folding them into beliefs would let a belief-triggered plan fire off a
   * bookkeeping message. Correlating ids to threads is the caller's job.
   *
   * Handlers run synchronously, so they must not block. Goal events arrive
   * whether or not the agent is running, and everything here covers only this
   * agent's own work — for what every agent on a bus does, subscribe to
   * `__failure__` and `__goal_achieved__` instead.
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
  }

  /**
   * A finished goal left the queue. Releases the intentions waiting on it and
   * drops the remembered status, so neither outlives the goal.
   */
  private onGoalRemoved(goal: Goal): void {
    this.lastGoalStatus.delete(goal.id);
    this.releaseWaitingParents(goal);
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
   * Reports every goal refused since the last cycle: a notice on
   * `FAILURE_TOPIC` for monitors, a `refuse` reply to whoever asked for the
   * work, and — for a refused sub-goal — the same treatment its parent gets
   * when a sub-goal it was waiting for fails.
   *
   * The reply is a `refuse` rather than the `failure` this library once sent:
   * a goal shed for capacity was declined, not attempted and abandoned. The
   * topic notice stays an `inform`, since it is a report about the agent
   * rather than an answer to anyone.
   */
  private async reportRejections(): Promise<void> {
    if (this.pendingRejections.length === 0) {
      return;
    }

    const rejections = this.pendingRejections;
    this.pendingRejections = [];

    for (const { goal, reason } of rejections) {
      await this.publishRejection(goal, reason);

      const sender = goal.source?.sender;
      if (sender && sender !== this.id) {
        await this.sendRefusalReply(goal, sender, reason);
      }

      if (goal.parentGoalId) {
        await this.failWaitingParents(goal, reason);
      }
    }
  }

  /**
   * Announces a refused goal on `FAILURE_TOPIC`. Mirrors a failure notice, minus
   * the fields that need an intention: a refused goal never had one, so it
   * carries no `intentionId`, `plan` or `action`. `rejected: true` is what tells
   * a monitor this is backpressure rather than a broken job.
   */
  private async publishRejection(goal: Goal, reason: string): Promise<void> {
    try {
      await this.publishMessage(FAILURE_TOPIC, {
        performative: "inform",
        sender: this.id,
        topic: FAILURE_TOPIC,
        content: {
          [`failure.${this.id}`]: {
            agentId: this.id,
            goalId: goal.id,
            goal: goal.name,
            status: "failed",
            rejected: true,
            maxGoals: this.config.maxGoals,
            reason,
            ...(goal.parentGoalId
              ? { parentGoalId: goal.parentGoalId, rootGoalId: goal.rootGoalId }
              : {}),
            ...(goal.source ? { source: goal.source } : {}),
          },
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${this.id}] Failed to publish goal rejection notification:`,
        error,
      );
    }
  }

  /** Tells the requester its goal was declined, since no `agree` went out. */
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
          // Distinguishes a decline from the `detail` of one: this goal was
          // shed by the queue's own bound, whatever the human-readable reason
          // says.
          reason: "capacity",
          detail: reason,
          ...(source?.conversationId
            ? { conversationId: source.conversationId }
            : {}),
          ...(source?.messageId ? { messageId: source.messageId } : {}),
        },
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
   * Sends through the bus and reports the message as sent. The event waits for
   * the bus to accept the message, so a monitor never sees traffic that did
   * not go out.
   */
  private async sendMessage(agentId: string, message: Message): Promise<void> {
    await this.bus.send(agentId, message);
    this.emitter.emit("message:sent", message);
  }

  private async publishMessage(topic: string, message: Message): Promise<void> {
    await this.bus.publish(topic, message);
    this.emitter.emit("message:sent", message);
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
   * - a **directive** is the one performative with a compelled hearer effect,
   *   so it is offered to the goal queue — and only because this library
   *   chooses to comply. FIPA leaves the receiver free to `refuse`, and a
   *   directive can come back declined, for want of capacity or for want of a
   *   plan, before a goal ever exists.
   * - an **assertion** has no hearer effect at all, so becoming a belief is a
   *   decision the agent makes under its `informs` policy, never a
   *   consequence of having received it.
   * - everything else — an expressive, a commissive, a library performative
   *   with no CA class — is about the conversation rather than the world, and
   *   produces no state.
   *
   * A performative can be both, and then both happen: `request-when` asks for
   * an action *and* asserts the condition under which it applies, so it
   * becomes a goal and its condition is offered to the belief base. Dropping
   * the assertion would leave the receiver working on a condition it never
   * recorded.
   */
  private reviseBeliefs(percepts: InboxEntry[]): void {
    for (const { message } of percepts) {
      // The answer to a directive, before anything about the world: an
      // agreement or refusal is bookkeeping about a conversation, and must not
      // reach the belief base even though both are class-assertive.
      if (message.performative === "agree") {
        this.handleAgreement(message);
        continue;
      }

      if (message.performative === "refuse") {
        this.handleRefusalMessage(message);
        continue;
      }

      if (directsAction(message.performative)) {
        this.considerDirective(
          message,
          directivePriority(message.performative) ?? 5,
        );
      }

      if (isPropositional(message.performative)) {
        this.ingestAssertion(message);
      }
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
   * Absent a `canAccept` predicate, the agent agrees to every well-formed
   * directive it has capacity for and declines only on capacity. That is a
   * choice, not a rule of FIPA: it is what "compliant" means for an agent that
   * has not been told otherwise.
   */
  private considerDirective(msg: Message, priority: number): void {
    const verdict = this.config.canAccept(msg);

    if (verdict !== true) {
      // Declined on the agent's own terms: the string is the reason, and it is
      // forwarded verbatim so the sender learns why rather than just that.
      this.declineDirective(msg, "predicate", {
        ...(typeof verdict === "string" ? { detail: verdict } : {}),
      });
      return;
    }

    const goalName = isRecord(msg.content)
      ? (msg.content.goal as string)
      : undefined;

    if (!goalName) {
      // Malformed: no goal named in the content, so there is nothing to agree
      // to and nothing sensible to refuse.
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
        detail: `no plan serves "${goalName}"`,
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
   * Declines a directive: reports it locally on `goal:refused`, and queues the
   * `refuse` the sender will receive.
   *
   * `send: false` reports without answering, for a decline another path has
   * already taken responsibility for answering.
   */
  private declineDirective(
    msg: Message,
    reason: RefusalReason,
    options: { detail?: string; send?: boolean } = {},
  ): void {
    if (!isRecord(msg.content)) {
      return;
    }

    const goalName = (msg.content.goal as string) ?? "";
    const refusal: GoalRefusal = {
      agentId: this.id,
      goal: goalName,
      reason,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.id ? { messageId: msg.id } : {}),
    };

    this.emitter.emit("goal:refused", refusal);

    // Answering ourselves would be noise: a subscribed agent receives its own
    // publishes, and it was never going to wait on its own agreement.
    if (options.send === false || !msg.sender || msg.sender === this.id) {
      return;
    }

    this.pendingRefusals.push({
      to: msg.sender,
      goal: goalName,
      reason,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.id ? { messageId: msg.id } : {}),
    });
  }

  /**
   * Accepts an assertion into the belief base, if the agent's policy accepts
   * this one.
   *
   * The predicate is consulted per message rather than the whole batch, so a
   * policy that looks at the sender or the content can act on it.
   */
  private ingestAssertion(msg: Message): void {
    if (!isRecord(msg.content)) {
      return;
    }

    const policy = this.config.informs;
    const accepted =
      typeof policy === "function" ? policy(msg) : policy === "beliefs";
    if (!accepted) {
      return;
    }

    const beliefKey = this.config.beliefKey;
    for (const [key, value] of Object.entries(msg.content)) {
      this.beliefs.set(beliefKey(msg, key), value);
    }
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

    const goalId = msg.content.goalId;
    if (typeof goalId !== "string" || !goalId) {
      return;
    }

    const conversationId =
      typeof msg.content.conversationId === "string"
        ? msg.content.conversationId
        : msg.conversationId;

    this.emitter.emit("goalAcknowledged", {
      agentId: msg.sender,
      goal: typeof msg.content.goal === "string" ? msg.content.goal : "",
      goalId,
      ...(conversationId ? { conversationId } : {}),
      ...(typeof msg.content.messageId === "string"
        ? { messageId: msg.content.messageId }
        : {}),
    } satisfies GoalAck);
  }

  /**
   * A `refuse` arrived for a directive this agent sent: nobody will work on it,
   * and never will.
   *
   * This is what turns a declined request from silence into an answer. Without
   * it a sender waits on a reply that is never coming, and has no way to tell
   * "declined" from "still deciding".
   *
   * Note the asymmetry with `goal:refused`, which is the same fact seen from
   * the receiving side: this one means *this* agent's request was declined.
   */
  private handleRefusalMessage(msg: Message): void {
    if (!isRecord(msg.content)) {
      return;
    }

    const goal = typeof msg.content.goal === "string" ? msg.content.goal : "";
    const rawReason = msg.content.reason;

    // A refusal from a peer that does not use this library's vocabulary is
    // still a refusal, and is still reported. Only a reason actually given is
    // believed: attributing "predicate" to a sender that never said so would
    // put a word in its mouth.
    const reason: RefusalReason | undefined =
      rawReason === "capacity" || rawReason === "predicate"
        ? rawReason
        : undefined;

    const conversationId =
      typeof msg.content.conversationId === "string"
        ? msg.content.conversationId
        : msg.conversationId;

    this.emitter.emit("goalRefused", {
      agentId: msg.sender,
      goal,
      ...(reason ? { reason } : {}),
      ...(typeof msg.content.detail === "string"
        ? { detail: msg.content.detail }
        : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(typeof msg.content.messageId === "string"
        ? { messageId: msg.content.messageId }
        : {}),
    } satisfies GoalRefusal);
  }

  /**
   * Turns a `request`/`achieve` into a goal, recording where it came from so
   * the sender can follow it through decomposition and failure notices.
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
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.id ? { messageId: msg.id } : {}),
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

    // The agreement is *not* queued here. Admitting a goal says the agent will
    // consider the request, not that it has committed to it: the plan serving
    // it is only consulted in `meansEndsReasoning`, and until it returns a
    // willing verdict the agent may yet decline. Agreeing on admission would
    // put an `agree` ahead of a `refuse` the requester is owed instead, which
    // is the one thing a directive is supposed to never produce. The answer is
    // owed from admission, so the goal id is remembered here and settled the
    // moment a plan rules on it.
    //
    // Answering ourselves would just be noise: an agent subscribed to a
    // topic receives its own publishes.
    if (admitted && msg.sender && msg.sender !== this.id) {
      this.unacknowledged.set(goalId, {
        to: msg.sender,
        goal: goalName,
        ...(source.conversationId
          ? { conversationId: source.conversationId }
          : {}),
        ...(source.messageId ? { messageId: source.messageId } : {}),
      });
    }

    return { goalId, admitted };
  }

  /**
   * Agrees to a goal that a plan has just confirmed it will serve, unless it
   * has already been answered.
   *
   * The single place a directive-sourced goal turns into an `agree`, so a
   * requester cannot collect two answers for one request: `declineGoal` clears
   * the pending entry before it refuses, and this clears it as it agrees.
   */
  private agreeToGoal(goal: Goal): void {
    const pending = this.unacknowledged.get(goal.id);
    if (!pending) {
      return;
    }

    this.unacknowledged.delete(goal.id);
    this.pendingAcks.push({ goalId: goal.id, ...pending });
  }

  /**
   * Sends the answers to directives decided since the last cycle: an `agree` for
   * each goal taken on, a `refuse` for each declined.
   *
   * Deliveries happen here rather than in the message handler, which the bus
   * calls synchronously, so a failed send stays a catchable error instead of an
   * unhandled rejection — and so the reply to a directive leaves from a tick of
   * its own, never from inside the sender's `publish`.
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
          content: {
            goal: ack.goal,
            goalId: ack.goalId,
            ...(ack.conversationId
              ? { conversationId: ack.conversationId }
              : {}),
            ...(ack.messageId ? { messageId: ack.messageId } : {}),
          },
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error(
          `[${this.id}] Failed to agree to goal ${ack.goalId} with ${ack.to}:`,
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
          content: {
            goal: refusal.goal,
            reason: refusal.reason,
            ...(refusal.detail ? { detail: refusal.detail } : {}),
            ...(refusal.conversationId
              ? { conversationId: refusal.conversationId }
              : {}),
            ...(refusal.messageId ? { messageId: refusal.messageId } : {}),
          },
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error(
          `[${this.id}] Failed to refuse goal ${refusal.goal} for ${refusal.to}:`,
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
    // A goal the queue has forgotten cannot be answered any more, so it must
    // not keep an entry alive in the pending map.
    for (const goalId of [...this.unacknowledged.keys()]) {
      if (!this.goals.get(goalId)) {
        this.unacknowledged.delete(goalId);
      }
    }
  }

  /**
   * Promotes the highest-priority eligible pending goal to active.
   *
   * Only this. Work starts because a goal says it should, never because a
   * belief happened to make some plan's trigger fire: a plan that ran with no
   * goal behind it could not say what it was for, could not be correlated with
   * the request that occasioned it, and could not be declined.
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
      // these goals would be the ones that leak.
      if (!this.planLibrary.declares(goal.name)) {
        this.declineGoal(goal, "no-plan", `no plan serves "${goal.name}"`);
        continue;
      }

      const match = this.planLibrary.match(this.beliefs, goal);

      if (match?.plan) {
        // A willing plan is what turns a request into a commitment, so this is
        // where the agreement is owed — never at admission, where the agent
        // had not yet consulted the plan.
        this.agreeToGoal(goal);

        const intention = createIntention(goal, match.plan);
        intention.status = "executing";
        this.intentions.push(intention);
        this.emitter.emit("intention:started", intention);
        continue;
      }

      if (match?.refusal) {
        // A plan declared this goal and declined this instance. Unlike a goal
        // that is merely waiting on a belief, this is a decision, so the goal
        // is released rather than left to be reconsidered forever.
        this.declineGoal(
          goal,
          match.refusal.reason ?? "predicate",
          match.refusal.detail,
        );
      }

      // No plan willing yet: the goal waits, re-evaluated every cycle, and
      // becomes servable if the belief it was missing arrives.
    }
  }

  /**
   * Declines a goal that is already in the queue: reports the refusal to
   * whoever asked for the work, fails the goal so its slot is released, and
   * fails any parent that was waiting on it.
   *
   * Used for the refusals that can only be reached once a goal exists — a plan
   * declining a particular instance, or a sub-goal no plan serves. The
   * requester is answered even when there is no plan involved, because a
   * sub-goal's requester is whoever asked for its parent.
   */
  private declineGoal(
    goal: Goal,
    reason: RefusalReason,
    detail?: string,
  ): void {
    const refusal: GoalRefusal = {
      agentId: this.id,
      goal: goal.name,
      reason,
      ...(detail ? { detail } : {}),
      ...(goal.source?.conversationId
        ? { conversationId: goal.source.conversationId }
        : {}),
      ...(goal.source?.messageId ? { messageId: goal.source.messageId } : {}),
    };
    this.emitter.emit("goal:refused", refusal);

    // Whatever agreement this goal still owed is not owed now: the answer to
    // the request is the refusal below, and the two together would be two
    // answers to one directive.
    this.unacknowledged.delete(goal.id);

    if (goal.source?.sender && goal.source.sender !== this.id) {
      this.pendingRefusals.push({
        to: goal.source.sender,
        goal: goal.name,
        reason,
        ...(detail ? { detail } : {}),
        ...(goal.source.conversationId
          ? { conversationId: goal.source.conversationId }
          : {}),
        ...(goal.source.messageId ? { messageId: goal.source.messageId } : {}),
      });
    }

    // Terminal, so `collectFinished` releases the slot this cycle. Leaving it
    // active would let an unservable goal hold capacity indefinitely.
    this.goals.setStatus(goal.id, "failed");

    if (goal.parentGoalId) {
      void this.failWaitingParents(goal, detail ?? reason);
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
    const action = intention.plan.body[intention.actionIndex];
    if (!action) {
      this.completeIntention(intention, intention.result ?? {});
      await this.publishAchieved(intention, intention.result ?? {});
      return;
    }

    let result: ActionResult | undefined;
    try {
      result = await action.execute(intention, this.beliefs);

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

      const nextAction = intention.plan.body[intention.actionIndex];
      if (!nextAction) {
        this.completeIntention(intention, result);
        await this.publishAchieved(intention, result);
        return;
      }

      if (hasChildren) {
        this.intentions.setStatus(intention.id, "waiting");
        this.emitter.emit("intention:waiting", {
          intention,
          children: [...intention.children],
        } satisfies IntentionWaiting);
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
    this.goals.setStatus(intention.goal.id, "failed");
    this.emitter.emit("intention:failed", {
      intention,
      reason,
    } satisfies IntentionFailed);
    this.dropDependentGoals(intention.goal.id);
    await this.publishFailure(intention, reason);
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
      if (parent.plan.onChildFailure === "continue") {
        this.resumeAfterChildFailure(parent, {
          goalId: child.id,
          goal: child.name,
          reason,
        });
        continue;
      }

      await this.failIntention(
        parent,
        `sub-goal "${child.name}" failed: ${reason}`,
      );
    }
  }

  /**
   * Recovery path for plans with `onChildFailure: "continue"`. The failed
   * sub-goal leaves the pending set, the reason is kept for the next action to
   * read, and the parent resumes once no sub-goal is outstanding.
   */
  private resumeAfterChildFailure(
    intention: Intention,
    failure: ChildFailure,
  ): void {
    intention.children = intention.children.filter(
      (id) => id !== failure.goalId,
    );
    intention.childFailures.push(failure);

    if (intention.children.length === 0) {
      this.intentions.setStatus(intention.id, "executing");
    }
  }

  private async publishFailure(
    intention: Intention,
    reason: string,
  ): Promise<void> {
    const goal = this.goals.get(intention.goal.id) ?? intention.goal;
    try {
      await this.publishMessage(FAILURE_TOPIC, {
        performative: "inform",
        sender: this.id,
        topic: FAILURE_TOPIC,
        content: {
          [`failure.${this.id}`]: {
            agentId: this.id,
            intentionId: intention.id,
            goalId: intention.goal.id,
            goal: intention.goal.name,
            plan: intention.plan.name,
            action: intention.plan.body[intention.actionIndex]?.name,
            reason,
            ...(goal.parentGoalId
              ? {
                  parentGoalId: goal.parentGoalId,
                  rootGoalId: goal.rootGoalId,
                }
              : {}),
            // Carries the originating sender (and conversation) so a monitor
            // can attribute a failure to whoever asked for the work.
            ...(goal.source ? { source: goal.source } : {}),
          },
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${this.id}] Failed to publish failure notification:`,
        error,
      );
    }
  }

  /**
   * Announces a goal reaching `achieved` on `GOAL_ACHIEVED_TOPIC`, mirroring
   * the failure notice: the same namespacing under `achieved.<agentId>`, the
   * same lineage and `source` fields, and the result of the last action.
   */
  private async publishAchieved(
    intention: Intention,
    result: ActionResult,
  ): Promise<void> {
    const goal = this.goals.get(intention.goal.id) ?? intention.goal;
    try {
      await this.publishMessage(GOAL_ACHIEVED_TOPIC, {
        performative: "inform",
        sender: this.id,
        topic: GOAL_ACHIEVED_TOPIC,
        content: {
          [`achieved.${this.id}`]: {
            agentId: this.id,
            intentionId: intention.id,
            goalId: intention.goal.id,
            goal: intention.goal.name,
            plan: intention.plan.name,
            // The action that ran last, which is one before the current index:
            // the index has already advanced past the plan's final action.
            action: intention.plan.body[intention.actionIndex - 1]?.name,
            status: "achieved",
            result,
            ...(goal.parentGoalId
              ? {
                  parentGoalId: goal.parentGoalId,
                  rootGoalId: goal.rootGoalId,
                }
              : {}),
            // Carries the originating sender (and conversation) so a monitor
            // can attribute a completion to whoever asked for the work.
            ...(goal.source ? { source: goal.source } : {}),
          },
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${this.id}] Failed to publish goal achieved notification:`,
        error,
      );
    }
  }

  private async applyActionResult(
    result: ActionResult,
    intention: Intention,
  ): Promise<boolean> {
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

    let hasChildren = false;
    if (result.newGoals) {
      const childIds: string[] = [];
      for (const goal of result.newGoals) {
        const childId = `goal-${randomUUID()}`;
        childIds.push(childId);
        this.goals.add({
          id: childId,
          name: goal.name,
          priority: goal.priority,
          status: "pending",
          data: goal.data,
          parentGoalId: intention.goal.id,
          rootGoalId: intention.goal.rootGoalId ?? intention.goal.id,
          // Inherited so the original sender stays traceable however deep the
          // decomposition goes.
          ...(intention.goal.source ? { source: intention.goal.source } : {}),
        });
      }
      if (childIds.length > 0) {
        intention.children.push(...childIds);
        hasChildren = true;
      }
    }

    if (result.messages) {
      for (const msg of result.messages) {
        if (msg.topic !== undefined) {
          await this.publishMessage(msg.topic, {
            performative: msg.performative,
            sender: this.id,
            topic: msg.topic,
            content: msg.content,
            timestamp: Date.now(),
          });
        } else if (msg.receiver !== undefined) {
          await this.sendMessage(msg.receiver, {
            performative: msg.performative,
            sender: this.id,
            receiver: msg.receiver,
            content: msg.content,
            timestamp: Date.now(),
          });
        } else {
          throw new Error(
            "ActionResult message must specify a topic or a receiver",
          );
        }
      }
    }

    return hasChildren;
  }

  private dropDependentGoals(failedGoalId: string): void {
    for (const goal of this.goals.getUnfinished()) {
      if (goal.dependsOn?.includes(failedGoalId)) {
        this.goals.setStatus(goal.id, "dropped");
      }
    }
  }

  /**
   * Releases the intentions waiting on a sub-goal that has just left the queue,
   * whether it succeeded or not, so a parent never waits on a goal that is gone.
   *
   * Driven by collection rather than by a sweep over every waiting intention:
   * the sub-goal knows its parent, and the parent knows its own goal, so both
   * lookups are direct. A parent with no sub-goal left outstanding resumes.
   */
  private releaseWaitingParents(child: Goal): void {
    if (!child.parentGoalId) {
      return;
    }

    for (const intention of this.intentions.getByGoal(child.parentGoalId)) {
      if (intention.status !== "waiting") {
        continue;
      }

      const index = intention.children.indexOf(child.id);
      if (index === -1) {
        continue;
      }

      intention.children.splice(index, 1);
      if (intention.children.length === 0) {
        this.intentions.setStatus(intention.id, "executing");
      }
    }
  }

  private onBeliefChange(): void {
    if (!this.config.enableIntentionReconsideration) return;

    for (const intention of this.intentions.getActive()) {
      if (intention.status === "executing" && intention.actionIndex > 0) {
        const plan = this.planLibrary.findApplicable(
          this.beliefs,
          intention.goal,
        );
        if (!plan || plan.name !== intention.plan.name) {
          this.intentions.drop(intention.id);
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
