import { randomUUID } from "node:crypto";
import type { Message } from "../../bus/index.js";
import type { Call, Delegation, Intention, Proposal } from "../intentions.js";
import { isAwaitingWork } from "../intentions.js";
import type { AwardRequest, CallRequest, RefusalVerdict } from "../plans.js";
import type { Agent } from "./agent.js";
import {
  isRecord,
  isRefusalVerdict,
  replyAddress,
  resolveWaitFor,
} from "./helpers.js";
import type { CallExchange } from "./internal.js";
import type { CallClosed, CallOpened, CallProposalReceived } from "./types.js";

/**
 * The initiator half of the FIPA Contract Net protocol (SC00029): calling for
 * proposals, collecting bids and awarding a job.
 *
 * A call sends one `cfp` per invitee — a message has one receiver — or a single
 * published `cfp` for a topic. Each `cfp` is its own exchange, so a
 * {@link CallExchange} keys every one of them to the call that owns it, and the
 * bids that name an exchange back are filed on the call rather than left as
 * loose messages. The intention waits while any call is open; once every call
 * has closed, the plan's next action reads the proposals and awards them.
 *
 * An award is almost a delegation: the winner is sent an `accept-proposal`, and
 * its final `inform`/`failure` settles the award exactly as a `request`'s reply
 * settles a delegation. Everything downstream — deadlines, `waitFor`,
 * `onFailure`, the result — is the existing delegation machinery.
 */

/** A snapshot of a call safe to hand to an event handler. */
function snapshotCall(call: Call): Call {
  return {
    ...call,
    ...(call.invited ? { invited: [...call.invited] } : {}),
    exchanges: [...call.exchanges],
    proposals: call.proposals.map((p) => ({ ...p })),
    refusals: call.refusals.map((r) => ({ ...r })),
  };
}

/**
 * Opens a call for proposals: sends the `cfp`s and records the call on the
 * intention. The intention is `waiting` afterwards, on every open call.
 */
export async function openCall(
  agent: Agent,
  request: CallRequest,
  intention: Intention,
): Promise<Call> {
  const deadlineMs = request.deadlineMs ?? agent.config.replyTimeoutMs;
  const deadline =
    deadlineMs > 0 ? Date.now() + deadlineMs : Number.POSITIVE_INFINITY;
  const replyBy = deadlineMs > 0 ? new Date(deadline).toISOString() : undefined;

  const call: Call = {
    id: `call-${randomUUID()}`,
    goal: request.goal,
    status: "open",
    ...(request.receivers ? { invited: [...request.receivers] } : {}),
    exchanges: [],
    deadline,
    proposals: [],
    refusals: [],
  };
  intention.calls.push(call);

  const conversationId = intention.goal.source?.conversationId;
  const content = { ...(request.view ?? {}), goal: request.goal };
  const correlation = {
    ...(conversationId ? { conversationId } : {}),
    ...(request.deadlineMs !== undefined || agent.config.replyTimeoutMs > 0
      ? { replyBy: new Date(call.deadline).toISOString() }
      : {}),
  };

  if (request.topic !== undefined) {
    const sent = await agent.publishMessage(request.topic, {
      performative: "cfp",
      sender: agent.id,
      content,
      ...correlation,
      timestamp: Date.now(),
    });
    call.exchanges.push(sent.replyWith!);
    agent.callExchanges.set(sent.replyWith!, { intention, call });
  } else {
    for (const receiver of request.receivers ?? []) {
      const sent = await agent.sendMessage(
        receiver,
        {
          performative: "cfp",
          sender: agent.id,
          receiver,
          content,
          ...correlation,
          timestamp: Date.now(),
        },
        correlation.replyBy ? {} : { replyBy: null },
      );
      call.exchanges.push(sent.replyWith!);
      agent.callExchanges.set(sent.replyWith!, {
        intention,
        call,
        receiver,
      });
    }
  }

  agent.emitter.emit("call:opened", {
    intention,
    call: snapshotCall(call),
  } satisfies CallOpened);
  return call;
}

/**
 * Tracks a `cfp` a plan sent through `ActionResult.messages`, which it does not
 * wait on — the same way a raw `request` sent that way is not waited on.
 *
 * The call is registered by its `cfp`'s `replyWith`, so a bid naming it is
 * correlated and emitted as `call:proposal` rather than rejected as
 * unsolicited. It is deliberately *not* added to `intention.calls`: the
 * intention never waits on it, and no automatic award or rejection applies.
 * The application decides, from `call:opened`/`call:proposal`, whether and how
 * to answer — the call is a hook for a plan that wants to negotiate without
 * holding its own goal open.
 */
export function trackCallMessage(
  agent: Agent,
  intention: Intention,
  sent: Message,
  content: Record<string, unknown>,
  receiver?: string,
): void {
  if (!sent.replyWith) return;
  const call: Call = {
    id: `call-${randomUUID()}`,
    goal: typeof content.goal === "string" ? content.goal : "",
    status: "open",
    ...(receiver !== undefined ? { invited: [receiver] } : {}),
    exchanges: [sent.replyWith],
    deadline: Number.POSITIVE_INFINITY,
    proposals: [],
    refusals: [],
  };
  agent.callExchanges.set(sent.replyWith, {
    intention,
    call,
    ...(receiver !== undefined ? { receiver } : {}),
  });
  agent.emitter.emit("call:opened", {
    intention,
    call: snapshotCall(call),
  } satisfies CallOpened);
}

/**
 * Files a `propose` that names one of this agent's open calls, or answers
 * `reject-proposal { reason: "no call open" }` when it names none — the FIPA
 * Propose protocol (SC00036) is out of scope, but silence would leave the
 * bidder holding a bid open for ever.
 *
 * A bid that names a call which has already closed or been cancelled is
 * answered `reject-proposal { reason: "call closed" }` rather than filed.
 */
export async function receiveProposal(
  agent: Agent,
  msg: Message,
): Promise<void> {
  const exchange = callExchangeFor(agent, msg);
  if (!exchange) {
    await rejectUnsolicited(agent, msg, "no call open");
    return;
  }
  if (exchange.call.status !== "open") {
    await rejectUnsolicited(agent, msg, "call closed");
    return;
  }

  const content = isRecord(msg.content) ? msg.content : {};
  const goal =
    typeof content.goal === "string" ? content.goal : exchange.call.goal;
  const proposal: Proposal = {
    id: msg.replyWith ?? `proposal:${agent.id}:${randomUUID()}`,
    sender: msg.sender,
    goal,
    terms: content.terms,
    ...(msg.replyBy ? { expiresAt: Date.parse(msg.replyBy) } : {}),
    status: "offered",
  };
  exchange.call.proposals.push(proposal);
  agent.emitter.emit("call:proposal", {
    intention: exchange.intention,
    call: snapshotCall(exchange.call),
    proposal: { ...proposal },
  } satisfies CallProposalReceived);
}

/**
 * Files a `refuse` or `not-understood` that names one of this agent's calls as
 * the invitee's answer, so the call can close once every invitee has answered.
 * Returns whether it named a call; the caller still lets the message take its
 * ordinary path (a `refuse` still writes its `infeasible.*` belief).
 */
export function fileCallRefusal(agent: Agent, msg: Message): boolean {
  const exchange = callExchangeFor(agent, msg);
  if (!exchange || exchange.call.status !== "open") {
    return false;
  }
  const content = isRecord(msg.content) ? msg.content : {};
  const verdict: RefusalVerdict | undefined = isRefusalVerdict(content.verdict)
    ? content.verdict
    : undefined;
  exchange.call.refusals.push({
    sender: msg.sender,
    ...(verdict ? { verdict } : {}),
    ...(typeof content.reason === "string" ? { reason: content.reason } : {}),
  });
  return true;
}

/**
 * Closes every call that is done: all invitees have answered, or its deadline
 * has passed. A topic call closes only on its deadline, since the set of
 * subscribers is not known.
 *
 * Once every call an intention opened has closed and nothing else is open, the
 * intention resumes with its next action, which reads the proposals. Closing
 * emits `call:closed`.
 */
export function closeCalls(agent: Agent): void {
  const now = Date.now();
  pruneCallExchanges(agent, now);
  for (const intention of agent.intentions.getActive()) {
    let closedOne = false;
    for (const call of intention.calls) {
      if (call.status !== "open") continue;
      if (!callShouldClose(call, now)) continue;
      call.status = "closed";
      closedOne = true;
      agent.emitter.emit("call:closed", {
        intention,
        call: snapshotCall(call),
      } satisfies CallClosed);
    }
    if (
      closedOne &&
      intention.status === "waiting" &&
      !isAwaitingWork(intention)
    ) {
      agent.resumeIntention(intention);
    }
  }
}

/**
 * Drops the exchanges of calls that are over and past their deadline. A closed
 * or cancelled call is kept a while longer than it was open so a bid already in
 * flight can still be answered; `settleCallAwards` clears awarded calls sooner.
 */
function pruneCallExchanges(agent: Agent, now: number): void {
  for (const [exchange, entry] of agent.callExchanges) {
    const { call } = entry;
    if (call.status !== "open" && call.deadline <= now) {
      agent.callExchanges.delete(exchange);
    }
  }
}

/** How long a finished call's exchange is kept to answer a bid already bound. */
function retentionMs(agent: Agent): number {
  const { proposalTimeoutMs, replyTimeoutMs } = agent.config;
  if (proposalTimeoutMs && proposalTimeoutMs > 0) return proposalTimeoutMs;
  if (replyTimeoutMs && replyTimeoutMs > 0) return replyTimeoutMs;
  return 5000;
}

/**
 * Awards a bid: sends the winner an `accept-proposal` and records the award as
 * an agreed delegation, so the winner's final `inform`/`failure` settles it as
 * a request's does. Throws — failing the action — if the proposal is unknown or
 * its call is still open.
 */
export async function award(
  agent: Agent,
  request: AwardRequest,
  intention: Intention,
): Promise<Delegation> {
  const found = proposalById(intention, request.proposal);
  if (!found || found.call.status !== "closed") {
    throw new Error(
      found
        ? `award names a proposal on a call that is still open: "${request.proposal}"`
        : `award names no known proposal: "${request.proposal}"`,
    );
  }
  const { call, proposal } = found;

  const timeoutMs =
    request.timeoutMs === null
      ? 0
      : (request.timeoutMs ?? agent.config.delegationTimeoutMs);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const conversationId = intention.goal.source?.conversationId;

  const sent = await agent.sendMessage(proposal.sender, {
    performative: "accept-proposal",
    sender: agent.id,
    receiver: proposal.sender,
    content: {
      goal: call.goal,
      ...(proposal.terms !== undefined ? { terms: proposal.terms } : {}),
    },
    ...(conversationId ? { conversationId } : {}),
    inReplyTo: proposal.id,
    timestamp: Date.now(),
  });
  const exchange = sent.replyWith!;
  const delegation: Delegation = {
    receiver: proposal.sender,
    goal: call.goal,
    status: "agreed",
    exchange,
    ...(deadline !== undefined ? { deadline } : {}),
    ...(request.onFailure ? { onFailure: request.onFailure } : {}),
  };
  intention.delegations.push(delegation);
  agent.remoteDelegations.set(exchange, {
    intention,
    delegation,
    ...(sent.conversationId ? { conversationId: sent.conversationId } : {}),
  });
  proposal.status = "awarded";
  return delegation;
}

/**
 * Turns an award action's result into awards and rejections: every chosen bid
 * becomes a delegation, and every bid the action did not award is sent a
 * `reject-proposal` — whatever the action returned, a `failure` included.
 *
 * Returns whether any award left the intention waiting on a delegation.
 */
export async function settleCallAwards(
  agent: Agent,
  intention: Intention,
  result: { awards?: AwardRequest[]; waitFor?: "all" | "any" | number },
): Promise<boolean> {
  const from = intention.delegations.length;
  for (const request of result.awards ?? []) {
    await award(agent, request, intention);
  }
  const added = intention.delegations.length - from;
  if (added > 0) {
    agent.delegationBatches.set(intention.id, {
      from,
      needed: resolveWaitFor(result.waitFor, added),
    });
    agent.emitter.emit("intention:delegated", {
      intention,
      delegations: intention.delegations.slice(from).map((d) => ({ ...d })),
    });
  }

  for (const call of intention.calls) {
    if (call.status !== "closed") continue;
    for (const proposal of call.proposals) {
      if (proposal.status !== "offered") continue;
      await rejectProposal(agent, proposal);
    }
    // Every bid is now answered, so the exchanges need not linger for a late
    // bid to be told "call closed".
    for (const exchange of call.exchanges) {
      agent.callExchanges.delete(exchange);
    }
  }

  return added > 0;
}

/**
 * Stops every open call an intention left behind — it failed, was cancelled or
 * was withdrawn — and rejects every bid received. A late bid that names one of
 * the calls is answered `reject-proposal { reason: "call closed" }`, so no
 * bidder waits on a call that is over.
 */
export async function abandonCalls(
  agent: Agent,
  intention: Intention,
  _reason: string,
): Promise<void> {
  const now = Date.now();
  for (const call of intention.calls) {
    if (call.status !== "open") continue;
    call.status = "cancelled";
    // A call that waited on no deadline is still given one now, so a bid in
    // flight is answered "call closed" before the exchange is pruned.
    if (!Number.isFinite(call.deadline)) {
      call.deadline = now + retentionMs(agent);
    }
    for (const proposal of call.proposals) {
      if (proposal.status !== "offered") continue;
      await rejectProposal(agent, proposal);
    }
  }
}

/** The call exchange a `propose`, `refuse` or `not-understood` names, if ours. */
export function callExchangeFor(
  agent: Agent,
  msg: Message,
): CallExchange | undefined {
  if (!msg.inReplyTo) return undefined;
  return agent.callExchanges.get(msg.inReplyTo);
}

/** A proposal by id across every call an intention opened. */
function proposalById(
  intention: Intention,
  id: string,
): { call: Call; proposal: Proposal } | undefined {
  for (const call of intention.calls) {
    const proposal = call.proposals.find((p) => p.id === id);
    if (proposal) return { call, proposal };
  }
  return undefined;
}

/** Whether a call is done: every invitee answered, or its deadline passed. */
function callShouldClose(call: Call, now: number): boolean {
  if (call.deadline <= now) return true;
  if (!call.invited || call.invited.length === 0) return false;
  return call.invited.every(
    (receiver) =>
      call.proposals.some((p) => p.sender === receiver) ||
      call.refusals.some((r) => r.sender === receiver),
  );
}

/** Answers a `propose` that names no open call: `reject-proposal`, per D5. */
async function rejectUnsolicited(
  agent: Agent,
  msg: Message,
  reason: string,
): Promise<void> {
  const to = replyAddress(msg);
  if (!to || to === agent.id) return;
  try {
    await agent.sendMessage(to, {
      performative: "reject-proposal",
      sender: agent.id,
      receiver: to,
      content: {
        ...(isRecord(msg.content) && typeof msg.content.goal === "string"
          ? { goal: msg.content.goal }
          : {}),
        reason,
      },
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error(`[${agent.id}] Failed to reject a proposal to ${to}:`, error);
  }
}

/** Rejects a bid that was not awarded, so its bidder gets closure. */
async function rejectProposal(agent: Agent, proposal: Proposal): Promise<void> {
  proposal.status = "rejected";
  const to = proposal.sender;
  if (!to || to === agent.id) return;
  try {
    await agent.sendMessage(to, {
      performative: "reject-proposal",
      sender: agent.id,
      receiver: to,
      content: { goal: proposal.goal },
      inReplyTo: proposal.id,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error(`[${agent.id}] Failed to reject a proposal to ${to}:`, error);
  }
}
