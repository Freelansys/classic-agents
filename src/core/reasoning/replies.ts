import type { Message } from "../../bus/index.js";
import { schemaViolationReason, validateContent } from "../../bus/schemas.js";
import type { RefusalVerdict } from "../plans.js";
import type { Agent } from "./agent.js";
import { isDone, isRecord, isRefusalVerdict } from "./helpers.js";
import type { PendingCancel, SentRequest } from "./internal.js";
import type { DelegationSettled, GoalAck, GoalRefusal } from "./types.js";

/**
 * An `agree` arrived for a directive this agent sent: the receiver has the
 * goal and will work on it.
 *
 * Reports the id the receiver actually assigned rather than the one requested,
 * so a sender whose pin lost a race can follow the right goal instead of
 * tracking one it cannot name.
 */
/** @internal */
export function handleAgreement(agent: Agent, msg: Message): void {
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
    msg.sender !== agent.id
  ) {
    const reason = schemaViolationReason(msg.performative, msg.content);
    agent.sendNotUnderstood(msg, reason);
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

  agent.emitter.emit("goalAcknowledged", {
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
      ? agent.remoteDelegations.get(msg.inReplyTo)
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
    agent.beliefs.setStatus(
      agent.exchangeKey(
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
/** @internal */
export async function handleRefusalMessage(
  agent: Agent,
  msg: Message,
): Promise<void> {
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
    msg.sender !== agent.id
  ) {
    const reason = schemaViolationReason(msg.performative, msg.content);
    agent.sendNotUnderstood(msg, reason);
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

  agent.emitter.emit("goalRefused", {
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
    agent.beliefs.setStatus(
      agent.exchangeKey("intent", msg.sender, goal, exchange),
      "negative",
    );
    agent.beliefs.set(
      agent.exchangeKey("infeasible", msg.sender, goal, exchange),
      { verdict, reason },
      "negative",
    );
  }

  // A refused request is over; nothing more will answer it.
  const sent = agent.sentRequestFor(msg);
  if (sent) {
    await agent.endSentRequest(sent.exchange, {
      failed: `refused${verdict ? ` (${verdict})` : ""}${reason ? `: ${reason}` : ""}`,
    });
  }
}

/** The cancel this reply answers, if any, from the agent it was sent to. */
/** @internal */
export function pendingCancelFor(
  agent: Agent,
  msg: Message,
): PendingCancel | undefined {
  if (!msg.inReplyTo) return undefined;
  const pending = agent.pendingCancels.get(msg.inReplyTo);
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
/** @internal */
export async function settleCancelReply(
  agent: Agent,
  msg: Message,
  pending: PendingCancel,
): Promise<void> {
  agent.pendingCancels.delete(msg.inReplyTo!);
  const content = isRecord(msg.content) ? msg.content : {};
  const reason =
    typeof content.reason === "string" ? content.reason : undefined;

  if (msg.performative !== "inform") {
    agent.beliefs.set(
      agent.exchangeKey(
        "cancel-failed",
        pending.peer,
        pending.name,
        pending.target,
      ),
      { performative: msg.performative, ...(reason ? { reason } : {}) },
      "positive",
    );
    if (pending.abandoned) {
      await agent.endSentRequest(pending.target, { failed: "cancelled" });
    }
    return;
  }

  // The cancel took whether or not its `inform` is believed: the peer has
  // stopped and will say nothing more about the request.
  if (pending.kind === "request") {
    await agent.endSentRequest(pending.target, { failed: "cancelled" });
  }
  await agent.ingestAssertion(msg, () => {
    const key = agent.exchangeKey(
      "cancelled",
      pending.peer,
      pending.name,
      pending.target,
    );
    agent.beliefs.set(key, content, "positive");
    if (pending.kind === "request") {
      agent.beliefs.remove(
        agent.exchangeKey("intent", pending.peer, pending.name, pending.target),
      );
    } else {
      agent.pendingQueries.delete(pending.target);
    }
    agent.awaitingReply.delete(pending.target);
    return { keys: [key], status: "positive" };
  });
}

/**
 * The request this reply answers, if any: it names one of this agent's open
 * requests as `inReplyTo` and comes from the agent that was asked.
 */
/** @internal */
export function sentRequestFor(
  agent: Agent,
  msg: Message,
): SentRequest | undefined {
  if (!msg.inReplyTo) return undefined;
  const sent = agent.sentRequests.get(msg.inReplyTo);
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
/** @internal */
export async function settleRequestInform(
  agent: Agent,
  msg: Message,
  sent: SentRequest,
): Promise<void> {
  const content = msg.content;
  const standing = sent.performative === "request-whenever";
  if (!isDone(content)) {
    const believed = await agent.ingestAssertion(msg, () => {
      const key = agent.exchangeKey(
        "result",
        sent.peer,
        sent.goal,
        sent.exchange,
      );
      agent.beliefs.set(key, content, "positive");
      return { keys: [key], status: "positive" };
    });
    // A note on a delegation is also kept on its record, where the plan and
    // a monitor can read it without building the belief key.
    const delegated = agent.remoteDelegations.get(sent.exchange);
    if (believed && delegated) {
      delegated.delegation.progress = content;
      agent.emitter.emit("delegation:progress", {
        intention: delegated.intention,
        delegation: { ...delegated.delegation },
      } satisfies DelegationSettled);
    }
    return;
  }

  const believed = await agent.ingestAssertion(msg, () => {
    const key = agent.exchangeKey("done", sent.peer, sent.goal, sent.exchange);
    agent.beliefs.set(key, content, "positive");
    if (!standing) {
      agent.beliefs.remove(
        agent.exchangeKey("intent", sent.peer, sent.goal, sent.exchange),
      );
    }
    return { keys: [key], status: "positive" };
  });
  // The request is over whether or not the middleware believed the peer:
  // it has sent its terminal reply and will send no other. What the
  // middleware decides is only whether this agent takes the work as done —
  // a delegation whose result it will not believe has failed.
  if (!standing) {
    await agent.endSentRequest(
      sent.exchange,
      believed
        ? { done: isRecord(content) ? content.result : undefined }
        : { failed: "result not accepted by belief middleware" },
    );
  }
}

/** @internal */
export async function handleFailureMessage(
  agent: Agent,
  msg: Message,
): Promise<void> {
  if (!isRecord(msg.content)) {
    return;
  }

  const goal = typeof msg.content.goal === "string" ? msg.content.goal : "";
  const sender = msg.sender;
  if (!goal || !sender) {
    // A failure that names no goal answers nothing this agent can file it
    // under, so it is an ordinary claim on the ordinary path.
    await agent.ingestAssertion(msg);
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
  const sent = agent.sentRequestFor(msg);
  const standing = sent?.performative === "request-whenever";
  await agent.ingestAssertion(msg, () => {
    const failedKey = agent.exchangeKey("failed", sender, goal, exchange);
    agent.beliefs.set(failedKey, { reason }, "positive");
    const keys = [failedKey];
    if (!standing) {
      const intentKey = agent.exchangeKey("intent", sender, goal, exchange);
      if (agent.beliefs.setStatus(intentKey, "negative")) {
        keys.push(intentKey);
      }
    }
    return { keys, status: "positive" };
  });
  // Closed whether or not the failure is believed: the peer has given up
  // either way, and will send nothing more for this request.
  if (sent && !standing) {
    await agent.endSentRequest(sent.exchange, { failed: reason ?? "failed" });
  }
}

/** @internal */
export async function handleNotUnderstoodMessage(
  agent: Agent,
  msg: Message,
): Promise<void> {
  // A request the peer could not read will not be answered either.
  const sent = agent.sentRequestFor(msg);
  if (sent) {
    const reason =
      isRecord(msg.content) && typeof msg.content.reason === "string"
        ? msg.content.reason
        : undefined;
    await agent.endSentRequest(sent.exchange, {
      failed: `not understood${reason ? `: ${reason}` : ""}`,
    });
  }

  if (!isRecord(msg.content)) {
    return;
  }

  // Same shape as `failure`: an inform about a perceived problem, so it goes
  // through the standard assertion path and also stores a semantic record.
  await agent.ingestAssertion(msg);

  const event = typeof msg.content.event === "string" ? msg.content.event : "";
  if (event && msg.sender) {
    agent.beliefs.set(
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
