import { AGENT_STATE_PREFIX, deepEqual } from "../beliefs.js";
import type { BeliefBase } from "../beliefs.js";
import type { Goal } from "../goals.js";
import { isTerminalGoalStatus } from "../goals.js";
import type { Call, Delegation, Intention } from "../intentions.js";
import { isTerminalIntentionStatus, noteIntentionId } from "../intentions.js";
import { planName } from "../plans.js";
import type { Plan } from "../plans.js";
import type { TriggerState } from "../trigger.js";
import type { Agent } from "./agent.js";
import type {
  HeldBid,
  PendingProposal,
  SentProposalEntry,
  StandingCommitment,
} from "./internal.js";
import { isTracked, snapshot, track } from "./tracking.js";

/**
 * The agent's own state in its belief base, under `AGENT_STATE_PREFIX`, so a
 * belief base that persists what it holds restores the agent with it.
 *
 * - `~agent.goal.<id>`: each unfinished goal, sub-goals included, as the goal
 *   itself.
 * - `~agent.achieved.<id>`: a goal achieved and collected that a held goal
 *   still `dependsOn`, so the dependency is still met after a restart.
 * - `~agent.intention.<id>`: each unfinished intention, with its plan by name
 *   and the names of the plan's actions.
 */
const GOAL_PREFIX = `${AGENT_STATE_PREFIX}goal.`;
const ACHIEVED_PREFIX = `${AGENT_STATE_PREFIX}achieved.`;
const INTENTION_PREFIX = `${AGENT_STATE_PREFIX}intention.`;

/** Writes a goal's record, or removes it once the goal has finished. */
export function saveGoal(agent: Agent, goal: Goal): void {
  const key = GOAL_PREFIX + goal.id;
  if (!isTerminalGoalStatus(goal.status)) {
    agent.store.set(key, { ...goal });
  } else if (agent.store.has(key)) {
    agent.store.remove(key);
  }
}

/**
 * Removes a goal's record as it leaves the queue. An achieved goal that a
 * held goal depends on leaves a marker behind instead, and the markers this
 * goal's own dependencies no longer need go with it.
 */
export function forgetGoal(agent: Agent, goal: Goal): void {
  if (agent.store.has(GOAL_PREFIX + goal.id)) {
    agent.store.remove(GOAL_PREFIX + goal.id);
  }
  const achieved = agent.goals.achievedIds();
  if (goal.status === "achieved" && achieved.has(goal.id)) {
    agent.store.set(ACHIEVED_PREFIX + goal.id, true);
  }
  for (const depId of goal.dependsOn ?? []) {
    if (!achieved.has(depId) && agent.store.has(ACHIEVED_PREFIX + depId)) {
      agent.store.remove(ACHIEVED_PREFIX + depId);
    }
  }
}

/** An intention as kept: its goal by id, its plan by name. */
interface KeptIntention extends Omit<
  Intention,
  "goal" | "plan" | "calls" | "result"
> {
  goalId: string;
  planName: string;
  /** The names of the plan's actions, so a plan that changed is not resumed. */
  actions: string[];
  /** A call that waits on no deadline has `deadline: null`. */
  calls: Array<Omit<Call, "deadline"> & { deadline: number | null }>;
  result?: unknown;
}

/** What an intention is kept as. */
export function encodeIntention(intention: Intention): KeptIntention {
  const { goal, plan, calls, ...rest } = intention;
  return snapshot({
    ...rest,
    goalId: goal.id,
    planName: planName(plan),
    actions: plan.body.map((action) => action.name),
    calls: calls.map((call) => ({
      ...call,
      deadline: Number.isFinite(call.deadline) ? call.deadline : null,
    })),
  }) as KeptIntention;
}

/** Whether an intention is still kept: unfinished, and on the stack. */
function keeps(agent: Agent, intention: Intention): boolean {
  return (
    !isTerminalIntentionStatus(intention.status) &&
    agent.intentions.get(intention.id) === intention
  );
}

/**
 * Writes an intention's record, or removes it once it is not kept. Called on
 * its own after a change, so a record that cannot be written — something in
 * the intention that cannot be copied — is reported, not thrown.
 */
function saveIntention(agent: Agent, intention: Intention): void {
  const key = INTENTION_PREFIX + intention.id;
  try {
    if (keeps(agent, intention)) {
      agent.store.set(key, encodeIntention(intention));
    } else if (agent.store.has(key)) {
      agent.store.remove(key);
    }
  } catch (error) {
    console.error(
      `[${agent.id}] Could not keep intention ${intention.id}:`,
      error,
    );
  }
}

/**
 * The intention as everyone is to hold it: tracked, so every change made in
 * it is written through to its record, once per burst of changes. Its goal
 * and plan are handed out as they are: the goal is kept on its own, and the
 * plan is code.
 */
export function keepIntention(agent: Agent, intention: Intention): Intention {
  const kept: Intention = track(
    intention,
    () => saveIntention(agent, kept),
    new Set(["goal", "plan"]),
  );
  return kept;
}

/** Removes an intention's record as it leaves the stack. */
export function forgetIntention(agent: Agent, intention: Intention): void {
  const key = INTENTION_PREFIX + intention.id;
  if (agent.store.has(key)) agent.store.remove(key);
}

/**
 * The ids of the tracked intentions whose record is not what it should be:
 * for the tests, which check after every cycle that no change was missed.
 *
 * @internal
 */
export function staleIntentions(agent: Agent): string[] {
  const stale: string[] = [];
  for (const intention of agent.intentions.getAll()) {
    if (!isTracked(intention)) continue;
    const want = keeps(agent, intention)
      ? encodeIntention(intention)
      : undefined;
    if (!deepEqual(want, agent.store.get(INTENTION_PREFIX + intention.id))) {
      stale.push(intention.id);
    }
  }
  return stale;
}

/** An intention record that can be resumed, with the plan it runs. */
interface Resumable {
  record: KeptIntention;
  plan: Plan;
}

/**
 * The intention records whose plan is still registered with the same actions,
 * by name and in order, by goal id. The rest are removed: their
 * goal is planned again from its first action.
 */
function resumableIntentions(agent: Agent): Map<string, Resumable> {
  const byGoal = new Map<string, Resumable>();
  for (const { key, value } of agent.store.queryByPrefix(INTENTION_PREFIX)) {
    const record = value as KeptIntention;
    const plan = agent.planLibrary
      .all()
      .find((p) => planName(p) === record.planName);
    const same =
      plan !== undefined &&
      plan.body.length === record.actions.length &&
      plan.body.every((action, i) => action.name === record.actions[i]);
    if (same && !byGoal.has(record.goalId)) {
      byGoal.set(record.goalId, { record, plan });
    } else {
      agent.store.remove(key);
    }
  }
  return byGoal;
}

/**
 * Puts back the goals and intentions the belief base holds, before the first
 * cycle.
 *
 * An intention whose plan is still registered, with the same actions, is
 * resumed where it was: an action that was running when the agent
 * stopped runs again, and one waiting on work it handed out goes on waiting
 * for it. Its goal stays `active`, and the sub-goals it made are restored with
 * it.
 *
 * Any other goal that was `active` is `pending` again, to be planned afresh
 * from its first action, and the sub-goals its old intention made are
 * dropped, since the plan makes them again. A marker no restored goal depends
 * on is dropped too.
 */
export function restoreGoals(agent: Agent): void {
  const resumable = resumableIntentions(agent);
  const records = new Map<string, Goal>();
  for (const { value } of agent.store.queryByPrefix(GOAL_PREFIX)) {
    const goal = value as Goal;
    records.set(goal.id, goal);
  }
  // A sub-goal is restored only under a parent whose intention resumes: the
  // intention that waits for it.
  const restored = new Map<string, boolean>();
  const restores = (goal: Goal): boolean => {
    const known = restored.get(goal.id);
    if (known !== undefined) return known;
    const parent =
      goal.parentGoalId !== undefined
        ? records.get(goal.parentGoalId)
        : undefined;
    const keep =
      goal.parentGoalId === undefined ||
      (parent !== undefined && resumable.has(parent.id) && restores(parent));
    restored.set(goal.id, keep);
    return keep;
  };
  const depth = (goal: Goal): number => {
    const parent =
      goal.parentGoalId !== undefined
        ? records.get(goal.parentGoalId)
        : undefined;
    return parent ? 1 + depth(parent) : 0;
  };
  const goals = [...records.values()].sort((a, b) => depth(a) - depth(b));
  for (const goal of goals) {
    if (!restores(goal)) {
      agent.store.remove(GOAL_PREFIX + goal.id);
      continue;
    }
    if (agent.goals.get(goal.id)) continue;
    const resumes = resumable.has(goal.id);
    agent.goals.add({
      ...goal,
      status: goal.status === "active" && !resumes ? "pending" : goal.status,
    });
  }
  for (const [goalId, { record, plan }] of resumable) {
    const goal = agent.goals.get(goalId);
    if (goal?.status === "active") {
      resumeIntention(agent, record, goal, plan);
    } else {
      agent.store.remove(INTENTION_PREFIX + record.id);
    }
  }
  const needed = new Set(
    agent.goals.getUnfinished().flatMap((goal) => goal.dependsOn ?? []),
  );
  for (const { key } of agent.store.queryByPrefix(ACHIEVED_PREFIX)) {
    const id = key.slice(ACHIEVED_PREFIX.length);
    if (needed.has(id)) {
      agent.goals.rememberAchieved(id);
    } else {
      agent.store.remove(key);
    }
  }
}

/** Puts an intention back on the stack from its record, tracked again. */
function resumeIntention(
  agent: Agent,
  record: KeptIntention,
  goal: Goal,
  plan: Plan,
): void {
  const {
    goalId: _goalId,
    planName: _planName,
    actions: _actions,
    calls,
    ...rest
  } = record;
  noteIntentionId(record.id);
  const intention = keepIntention(agent, {
    ...rest,
    goal,
    plan,
    calls: calls.map((call) => ({
      ...call,
      deadline: call.deadline ?? Number.POSITIVE_INFINITY,
    })),
  } as Intention);
  agent.intentions.push(intention);
}

/**
 * A map whose every change is written through to the agent's belief base, under
 * `~agent.<kind>.<key>`: how the agent keeps its conversations
 * (`conv.<kind>`) and its desires' triggers (`desire.<name>`).
 *
 * Its entries are frozen as they are set, so an entry is never changed in
 * place; a change is a new entry set over the old one, which is what writes
 * it. Code that tried to change one in place would throw (modules run in
 * strict mode), so no change can bypass the store. Its value type should be
 * `Readonly`, so the compiler says the same.
 *
 * A write costs one encoding of the entry that changed: nothing is compared or
 * written for the entries that did not.
 */
export class KeptMap<V> extends Map<string, V> {
  /**
   * @param store The belief base, read when written so the map can be made
   *   before the agent has one.
   * @param kind The part of the key after `~agent.`.
   * @param encode What is written for an entry: plain JSON data.
   */
  constructor(
    private readonly store: () => BeliefBase,
    private readonly kind: string,
    private readonly encode: (value: V) => unknown = (value) => value,
  ) {
    super();
  }

  private keyOf(key: string): string {
    return `${AGENT_STATE_PREFIX}${this.kind}.${key}`;
  }

  override set(key: string, value: V): this {
    super.set(key, Object.freeze(value));
    this.store().set(this.keyOf(key), this.encode(value));
    return this;
  }

  override delete(key: string): boolean {
    if (!super.delete(key)) return false;
    this.store().remove(this.keyOf(key));
    return true;
  }

  override clear(): void {
    for (const key of [...this.keys()]) this.delete(key);
  }

  /** Puts back an entry the store already holds, without writing it again. */
  load(key: string, value: V): void {
    super.set(key, Object.freeze(value));
  }

  /** Every entry the store holds for this map, by key. */
  held(): Array<{ key: string; value: unknown }> {
    const prefix = this.keyOf("");
    return this.store()
      .queryByPrefix(prefix)
      .map(({ key, value }) => ({ key: key.slice(prefix.length), value }));
  }

  /** Removes an entry from the store that was never loaded into the map. */
  discard(key: string): void {
    this.store().remove(this.keyOf(key));
  }
}

/** A trigger's state as kept: its goal in flight by id. */
type KeptTrigger = Omit<TriggerState, "inFlight"> & { inFlight?: string };

/** A trigger's state as kept: its goal in flight by id. */
export function encodeTrigger(state: TriggerState): KeptTrigger {
  const { inFlight, ...rest } = state;
  return { ...rest, ...(inFlight ? { inFlight: inFlight.id } : {}) };
}

/** A kept trigger's state, its goal in flight looked up again in the queue. */
function decodeTrigger(agent: Agent, kept: KeptTrigger): TriggerState {
  const { inFlight, ...rest } = kept;
  const goal = inFlight !== undefined ? agent.goals.get(inFlight) : undefined;
  return { ...rest, ...(goal ? { inFlight: goal } : {}) };
}

/**
 * Whether two trigger states are the same, so an observation that changed
 * nothing — a condition that goes on holding, or not — writes nothing.
 */
export function sameTriggerState(a: TriggerState, b: TriggerState): boolean {
  return (
    a.last === b.last &&
    a.due === b.due &&
    a.inFlight === b.inFlight &&
    a.notBefore === b.notBefore
  );
}

/** A standing commitment as kept: its trigger's goal in flight by id. */
export function encodeStanding(c: StandingCommitment): unknown {
  const { trigger, ...rest } = c;
  return trigger ? { ...rest, trigger: encodeTrigger(trigger) } : rest;
}

/**
 * The firing state a desire kept for each item it was asking about, by item:
 * `~agent.desire.<name>.<item>`. The name is escaped so that one desire's
 * prefix never covers another's.
 */
export function desireKind(name: string): string {
  return `desire.${encodeURIComponent(name).replace(/\./g, "%2E")}`;
}

/** Puts back what a desire's triggers had seen, into its empty map. */
export function restoreDesire(
  agent: Agent,
  items: KeptMap<TriggerState>,
): void {
  for (const { key, value } of items.held()) {
    items.load(key, decodeTrigger(agent, value as KeptTrigger));
  }
}

/**
 * Removes what desires no longer registered kept, at the first start: a
 * desire registered only later starts with nothing seen.
 */
export function forgetUndeclaredDesires(agent: Agent): void {
  const prefix = `${AGENT_STATE_PREFIX}desire.`;
  const declared = agent.desires
    .all()
    .map((d) => `${AGENT_STATE_PREFIX}${desireKind(d.name)}.`);
  for (const { key } of agent.store.queryByPrefix(prefix)) {
    if (!declared.some((p) => key.startsWith(p))) agent.store.remove(key);
  }
}

/** A bid as kept: its plan by name. */
export function encodeBid(p: PendingProposal): unknown {
  return { ...p, plan: planName(p.plan) };
}

/** A remote delegation as kept: only what a `cancel` for it needs. */
export function encodeDelegation(entry: {
  delegation: Delegation;
  conversationId?: string;
}): OrphanedDelegation {
  const { delegation, conversationId } = entry;
  return {
    receiver: delegation.receiver,
    goal: delegation.goal,
    ...(delegation.goalId !== undefined ? { goalId: delegation.goalId } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
  };
}

/** A request sent for a delegation whose intention a restart has ended. */
interface OrphanedDelegation {
  receiver: string;
  goal: string;
  goalId?: string;
  conversationId?: string;
}

/** A proposal sent from an action, as kept: what a `cancel` for it needs. */
export function encodeSentProposal(entry: SentProposalEntry): OrphanedProposal {
  const { proposal, conversationId } = entry;
  return {
    receiver: proposal.receiver,
    goal: proposal.goal,
    ...(conversationId !== undefined ? { conversationId } : {}),
  };
}

/** A proposal sent from an action whose intention a restart has ended. */
interface OrphanedProposal {
  receiver: string;
  goal: string;
  conversationId?: string;
}

/** What a restart ended that a peer is still waiting on. */
export interface Orphans {
  delegations: Array<Delegation & { conversationId?: string }>;
  proposals: Array<OrphanedProposal & { id: string }>;
  bids: Array<HeldBid & { id: string }>;
}

/**
 * Puts back the conversations the belief base holds, after the goals and
 * intentions:
 *
 * - `standing`: `request-whenever` and `subscribe` commitments, with what
 *   their trigger has seen and a subscription's last value, so neither fires
 *   nor reports again for a condition that already held.
 * - `open`: directives agreed to and not yet answered terminally. One whose
 *   goal is gone is answered with `failure`.
 * - `query`, `sent`, `awaited`, `cancel`: queries, requests and cancels sent
 *   and still awaiting their answer or reply deadline.
 * - `deferred`: directives the middleware chain holds for a later decision.
 * - `bid`: bids made on a `cfp` and proposed, with their plan by name. One
 *   whose plan is gone, or whose evaluation the restart cut short, is dropped.
 * - `protocol`: the interaction protocol of each exchange, for the replies.
 *
 * What a resumed intention handed out is reconnected to it: the exchanges of
 * its calls, which are kept with the intention, and its `delegation`,
 * `proposal`, `offer` (bids on its calls) and `batch` records. Those of an
 * intention that was not resumed are returned instead, for
 * {@link settleOrphans} to close with each peer once the agent can send; the
 * plan, run again from its first action, asks afresh. A bid already expired
 * is dropped.
 */
export function restoreConversations(agent: Agent): Orphans {
  for (const { key, value } of agent.standing.held()) {
    const { trigger, ...c } = value as Omit<StandingCommitment, "trigger"> & {
      trigger?: KeptTrigger;
    };
    agent.standing.load(key, {
      ...c,
      ...(trigger ? { trigger: decodeTrigger(agent, trigger) } : {}),
    });
  }
  const plain = [
    agent.openRequests,
    agent.pendingQueries,
    agent.sentRequests,
    agent.awaitingReply,
    agent.pendingCancels,
    agent.deferredDirectives,
    agent.exchangeProtocols,
  ] as Array<KeptMap<unknown>>;
  for (const map of plain) {
    for (const { key, value } of map.held()) map.load(key, value);
  }
  for (const { key, value } of agent.pendingProposals.held()) {
    const { plan: name, ...bid } = value as Omit<PendingProposal, "plan"> & {
      plan: string;
    };
    const plan = agent.planLibrary.all().find((p) => planName(p) === name);
    if (plan && bid.exchange !== undefined) {
      agent.pendingProposals.load(key, { ...bid, plan });
    } else {
      agent.pendingProposals.discard(key);
    }
  }
  // The work a resumed intention handed out is its own again, so the replies
  // that settle it find it as they would have before the restart.
  const intentions = agent.intentions.getAll();
  for (const intention of intentions) {
    for (const call of intention.calls) {
      call.exchanges.forEach((exchange, i) => {
        const receiver = call.invited?.[i];
        agent.callExchanges.set(exchange, {
          intention,
          call,
          ...(receiver !== undefined ? { receiver } : {}),
        });
      });
    }
  }
  for (const { key, value } of agent.delegationBatches.held()) {
    if (agent.intentions.get(key)) {
      agent.delegationBatches.load(
        key,
        value as { from: number; needed: number },
      );
    } else {
      agent.delegationBatches.discard(key);
    }
  }
  const orphans: Orphans = { delegations: [], proposals: [], bids: [] };
  for (const { key, value } of agent.remoteDelegations.held()) {
    const { conversationId, ...delegation } = value as OrphanedDelegation;
    const owner = intentions.find((i) =>
      i.delegations.some((d) => d.exchange === key),
    );
    if (owner) {
      agent.remoteDelegations.load(key, {
        intention: owner,
        delegation: owner.delegations.find((d) => d.exchange === key)!,
        ...(conversationId !== undefined ? { conversationId } : {}),
      });
      continue;
    }
    orphans.delegations.push({
      ...delegation,
      status: "cancelled",
      exchange: key,
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
    agent.remoteDelegations.discard(key);
  }
  for (const { key, value } of agent.sentProposals.held()) {
    const { conversationId } = value as OrphanedProposal;
    const owner = intentions.find((i) => i.proposals.some((p) => p.id === key));
    if (owner) {
      agent.sentProposals.load(key, {
        intention: owner,
        proposal: owner.proposals.find((p) => p.id === key)!,
        ...(conversationId !== undefined ? { conversationId } : {}),
      });
      continue;
    }
    orphans.proposals.push({ ...(value as OrphanedProposal), id: key });
    agent.sentProposals.discard(key);
  }
  const now = Date.now();
  for (const { key, value } of agent.heldBids.held()) {
    const bid = value as HeldBid;
    if (agent.callExchanges.has(bid.exchange)) {
      agent.heldBids.load(key, bid);
      continue;
    }
    if (bid.expiresAt === undefined || bid.expiresAt > now) {
      orphans.bids.push({ ...bid, id: key });
    }
    agent.heldBids.discard(key);
  }
  for (const [goalId, open] of agent.openRequests) {
    if (agent.goals.get(goalId)) continue;
    agent.openRequests.delete(goalId);
    agent.pendingOutcomes.push({
      ...open,
      performative: "failure",
      reason: "agent restarted before it finished",
    });
  }
  return orphans;
}

/**
 * Closes, with each peer, what a restart ended: a delegation is cancelled,
 * as is a proposal the agent made, and a bid on its call is rejected with
 * `reason: "agent restarted"`. The peer's answer to a `cancel` ends it as any
 * cancel's would.
 */
export async function settleOrphans(
  agent: Agent,
  orphans: Orphans,
): Promise<void> {
  for (const { conversationId, ...delegation } of orphans.delegations) {
    await agent.cancelDelegation(delegation, conversationId);
  }
  for (const { id, receiver, goal, conversationId } of orphans.proposals) {
    await tell(agent, receiver, async () => {
      const sent = await agent.sendMessage(receiver, {
        performative: "cancel",
        sender: agent.id,
        receiver,
        content: { goal },
        ...(conversationId !== undefined ? { conversationId } : {}),
        inReplyTo: id,
        timestamp: Date.now(),
      });
      // Tracked as a cancel of a proposal still registered would be, so the
      // reply is matched.
      const deadline = sent.replyBy ? Date.parse(sent.replyBy) : NaN;
      agent.pendingCancels.set(sent.replyWith!, {
        peer: receiver,
        target: id,
        kind: "proposal",
        name: goal,
        ...(Number.isNaN(deadline) ? {} : { replyBy: sent.replyBy!, deadline }),
      });
    });
  }
  for (const { id, sender, goal } of orphans.bids) {
    await tell(agent, sender, () =>
      agent.sendMessage(sender, {
        performative: "reject-proposal",
        sender: agent.id,
        receiver: sender,
        content: { goal, reason: "agent restarted" },
        inReplyTo: id,
        timestamp: Date.now(),
      }),
    );
  }
}

/** Sends to a peer, logging rather than throwing if it cannot be reached. */
async function tell(
  agent: Agent,
  peer: string,
  send: () => Promise<unknown>,
): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error(`[${agent.id}] Failed to tell ${peer} of a restart:`, error);
  }
}
