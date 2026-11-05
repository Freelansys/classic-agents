import { randomUUID } from "node:crypto";
import type { Message } from "../../bus/index.js";
import { userDefinedParameters } from "../../bus/types.js";
import type { Intention, SentProposal } from "../intentions.js";
import { isAwaitingWork } from "../intentions.js";
import type { ProposalRequest } from "../plans.js";
import type { Agent } from "./agent.js";
import { rejectUnsolicited } from "./calls.js";
import { asReceiverList, isPast, isRecord, withDetails } from "./helpers.js";
import { asDirectiveHost } from "./internal.js";
import type {
  ProposalAccepted,
  ProposalExpired,
  ProposalRejected,
  ProposalSent,
} from "./types.js";

/**
 * The FIPA Propose interaction protocol (SC00036): a `propose` that answers no
 * call, offering to do something if the receiver accepts.
 *
 * **Receiver.** Such a `propose` is decided as a goal. A plan marked
 * `on: "propose"` serves it (see `Plan.on`), and the goal's outcome is the
 * answer: achieved is `accept-proposal`, failed or dropped is
 * `reject-proposal`. The `propose` runs the directive middleware chain like a
 * request, so it can be refused or deferred to a person; it is never agreed
 * to, since the decision is the only answer the protocol has. An agent with
 * no marked plan for the goal rejects it at once — D5 in `CONTRACT-NET.md`.
 *
 * **Proposer.** An action's `ActionResult.proposals` sends each `propose` and
 * records it on `intention.proposals`; the intention waits until every one is
 * accepted, rejected or expired, and the next action reads how each went.
 *
 * A `propose` that names a `cfp` this agent sent is a bid, not this protocol,
 * and is filed against its call (see `calls.ts`).
 */

/**
 * Takes a `propose` that opens a conversation — it names no message it
 * answers — through the directive chain, if a plan marked `on: "propose"`
 * serves its goal. Otherwise it is answered `reject-proposal`, as a `propose`
 * naming no open call always was.
 */
export async function receiveStandaloneProposal(
  agent: Agent,
  msg: Message,
): Promise<void> {
  if (!msg.sender || msg.sender === agent.id) {
    return;
  }
  const content = isRecord(msg.content) ? msg.content : {};
  const goal = typeof content.goal === "string" ? content.goal : "";
  if (!agent.planLibrary.declares(goal, "propose")) {
    await rejectUnsolicited(agent, msg, "no call open");
    return;
  }
  // Late, as a directive can be: its proposer has stopped waiting, so a
  // decision would be for nobody.
  if (isPast(msg.replyBy)) {
    agent.emitter.emit("directive:expired", msg);
    return;
  }
  await asDirectiveHost(agent).considerDirective(msg, 5);
}

/**
 * Decides to consider a `propose`, at the end of the directive chain: it
 * becomes a goal for the plans marked `on: "propose"` to decide. No `agree`
 * goes out. A goal no marked plan serves (the chain rewrote it) or the queue
 * has no room for is answered `reject-proposal`.
 */
export function admitProposal(
  agent: Agent,
  msg: Message,
  priority: number,
): void {
  const content = isRecord(msg.content) ? msg.content : {};
  const goal = typeof content.goal === "string" ? content.goal : "";
  if (!agent.planLibrary.declares(goal, "propose")) {
    asDirectiveHost(agent).declineDirective(msg, "no-plan", {
      reason: `no plan decides on "${goal}"`,
    });
    return;
  }
  const outcome = agent.goalFromMessage(msg, priority, { agree: false });
  if (outcome && !outcome.admitted) {
    // The queue has already queued the rejection, as it does a request's.
    asDirectiveHost(agent).declineDirective(msg, "capacity", { send: false });
  }
}

/**
 * Withdraws every decision whose proposer stopped waiting for it — the
 * `propose`'s `reply-by` passed — as its `cancel` would, and owes it nothing
 * more. A started plan that is not `cancellable` runs on, unanswered.
 */
export async function expireDecisions(agent: Agent): Promise<void> {
  const now = Date.now();
  for (const open of [...agent.openRequests.values()]) {
    if (open.deadline === undefined || open.deadline > now) continue;
    agent.openRequests.delete(open.goalId);
    const by = agent.goals.get(open.goalId)?.source?.sender ?? agent.id;
    await agent.withdraw(open.goalId, by, async () => {});
  }
}

/**
 * One proposal of an action, with a set of receivers expanded: a
 * {@link ProposalRequest} naming several agents becomes one per agent, each
 * decided on its own. `addressees` is the whole set, named on each `propose`
 * so every receiver sees who else it was offered to.
 */
export interface ExpandedProposal {
  request: ProposalRequest & { receiver: string };
  addressees?: string[];
}

/**
 * Expands an action's proposals: one per receiver, in order. A set that names
 * nobody is a mistake in the plan and fails the action.
 */
export function expandProposals(
  requests: ProposalRequest[],
): ExpandedProposal[] {
  return requests.flatMap((request): ExpandedProposal[] => {
    if (!Array.isArray(request.receiver)) {
      return [{ request: { ...request, receiver: request.receiver } }];
    }
    const receivers = asReceiverList(request.receiver);
    if (receivers.length === 0) {
      throw new Error(`proposal of "${request.goal}" names no receiver`);
    }
    if (receivers.length === 1) {
      return [{ request: { ...request, receiver: receivers[0] } }];
    }
    return receivers.map((receiver) => ({
      request: { ...request, receiver },
      addressees: receivers,
    }));
  });
}

/**
 * Makes a proposal from an action: sends the `propose` and records it on the
 * intention, which waits on it. A proposal that is one of a set names the
 * whole set, `addressees`, as its `receiver`.
 */
export async function openProposal(
  agent: Agent,
  request: ProposalRequest & { receiver: string },
  intention: Intention,
  addressees?: string[],
): Promise<SentProposal> {
  const timeoutMs =
    request.timeoutMs === null
      ? 0
      : (request.timeoutMs ?? agent.config.proposalTimeoutMs);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const conversationId =
    request.conversationId ?? intention.goal.source?.conversationId;

  // Recorded before the send, under the id the `propose` will carry, so a
  // decision can never arrive before there is something to settle.
  const proposal = agent.intentions.add(intention, "proposals", {
    id: randomUUID(),
    receiver: request.receiver,
    goal: request.goal,
    terms: request.terms,
    status: "open",
    ...(deadline !== undefined ? { deadline } : {}),
  });
  agent.sentProposals.set(proposal.id, { intention, id: proposal.id });

  const sent = await agent.sendMessage(request.receiver, {
    performative: "propose",
    sender: agent.id,
    receiver: addressees ?? request.receiver,
    content: { goal: request.goal, terms: request.terms },
    ...(conversationId ? { conversationId } : {}),
    ...userDefinedParameters(request.params),
    replyWith: proposal.id,
    ...(deadline !== undefined
      ? { replyBy: new Date(deadline).toISOString() }
      : {}),
    timestamp: Date.now(),
  });
  const entry = agent.sentProposals.get(proposal.id);
  if (entry && sent.conversationId) {
    agent.sentProposals.set(proposal.id, {
      ...entry,
      conversationId: sent.conversationId,
    });
  }

  agent.emitter.emit("proposal:sent", {
    peer: request.receiver,
    goal: request.goal,
    proposalId: proposal.id,
    terms: request.terms,
  } satisfies ProposalSent);
  return proposal;
}

/**
 * A proposal this agent made and is still waiting on, with the proposal as
 * its intention holds it now.
 */
export function sentProposal(
  agent: Agent,
  id: string,
):
  | { intention: Intention; proposal: SentProposal; conversationId?: string }
  | undefined {
  const entry = agent.sentProposals.get(id);
  const proposal = entry?.intention.proposals.find((p) => p.id === id);
  return entry && proposal ? { ...entry, proposal } : undefined;
}

/**
 * Settles a proposal this agent made with the receiver's decision: an
 * `accept-proposal`, a `reject-proposal`, or a `not-understood` (a rejection
 * by a receiver that could not read it). Returns whether the message named
 * one; only the agent proposed to decides.
 */
export function settleSentProposal(agent: Agent, msg: Message): boolean {
  if (msg.inReplyTo === undefined) return false;
  const entry = sentProposal(agent, msg.inReplyTo);
  if (!entry || entry.proposal.receiver !== msg.sender) return false;
  agent.sentProposals.delete(msg.inReplyTo);

  const { intention, proposal: open } = entry;
  const content = isRecord(msg.content) ? msg.content : {};
  if (msg.performative === "accept-proposal") {
    const proposal = agent.intentions.replace(intention, "proposals", open, {
      ...open,
      status: "accepted",
      ...(content.result !== undefined ? { answer: content.result } : {}),
    });
    agent.emitter.emit("proposal:accepted", {
      peer: proposal.receiver,
      goal: proposal.goal,
      proposalId: proposal.id,
      ...(proposal.answer !== undefined ? { answer: proposal.answer } : {}),
    } satisfies ProposalAccepted);
  } else {
    const proposal = agent.intentions.replace(intention, "proposals", open, {
      ...open,
      status: "rejected",
      reason:
        typeof content.reason === "string"
          ? content.reason
          : msg.performative === "not-understood"
            ? "not understood"
            : "rejected",
      ...withDetails({}, content.details),
    });
    agent.emitter.emit("proposal:rejected", {
      peer: proposal.receiver,
      goal: proposal.goal,
      proposalId: proposal.id,
      reason: proposal.reason!,
      ...withDetails({}, proposal.details),
    } satisfies ProposalRejected);
  }
  resumeIfDecided(agent, intention);
  return true;
}

/** Marks every proposal this agent made whose `reply-by` passed `expired`. */
export function expireSentProposals(agent: Agent): void {
  const now = Date.now();
  for (const id of [...agent.sentProposals.keys()]) {
    const entry = sentProposal(agent, id);
    if (!entry) continue;
    const { intention, proposal } = entry;
    if (proposal.deadline === undefined || proposal.deadline > now) continue;
    agent.sentProposals.delete(id);
    agent.intentions.replace(intention, "proposals", proposal, {
      ...proposal,
      status: "expired",
      reason: `no decision by ${new Date(proposal.deadline).toISOString()}`,
    });
    agent.emitter.emit("proposal:expired", {
      peer: proposal.receiver,
      goal: proposal.goal,
      proposalId: proposal.id,
    } satisfies ProposalExpired);
    resumeIfDecided(agent, intention);
  }
}

/**
 * Withdraws every proposal an intention left open — it failed, was cancelled
 * or was withdrawn — with a `cancel` to its receiver, so nobody goes on
 * deciding on an offer that no longer stands.
 */
export async function abandonProposals(
  agent: Agent,
  intention: Intention,
  reason: string,
): Promise<void> {
  for (const proposal of intention.proposals) {
    if (proposal.status !== "open") continue;
    agent.intentions.replace(intention, "proposals", proposal, {
      ...proposal,
      status: "cancelled",
      reason,
    });
    const entry = agent.sentProposals.get(proposal.id);
    try {
      // Sent while still registered, so the cancel's reply is tracked.
      await agent.sendMessage(proposal.receiver, {
        performative: "cancel",
        sender: agent.id,
        receiver: proposal.receiver,
        content: { goal: proposal.goal },
        ...(entry?.conversationId
          ? { conversationId: entry.conversationId }
          : {}),
        inReplyTo: proposal.id,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(
        `[${agent.id}] Failed to withdraw a proposal to ${proposal.receiver}:`,
        error,
      );
    }
    agent.sentProposals.delete(proposal.id);
  }
}

/** Resumes an intention once nothing it waits on is left open. */
function resumeIfDecided(agent: Agent, intention: Intention): void {
  if (intention.status === "waiting" && !isAwaitingWork(intention)) {
    agent.resumeIntention(intention);
  }
}
