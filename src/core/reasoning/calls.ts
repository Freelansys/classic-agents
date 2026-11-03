import { randomUUID } from "node:crypto";
import type { Message } from "../../bus/index.js";
import type { Call, Delegation, Intention, Proposal } from "../intentions.js";
import { isAwaitingWork } from "../intentions.js";
import type { AwardRequest, CallRequest, RefusalVerdict } from "../plans.js";
import type { Agent } from "./agent.js";
import { isRecord, isRefusalVerdict, replyAddress } from "./helpers.js";
import type { CallExchange } from "./internal.js";
import { receiveStandaloneProposal } from "./propose.js";
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
  const replyBy = Number.isFinite(deadline)
    ? new Date(deadline).toISOString()
    : undefined;

  const { id } = agent.intentions.add(intention, "calls", {
    id: `call-${randomUUID()}`,
    goal: request.goal,
    status: "open",
    ...(request.receivers ? { invited: [...request.receivers] } : {}),
    exchanges: [],
    deadline,
    proposals: [],
    refusals: [],
  });
  // Each `cfp` is recorded on the call as it goes out. A bid may come in
  // between two of them, so the call is read again for each.
  const sentTo = (exchange: string, receiver?: string) => {
    const call = heldCall(intention, id)!;
    agent.intentions.replace(intention, "calls", call, {
      ...call,
      exchanges: [...call.exchanges, exchange],
    });
    agent.callExchanges.set(exchange, {
      intention,
      callId: id,
      ...(receiver !== undefined ? { receiver } : {}),
    });
  };

  const conversationId = intention.goal.source?.conversationId;
  const content = { ...(request.view ?? {}), goal: request.goal };
  const correlation = {
    ...(conversationId ? { conversationId } : {}),
    ...(replyBy ? { replyBy } : {}),
  };

  if (request.topic !== undefined) {
    const sent = await agent.publishMessage(request.topic, {
      performative: "cfp",
      sender: agent.id,
      content,
      ...correlation,
      timestamp: Date.now(),
    });
    sentTo(sent.replyWith!);
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
      sentTo(sent.replyWith!, receiver);
    }
  }

  const call = heldCall(intention, id)!;
  agent.emitter.emit("call:opened", {
    intention,
    call: snapshotCall(call),
  } satisfies CallOpened);
  return call;
}

/** A call an intention opened, by id, as the intention holds it now. */
function heldCall(intention: Intention, id: string): Call | undefined {
  return intention.calls.find((call) => call.id === id);
}

/**
 * The call a `cfp` exchange belongs to, as it stands now: on its intention,
 * or held by the exchange for a call sent through `messages`.
 */
export function callOf(entry: CallExchange): Call | undefined {
  return entry.detached ?? heldCall(entry.intention, entry.callId);
}

/**
 * Replaces the call an exchange belongs to with `fields` applied, and
 * returns it as it now stands.
 */
function changeCall(
  agent: Agent,
  exchange: string,
  entry: CallExchange,
  fields: Partial<Call>,
): Call {
  const call = callOf(entry)!;
  if (entry.detached) {
    const next = Object.freeze({ ...call, ...fields });
    agent.callExchanges.set(exchange, { ...entry, detached: next });
    return next;
  }
  return agent.intentions.replace(entry.intention, "calls", call, {
    ...call,
    ...fields,
  });
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
 *
 * So the call outlives the plan that sent it: it is open until the `cfp`'s
 * `reply-by`, or until its invitee answers, and is pruned after that like any
 * other closed call (see {@link closeCalls}). A `cfp` sent with no `reply-by`
 * is held open for the agent's proposal retention window instead, so it is
 * never tracked for ever.
 */
export function trackCallMessage(
  agent: Agent,
  intention: Intention,
  sent: Message,
  content: Record<string, unknown>,
  receiver?: string,
): void {
  if (!sent.replyWith) return;
  const replyBy = sent.replyBy ? Date.parse(sent.replyBy) : NaN;
  const call: Call = Object.freeze({
    id: `call-${randomUUID()}`,
    goal: typeof content.goal === "string" ? content.goal : "",
    status: "open",
    ...(receiver !== undefined ? { invited: [receiver] } : {}),
    exchanges: [sent.replyWith],
    deadline: Number.isNaN(replyBy) ? Date.now() + retentionMs(agent) : replyBy,
    proposals: [],
    refusals: [],
  });
  agent.callExchanges.set(sent.replyWith, {
    intention,
    callId: call.id,
    ...(receiver !== undefined ? { receiver } : {}),
    detached: call,
  });
  agent.emitter.emit("call:opened", {
    intention,
    call: snapshotCall(call),
  } satisfies CallOpened);
}

/**
 * Files a `propose` that names one of this agent's open calls, or answers
 * `reject-proposal { reason: "no call open" }` when it names none, so the
 * bidder is not left holding a bid open for ever.
 *
 * A `propose` that names no message at all opens a conversation of its own:
 * the FIPA Propose protocol (SC00036), decided by a plan marked
 * `on: "propose"` if the agent has one (see `propose.ts`).
 *
 * A bid that names a call which has already closed or been cancelled is
 * answered `reject-proposal { reason: "call closed" }` rather than filed.
 */
export async function receiveProposal(
  agent: Agent,
  msg: Message,
): Promise<void> {
  if (msg.inReplyTo === undefined) {
    await receiveStandaloneProposal(agent, msg);
    return;
  }
  const exchange = callExchangeFor(agent, msg);
  const call = exchange && callOf(exchange);
  if (!exchange || !call) {
    await rejectUnsolicited(agent, msg, "no call open");
    return;
  }
  // A `cfp` sent to one agent is answered by that agent. Anyone else naming
  // its exchange was never asked, so the bid is turned away, as every other
  // reply this agent tracks is matched to the peer it asked. A topic call has
  // no invitee, and takes a bid from any subscriber.
  if (exchange.receiver !== undefined && exchange.receiver !== msg.sender) {
    await rejectUnsolicited(agent, msg, "not invited");
    return;
  }
  if (call.status !== "open") {
    await rejectUnsolicited(agent, msg, "call closed");
    return;
  }

  const content = isRecord(msg.content) ? msg.content : {};
  const goal = typeof content.goal === "string" ? content.goal : call.goal;
  const bid: Proposal = {
    id: msg.replyWith ?? `proposal:${agent.id}:${randomUUID()}`,
    sender: msg.sender,
    goal,
    terms: content.terms,
    receivedAt: Date.now(),
    ...(msg.replyBy && !Number.isNaN(Date.parse(msg.replyBy))
      ? { expiresAt: Date.parse(msg.replyBy) }
      : {}),
    status: "offered",
  };
  let filed: Call;
  if (exchange.detached) {
    filed = changeCall(agent, msg.inReplyTo, exchange, {
      proposals: [...call.proposals, Object.freeze(bid)],
    });
  } else {
    filed = agent.intentions.addBid(exchange.intention, call, bid).call;
    agent.heldBids.set(bid.id, {
      sender: bid.sender,
      goal: bid.goal,
      exchange: msg.inReplyTo,
      ...(bid.expiresAt !== undefined ? { expiresAt: bid.expiresAt } : {}),
    });
  }
  agent.emitter.emit("call:proposal", {
    intention: exchange.intention,
    call: snapshotCall(filed),
    proposal: { ...bid },
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
  const call = exchange && callOf(exchange);
  if (!exchange || !call || call.status !== "open") {
    return false;
  }
  // Only the invitee answers for its own `cfp`; a refusal from anyone else
  // would close the call on the invitee's behalf.
  if (exchange.receiver !== undefined && exchange.receiver !== msg.sender) {
    return false;
  }
  const content = isRecord(msg.content) ? msg.content : {};
  const verdict: RefusalVerdict | undefined = isRefusalVerdict(content.verdict)
    ? content.verdict
    : undefined;
  changeCall(agent, msg.inReplyTo!, exchange, {
    refusals: [
      ...call.refusals,
      {
        sender: msg.sender,
        ...(verdict ? { verdict } : {}),
        ...(typeof content.reason === "string"
          ? { reason: content.reason }
          : {}),
      },
    ],
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
      const closed = agent.intentions.replace(intention, "calls", call, {
        ...call,
        status: "closed",
        // A call that waited on no deadline still gets one now, so its
        // exchanges are pruned once a late bid has had its chance.
        ...(Number.isFinite(call.deadline)
          ? {}
          : { deadline: now + retentionMs(agent) }),
      });
      closedOne = true;
      agent.emitter.emit("call:closed", {
        intention,
        call: snapshotCall(closed),
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

  // Calls sent through `messages` are on no intention's list, so they are
  // closed from the registry instead. Nothing waits on them; closing only
  // reports it, and starts the retention after which they are pruned.
  for (const [exchange, entry] of [...agent.callExchanges]) {
    const call = entry.detached;
    if (!call || call.status !== "open") continue;
    if (!callShouldClose(call, now)) continue;
    const closed = changeCall(agent, exchange, entry, { status: "closed" });
    agent.emitter.emit("call:closed", {
      intention: entry.intention,
      call: snapshotCall(closed),
    } satisfies CallClosed);
  }
}

/**
 * Drops the exchanges of calls that are over and past their deadline. A closed
 * or cancelled call is kept a while longer than it was open so a bid already in
 * flight can still be answered; `settleCallAwards` clears awarded calls sooner.
 */
function pruneCallExchanges(agent: Agent, now: number): void {
  for (const [exchange, entry] of agent.callExchanges) {
    const call = callOf(entry);
    if (!call || (call.status !== "open" && call.deadline <= now)) {
      dropCallExchange(agent, exchange);
    }
  }
}

/** Stops tracking a `cfp` exchange, and the bids on it still held. */
export function dropCallExchange(agent: Agent, exchange: string): void {
  agent.callExchanges.delete(exchange);
  for (const [id, bid] of agent.heldBids) {
    if (bid.exchange === exchange) agent.heldBids.delete(id);
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
  const delegation = agent.intentions.add(intention, "delegations", {
    receiver: proposal.sender,
    goal: call.goal,
    status: "agreed",
    exchange,
    ...(deadline !== undefined ? { deadline } : {}),
    ...(request.onFailure ? { onFailure: request.onFailure } : {}),
  });
  agent.remoteDelegations.set(exchange, {
    intention,
    exchange,
    ...(sent.conversationId ? { conversationId: sent.conversationId } : {}),
  });
  changeBid(agent, intention, proposal.id, { status: "awarded" });
  agent.heldBids.delete(proposal.id);
  return delegation;
}

/**
 * Turns an award action's result into awards and rejections: every chosen bid
 * becomes a delegation, and every bid the action did not award is sent a
 * `reject-proposal` — whatever the action returned, a `failure` included. An
 * action that returns a `failure` awards nothing, so all its bids are rejected.
 *
 * Returns whether any award left the intention waiting on a delegation. The
 * caller puts the awards in the action's delegation batch, beside any
 * delegations the same action made, so its `waitFor` counts them all.
 */
export async function settleCallAwards(
  agent: Agent,
  intention: Intention,
  result: { awards?: AwardRequest[]; failure?: { reason: string } },
): Promise<boolean> {
  const from = intention.delegations.length;
  // An action that fails awards nothing, whatever else it returned: the
  // intention is about to fail, so an award would be accepted and cancelled in
  // the same breath — and a winner whose plan is not `cancellable` would do
  // the work for nobody. Its bids are rejected with the rest, below.
  const awards = result.failure ? [] : (result.awards ?? []);
  for (const request of awards) {
    await award(agent, request, intention);
  }
  const added = intention.delegations.length - from;
  if (added > 0) {
    agent.emitter.emit("intention:delegated", {
      intention,
      delegations: intention.delegations.slice(from).map((d) => ({ ...d })),
    });
  }

  for (const call of intention.calls) {
    if (call.status !== "closed") continue;
    for (const proposal of call.proposals) {
      if (proposal.status !== "offered") continue;
      await rejectProposal(agent, intention, proposal);
    }
    // The exchanges linger until the call's deadline, so a bid already in
    // flight is answered "call closed"; `pruneCallExchanges` clears them then.
  }

  return added > 0;
}

/**
 * Stops every open call an intention left behind — it failed, was cancelled or
 * was withdrawn — and rejects every bid it still holds, on an open call or on
 * one that closed and was never awarded. A late bid that names one of the
 * calls is answered `reject-proposal { reason: "call closed" }`, so no bidder
 * waits on a call that is over.
 */
export async function abandonCalls(
  agent: Agent,
  intention: Intention,
  _reason: string,
): Promise<void> {
  const now = Date.now();
  for (const call of intention.calls) {
    if (call.status === "open") {
      agent.intentions.replace(intention, "calls", call, {
        ...call,
        status: "cancelled",
        // A call that waited on no deadline is still given one now, so a bid
        // in flight is answered "call closed" before the exchange is pruned.
        ...(Number.isFinite(call.deadline)
          ? {}
          : { deadline: now + retentionMs(agent) }),
      });
    }
    // A closed call's bids are still offered until the action after it runs.
    // If the intention ends first, that action never runs, so they are
    // rejected here instead of left to expire on the bidders' side.
    for (const proposal of call.proposals) {
      if (proposal.status !== "offered") continue;
      await rejectProposal(agent, intention, proposal);
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

/** A proposal by id across every call an intention opened, as it holds them now. */
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

/** Replaces a bid on one of the intention's calls with `fields` applied. */
function changeBid(
  agent: Agent,
  intention: Intention,
  id: string,
  fields: Partial<Proposal>,
): void {
  const found = proposalById(intention, id);
  if (!found) return;
  agent.intentions.replaceBid(intention, found.call, found.proposal, {
    ...found.proposal,
    ...fields,
  });
}

/**
 * The most a call closes ahead of its earliest bid's expiry, so the award has
 * time to reach the bidder while the bid still stands.
 */
const AWARD_MARGIN_MS = 1000;

/**
 * When a bid must be awarded by: ahead of its expiry by {@link AWARD_MARGIN_MS},
 * or by half its validity when that is shorter. `undefined` for a bid that
 * does not expire.
 */
function awardBy(proposal: Proposal): number | undefined {
  if (proposal.expiresAt === undefined) return undefined;
  const validity = proposal.expiresAt - proposal.receivedAt;
  return (
    proposal.expiresAt - Math.max(0, Math.min(AWARD_MARGIN_MS, validity / 2))
  );
}

/**
 * Whether a call is done: every invitee answered, its deadline passed, or a bid
 * it holds is about to expire.
 *
 * The last is what keeps a call from outliving its own bids. A bid is valid
 * for the bidder's `proposalTimeoutMs`, counted from when it was sent, and
 * the bidding deadline is counted from the `cfp`. With a silent invitee the
 * call would otherwise wait out its deadline while an early bid ran out, and
 * the award would be answered `failure { reason: "no such proposal" }`.
 */
function callShouldClose(call: Call, now: number): boolean {
  if (call.deadline <= now) return true;
  for (const proposal of call.proposals) {
    if (proposal.status !== "offered") continue;
    const by = awardBy(proposal);
    if (by !== undefined && by <= now) return true;
  }
  if (!call.invited || call.invited.length === 0) return false;
  return call.invited.every(
    (receiver) =>
      call.proposals.some((p) => p.sender === receiver) ||
      call.refusals.some((r) => r.sender === receiver),
  );
}

/** Answers a `propose` that names no open call: `reject-proposal`, per D5. */
export async function rejectUnsolicited(
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
async function rejectProposal(
  agent: Agent,
  intention: Intention,
  proposal: Proposal,
): Promise<void> {
  changeBid(agent, intention, proposal.id, { status: "rejected" });
  agent.heldBids.delete(proposal.id);
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
