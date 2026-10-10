import { randomUUID } from "node:crypto";
import type { Message } from "../../bus/index.js";
import {
  directsAction,
  hasHearerEffect,
  isQueryDirective,
} from "../../bus/performatives.js";
import type { Goal } from "../goals.js";
import type { Agent } from "./agent.js";
import { isRecord, replyAddress } from "./helpers.js";
import { asDirectiveHost } from "./internal.js";

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
export function exchangeKey(
  _agent: Agent,
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
 * Tells the requester its goal was declined, since no `agree` went out. Only
 * ever a root goal's requester: see {@link reportRejections}.
 */
export async function sendRefusalReply(
  agent: Agent,
  goal: Goal,
  to: string,
  reason: string,
): Promise<void> {
  const source = goal.source;
  try {
    await agent.sendMessage(to, {
      performative: "refuse",
      sender: agent.id,
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
      `[${agent.id}] Failed to report goal rejection to ${to}:`,
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
export function sendNotUnderstood(
  agent: Agent,
  msg: Message,
  reason: string,
): void {
  // Callers guard this too, to decide their own control flow; the guard here
  // is what makes the helper safe to reach from a site that forgets it. A
  // message with no sender cannot be answered, and answering ourselves is
  // the loop the outer guards exist to prevent.
  const to = replyAddress(msg);
  if (!msg.sender || msg.sender === agent.id || !to || to === agent.id) {
    return;
  }
  void agent.sendMessage(to, {
    performative: "not-understood",
    sender: agent.id,
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
export async function sendMessage(
  agent: Agent,
  agentId: string,
  message: Message,
  options: { replyBy?: null } = {},
): Promise<Message> {
  // A directive gets the agent's default `reply-by` unless it set its own,
  // or opted out with `replyBy: null`. Anything else expects no reply, so a
  // deadline on it would mean nothing.
  const timeoutMs = agent.config.replyTimeoutMs;
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
    stamped.replyTo === undefined || stamped.replyTo === agent.id;

  // A conditional request is a request too: its `agree` promotes the same
  // `intent.*` belief, it just fires later.
  const isRequest =
    stamped.performative === "request" ||
    stamped.performative === "request-when" ||
    stamped.performative === "request-whenever";
  if (isRequest && repliesHere && stamped.receiver !== undefined) {
    asDirectiveHost(agent).markRequestIntention(
      stamped.receiver,
      stamped.content,
      exchange,
    );
    const goal = isRecord(stamped.content) ? stamped.content.goal : undefined;
    if (typeof goal === "string" && goal) {
      agent.sentRequests.set(exchange, {
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
    agent.markPendingQuery(agentId, stamped);
  }
  if ((isRequest || isQuestion) && repliesHere && replyBy !== undefined) {
    agent.awaitReply(agentId, stamped, replyBy);
  }
  // A cancel of one of our own requests or subscriptions is tracked until
  // its reply says whether it took: only an `inform` ends the request here.
  // Until then the request stays open, so its own replies still land.
  if (stamped.performative === "cancel" && stamped.inReplyTo !== undefined) {
    // A cancel expects an answer (`inform` or `failure`), so it is held to
    // a `reply-by` like a directive: past it, the cancel is settled as
    // unanswered rather than tracked for ever.
    const cancelReplyBy =
      stamped.replyBy ??
      (options.replyBy !== null && timeoutMs > 0
        ? new Date(Date.now() + timeoutMs).toISOString()
        : undefined);
    if (cancelReplyBy !== undefined && stamped.replyBy === undefined) {
      stamped.replyBy = cancelReplyBy;
    }
    const deadline =
      cancelReplyBy !== undefined ? Date.parse(cancelReplyBy) : NaN;
    const timing = Number.isNaN(deadline)
      ? {}
      : { replyBy: cancelReplyBy!, deadline };
    const request = agent.sentRequests.get(stamped.inReplyTo);
    const subscription = agent.pendingQueries.get(stamped.inReplyTo);
    if (request?.peer === agentId) {
      agent.pendingCancels.set(exchange, {
        peer: agentId,
        target: stamped.inReplyTo,
        kind: "request",
        name: request.goal,
        ...timing,
      });
    } else if (subscription?.standing && subscription.peer === agentId) {
      agent.pendingCancels.set(exchange, {
        peer: agentId,
        target: stamped.inReplyTo,
        kind: "subscription",
        name: subscription.name,
        ...timing,
      });
    }
  }
  await agent.bus.send(agentId, stamped);
  agent.emitter.emit("message:sent", stamped);
  return stamped;
}

/**
 * Starts the clock on a directive's first reply. Any reply from the peer
 * naming the directive stops it (see `reviseBeliefs`); if `replyBy` passes
 * first, {@link expireReplies} closes the exchange as unanswered.
 */
export function awaitReply(
  agent: Agent,
  peer: string,
  directive: Message,
  replyBy: string,
): void {
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

  agent.awaitingReply.set(exchange, {
    peer,
    performative: directive.performative,
    name,
    exchange,
    replyBy,
    deadline,
    ...(isRequest
      ? { key: agent.exchangeKey("intent", peer, name, exchange) }
      : {}),
  });
}

export async function publishMessage<T>(
  agent: Agent,
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
  await agent.bus.publish(topic, stamped);
  agent.emitter.emit("message:sent", stamped);
  return stamped;
}
