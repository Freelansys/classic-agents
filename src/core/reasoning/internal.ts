import type { Message, Performative } from "../../bus/index.js";
import type { Goal } from "../goals.js";
import type { RefusalVerdict } from "../plans.js";
import type { Agent } from "./agent.js";

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
  /** The cancel's `reply-by`, and the same as epoch milliseconds. */
  replyBy?: string;
  deadline?: number;
  /**
   * Sent for a delegation this agent stopped waiting for. Once the cancel is
   * settled any way but `inform`, nothing here wants the request any more,
   * so it stops being tracked too, rather than waiting on a final reply that
   * an unresponsive delegate may never send.
   */
  abandoned?: boolean;
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
 * The methods used by internal modules that stay `protected` on the Agent
 * class so subclasses keep overriding them. Exposed here purely so a module
 * function can call them on an Agent instance it does not subclass.
 */
/** @internal */
interface DirectiveHost {
  considerDirective(msg: Message, priority: number): Promise<void>;
  handleUnsupportedDirective(msg: Message): Promise<void>;
  declineDirective(
    msg: Message,
    verdict: RefusalVerdict,
    options: { reason?: string; send?: boolean },
  ): void;
  markRequestIntention(
    receiver: string,
    content: unknown,
    exchange?: string,
  ): void;
}

/** @internal */
export function asDirectiveHost(agent: Agent): DirectiveHost {
  return agent as unknown as DirectiveHost;
}

export type {
  AwaitedReply,
  DirectiveHost,
  DirectiveOutcome,
  OpenRequest,
  PendingAgreement,
  PendingAnswer,
  PendingCancel,
  PendingOutcome,
  PendingQuery,
  PendingRefusal,
  PendingRejection,
  QueuedCancel,
  SentRequest,
  StandingCommitment,
  Withdrawal,
};
