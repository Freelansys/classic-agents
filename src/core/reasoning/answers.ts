import type { Goal } from "../goals.js";
import type { RefusalVerdict } from "../plans.js";
import type { Agent } from "./agent.js";
import { replyAddress } from "./helpers.js";
import type { GoalRefusal, ReplyTimeout } from "./types.js";

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
export async function expireReplies(agent: Agent): Promise<void> {
  const now = Date.now();
  for (const [exchange, pending] of [...agent.pendingCancels]) {
    if (pending.deadline === undefined || pending.deadline > now) continue;
    agent.pendingCancels.delete(exchange);
    agent.beliefs.set(
      agent.exchangeKey(
        "cancel-failed",
        pending.peer,
        pending.name,
        pending.target,
      ),
      { performative: "timeout", reason: `no reply by ${pending.replyBy}` },
      "positive",
    );
    if (pending.abandoned) {
      await agent.endSentRequest(pending.target, { failed: "cancelled" });
    }
    agent.emitter.emit("reply:timeout", {
      agentId: agent.id,
      peer: pending.peer,
      performative: "cancel",
      name: pending.name,
      exchange,
      replyBy: pending.replyBy!,
    } satisfies ReplyTimeout);
  }
  for (const awaited of [...agent.awaitingReply.values()]) {
    if (awaited.deadline > now) continue;
    agent.awaitingReply.delete(awaited.exchange);

    const pending = agent.pendingQueries.get(awaited.exchange);
    if (pending) {
      agent.pendingQueries.delete(awaited.exchange);
      agent.beliefs.remove(pending.key);
    }
    if (awaited.key && agent.beliefs.statusOf(awaited.key) === "uncertain") {
      agent.beliefs.remove(awaited.key);
    }
    await agent.endSentRequest(awaited.exchange, {
      failed: `no reply by ${awaited.replyBy}`,
    });
    agent.beliefs.set(
      agent.exchangeKey(
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
    agent.emitter.emit("reply:timeout", {
      agentId: agent.id,
      peer: awaited.peer,
      performative: awaited.performative,
      name: awaited.name,
      exchange: awaited.exchange,
      replyBy: awaited.replyBy,
    } satisfies ReplyTimeout);
  }
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
export async function reportRejections(agent: Agent): Promise<void> {
  if (agent.pendingRejections.length === 0) {
    return;
  }

  const rejections = agent.pendingRejections;
  agent.pendingRejections = [];

  for (const { goal, reason } of rejections) {
    const to = goal.source ? replyAddress(goal.source) : "";
    if (
      !goal.parentGoalId &&
      goal.source?.sender !== agent.id &&
      to &&
      to !== agent.id
    ) {
      await agent.sendRefusalReply(goal, to, reason);
    }

    if (goal.parentGoalId) {
      await agent.failWaitingParents(goal, reason);
    }
  }
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
export async function flushDirectiveAnswers(agent: Agent): Promise<void> {
  const agreements = agent.pendingAcks;
  const refusals = agent.pendingRefusals;
  agent.pendingAcks = [];
  agent.pendingRefusals = [];

  for (const ack of agreements) {
    try {
      await agent.sendMessage(ack.to, {
        performative: "agree",
        sender: agent.id,
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
        `[${agent.id}] Failed to agree to ${ack.goalId ?? ack.name ?? ack.goal} with ${ack.to}:`,
        error,
      );
    }
  }

  for (const refusal of refusals) {
    try {
      await agent.sendMessage(refusal.to, {
        performative: "refuse",
        sender: agent.id,
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
        `[${agent.id}] Failed to refuse ${refusal.query !== undefined ? `query ${refusal.query}` : `goal ${refusal.goal}`} for ${refusal.to}:`,
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
export function queueOutcome(agent: Agent, goal: Goal): void {
  const reason = agent.goalEndReasons.get(goal.id);
  agent.goalEndReasons.delete(goal.id);

  if (goal.parentGoalId) {
    return;
  }

  const open = agent.openRequests.get(goal.id);
  if (!open) {
    return;
  }
  agent.openRequests.delete(goal.id);

  const achieved = goal.status === "achieved";
  if (achieved && open.informed) {
    return;
  }
  const result = achieved ? agent.goalResults.get(goal.id) : undefined;
  agent.pendingOutcomes.push({
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
export async function flushTerminalAnswers(agent: Agent): Promise<void> {
  const outcomes = agent.pendingOutcomes;
  agent.pendingOutcomes = [];

  for (const outcome of outcomes) {
    try {
      await agent.sendMessage(outcome.to, {
        performative: outcome.performative,
        sender: agent.id,
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
        `[${agent.id}] Failed to report the outcome of ${outcome.goal} to ${outcome.to}:`,
        error,
      );
    }
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
export function declineGoal(
  agent: Agent,
  goal: Goal,
  verdict: RefusalVerdict,
  reason?: string,
): void {
  const refusal: GoalRefusal = {
    agentId: agent.id,
    goal: goal.name,
    verdict,
    ...(reason ? { reason } : {}),
    ...(goal.source?.conversationId
      ? { conversationId: goal.source.conversationId }
      : {}),
    ...(goal.source?.inReplyTo ? { inReplyTo: goal.source.inReplyTo } : {}),
  };
  agent.emitter.emit("goal:refused", refusal);

  const to = goal.source ? replyAddress(goal.source) : "";
  if (
    !goal.parentGoalId &&
    goal.source &&
    goal.source.sender !== agent.id &&
    to &&
    to !== agent.id
  ) {
    agent.pendingRefusals.push({
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
    agent.openRequests.delete(goal.id);
  }

  // Terminal, so `collectFinished` releases the slot this cycle. Leaving it
  // active would let an unservable goal hold capacity indefinitely. The
  // reason is recorded first so a requester that was agreed to — which this
  // path cannot reach, but the terminal transition does not know that — would
  // be told why rather than left with a bare `failure`.
  agent.goalEndReasons.set(goal.id, reason ?? verdict);
  agent.goals.setStatus(goal.id, "failed");

  if (goal.parentGoalId) {
    void agent.failWaitingParents(goal, reason ?? verdict);
  }
}
