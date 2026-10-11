import { randomUUID } from "node:crypto";
import type { Message } from "../../bus/index.js";
import type { Agent } from "./agent.js";
import { isRecord, replyAddress } from "./helpers.js";
import { asDirectiveHost } from "./internal.js";
import type { PendingProposal } from "./internal.js";
import type {
  ProposalAccepted,
  ProposalExpired,
  ProposalRejected,
  ProposalSent,
} from "./types.js";

/**
 * The participant half of the FIPA Contract Net protocol (SC00029): answering a
 * `cfp` with a `propose` (or a `refuse`), and admitting the job when an
 * `accept-proposal` names the bid.
 *
 * A bid is computed the way a query is answered: `Plan.bid` names an
 * {@link Expression} in the agent's `expressionLibrary`, evaluated with the
 * `cfp` as its message, so a bidder reads its own pricing beliefs and the
 * particulars the call named. The result is the `propose`'s `terms`. A bid of
 * `null`/`undefined` is a `refuse` with `verdict: "declined"` — "not on these
 * terms"; so is an evaluation that throws or times out. A bid is a quick read;
 * one that needs real work is out of scope.
 *
 * The participant sends no `agree` after an `accept-proposal`. Proposing was
 * the commitment, and the protocol goes straight to the final `inform` or
 * `failure` — the accepted job is an ordinary agreed request that happens to
 * have been opened by an accept rather than an `agree`.
 */

/**
 * Answers a `cfp` this agent received, after the directive middleware chain has
 * admitted it.
 *
 * The whole decision is one pass, in the order SC00029 allows a refusal: no
 * plan serves the goal (`no-plan`); the plan does not bid (`unsupported`, which
 * keeps ordinary agents' behaviour when they have not opted in); the queue is
 * full or evaluations are at their limit (`capacity`); the bid computed to
 * `null`/`undefined`, or failed (`declined`). Only the last is asynchronous:
 * the bid may take a beat to compute, so the `propose` or the `refuse` goes out
 * from the evaluation's continuation rather than from inside this call.
 */
export function answerCfp(agent: Agent, cfp: Message): void {
  const peer = cfp.sender;
  const to = replyAddress(cfp);
  const content = isRecord(cfp.content) ? cfp.content : {};
  const goal = typeof content.goal === "string" ? content.goal : "";

  // Answered ourselves would be noise, and a message with no return address
  // cannot be answered at all. `considerDirective` reaches here for every cfp
  // the middleware admitted, so guard the reply rather than the parsing.
  if (!cfp.sender || cfp.sender === agent.id || !to) {
    return;
  }

  // The bid is parked under the `cfp`'s `replyWith`, so a `cancel` naming the
  // call can withdraw it. A peer that did not stamp one still gets answered;
  // it simply has no way to cancel by id, so a private key stands in.
  const key = cfp.replyWith ?? `cfp:${agent.id}:${randomUUID()}`;

  const plan = agent.planLibrary.all().find((p) => p.name === goal);
  if (!plan) {
    decline(agent, cfp, "no-plan", `no plan serves "${goal}"`);
    return;
  }
  if (!plan.bid) {
    // Not opted in: the agent knows how to do the job but does not bid. This
    // is what keeps every agent that predates Contract Net behaving exactly as
    // it did — a `cfp` is declined, never silently taken on.
    decline(agent, cfp, "unsupported", `plan "${plan.name}" does not bid`);
    return;
  }
  if (agent.goals.atCapacity()) {
    decline(
      agent,
      cfp,
      "capacity",
      `goal queue is full (${agent.goals.unfinishedCount()} at the limit)`,
    );
    return;
  }
  if (!agent.canEvaluate()) {
    decline(
      agent,
      cfp,
      "capacity",
      `evaluation limit reached (${agent.config.maxConcurrentEvaluations} at once)`,
    );
    return;
  }

  // Held before evaluating, so a `cancel` naming the `cfp` can withdraw a bid
  // that is still being computed. The entry is keyed by the `cfp`'s `replyWith`
  // until the `propose` goes out; the continuation re-checks it is still there
  // before sending.
  const entry: PendingProposal = {
    cfp,
    peer: cfp.sender,
    plan,
    goal,
    evaluating: true,
  };
  agent.pendingProposals.set(key, entry);

  agent.startEvaluation(
    agent.expressionLibrary,
    plan.bid,
    cfp,
    async (outcome) => {
      // Withdrawn — a `cancel` removed the entry while the bid was computed, and
      // the outcome is discarded rather than sent.
      if (agent.pendingProposals.get(key) !== entry) {
        return;
      }
      if ("error" in outcome) {
        agent.pendingProposals.delete(key);
        decline(
          agent,
          cfp,
          "declined",
          `bid failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        );
        return;
      }
      const terms = outcome.value;
      if (terms === null || terms === undefined) {
        agent.pendingProposals.delete(key);
        decline(agent, cfp, "declined", `no bid for "${goal}"`);
        return;
      }

      const to = replyAddress(cfp);
      const replyBy =
        agent.config.proposalTimeoutMs > 0
          ? new Date(Date.now() + agent.config.proposalTimeoutMs).toISOString()
          : undefined;
      const sent = await agent.sendMessage(to, {
        performative: "propose",
        sender: agent.id,
        receiver: to,
        content: { goal, terms },
        ...(cfp.conversationId ? { conversationId: cfp.conversationId } : {}),
        ...(cfp.replyWith ? { inReplyTo: cfp.replyWith } : {}),
        ...(replyBy ? { replyBy } : {}),
        timestamp: Date.now(),
      });

      // Re-checked after the send: nothing can have removed it in between (the
      // bus delivers on another stack, but a cancel is only processed at the next
      // revision), but the guard costs nothing and keeps the invariant local.
      if (agent.pendingProposals.get(key) !== entry) {
        return;
      }
      entry.evaluating = false;
      entry.exchange = sent.replyWith;
      entry.terms = terms;
      if (replyBy !== undefined) {
        entry.deadline = Date.parse(replyBy);
      }

      agent.emitter.emit("proposal:sent", {
        peer: entry.peer,
        goal,
        proposalId: sent.replyWith!,
        terms,
      } satisfies ProposalSent);
    },
  );
}

/**
 * Admits the job a winning bid was awarded, on an `accept-proposal` naming one
 * of this agent's `propose`s.
 *
 * Only the agent that called may accept — the same identity rule as `cancel`.
 * An accept that names nothing pending, or comes from anyone but the caller,
 * is answered `failure { reason: "no such proposal" }`. The job is admitted
 * with the terms the bid offered, under an `openRequests` entry that owes the
 * caller one final `inform`/`failure`; no `agree` goes out, because the accept
 * *is* the agreement. If the queue is full now — capacity is re-checked on
 * accept rather than held while a bid is pending (SC00029 allows the `failure`)
 * — the accept is answered `failure { reason: "no capacity" }`.
 */
export async function handleAcceptProposal(
  agent: Agent,
  msg: Message,
): Promise<void> {
  const content = isRecord(msg.content) ? msg.content : {};
  const goal = typeof content.goal === "string" ? content.goal : "";
  const entry = proposalForExchange(agent, msg);

  if (!entry || entry.peer !== msg.sender) {
    await respondFailure(agent, msg, goal, "no such proposal");
    return;
  }
  agent.pendingProposals.delete(entry.cfp.replyWith!);

  if (agent.goals.atCapacity()) {
    await respondFailure(agent, msg, goal, "no capacity");
    return;
  }

  const cfpContent = isRecord(entry.cfp.content) ? entry.cfp.content : {};
  const outcome = agent.goalFromMessage(msg, 5, {
    content: { ...cfpContent, goal: entry.goal, terms: entry.terms },
    agree: false,
  });

  if (!outcome || !outcome.admitted) {
    // The queue refused the goal at admission. `reportRejections` has already
    // queued a `refuse` for it; the accept is owed a `failure` instead, and
    // the `agree: false` admission never queued one, so this is the single
    // answer that goes out.
    await respondFailure(agent, msg, goal, "no capacity");
    return;
  }

  agent.emitter.emit("proposal:accepted", {
    peer: msg.sender,
    goal: entry.goal,
    proposalId: msg.inReplyTo!,
  } satisfies ProposalAccepted);
}

/**
 * Drops a bid a `reject-proposal` names. No reply is sent — a rejection is the
 * end of the exchange. A rejection naming nothing is ignored.
 */
export function handleRejectProposal(agent: Agent, msg: Message): void {
  const entry = proposalForExchange(agent, msg);
  if (!entry || entry.peer !== msg.sender) {
    return;
  }
  agent.pendingProposals.delete(entry.cfp.replyWith!);

  const content = isRecord(msg.content) ? msg.content : {};
  agent.emitter.emit("proposal:rejected", {
    peer: msg.sender,
    goal: entry.goal,
    proposalId: msg.inReplyTo!,
    ...(typeof content.reason === "string" ? { reason: content.reason } : {}),
  } satisfies ProposalRejected);
}

/**
 * Drops every bid whose `reply-by` has passed. A late `accept-proposal` then
 * names nothing pending and is answered `failure`.
 */
export function expireProposals(agent: Agent): void {
  const now = Date.now();
  for (const [key, entry] of agent.pendingProposals) {
    if (entry.deadline === undefined || entry.deadline > now) {
      continue;
    }
    agent.pendingProposals.delete(key);
    agent.emitter.emit("proposal:expired", {
      peer: entry.peer,
      goal: entry.goal,
      proposalId: entry.exchange ?? key,
    } satisfies ProposalExpired);
  }
}

/**
 * The bid a `cancel` naming a `cfp` withdraws, if any: matched on the `cfp`'s
 * `replyWith`, from the agent that called. A bid still being evaluated is
 * matched too, so cancelling it discards the computation rather than proposing
 * on a call that is over.
 */
export function pendingProposalFor(
  agent: Agent,
  msg: Message,
): PendingProposal | undefined {
  if (msg.inReplyTo === undefined) return undefined;
  const entry = agent.pendingProposals.get(msg.inReplyTo);
  return entry && entry.peer === msg.sender ? entry : undefined;
}

/**
 * The pending bid an `accept-proposal` or `reject-proposal` names: the one
 * whose `propose`'s `replyWith` is the reply's `inReplyTo`.
 */
function proposalForExchange(
  agent: Agent,
  msg: Message,
): PendingProposal | undefined {
  if (msg.inReplyTo === undefined) return undefined;
  for (const entry of agent.pendingProposals.values()) {
    if (entry.exchange === msg.inReplyTo) {
      return entry;
    }
  }
  return undefined;
}

/** Declines a `cfp` in the `RefusalVerdict` vocabulary, reporting it locally too. */
function decline(
  agent: Agent,
  cfp: Message,
  verdict: "no-plan" | "capacity" | "unsupported" | "declined",
  reason: string,
): void {
  asDirectiveHost(agent).declineDirective(cfp, verdict, { reason });
}

/** Answers an accept with a `failure` in its own exchange, at its `reply-to`. */
async function respondFailure(
  agent: Agent,
  msg: Message,
  goal: string,
  reason: string,
): Promise<void> {
  const to = replyAddress(msg);
  if (!to || to === agent.id) {
    return;
  }
  try {
    await agent.sendMessage(to, {
      performative: "failure",
      sender: agent.id,
      receiver: to,
      content: { goal, reason },
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error(`[${agent.id}] Failed to answer an accept to ${to}:`, error);
  }
}
