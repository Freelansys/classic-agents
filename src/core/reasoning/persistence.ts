import { AGENT_STATE_PREFIX } from "../beliefs.js";
import type { BeliefBase } from "../beliefs.js";
import type { Goal } from "../goals.js";
import { isTerminalGoalStatus } from "../goals.js";
import type { Delegation } from "../intentions.js";
import { planName } from "../plans.js";
import type { TriggerState } from "../trigger.js";
import type { Agent } from "./agent.js";
import type { PendingProposal, StandingCommitment } from "./internal.js";

/**
 * The agent's own state in its belief base, under `AGENT_STATE_PREFIX`, so a
 * belief base that persists what it holds restores the agent with it.
 *
 * - `~agent.goal.<id>`: each unfinished top-level goal, as the goal itself.
 * - `~agent.achieved.<id>`: a goal achieved and collected that a held goal
 *   still `dependsOn`, so the dependency is still met after a restart.
 *
 * Sub-goals are not kept: a restored goal is planned again from its first
 * action, which makes them again.
 */
const GOAL_PREFIX = `${AGENT_STATE_PREFIX}goal.`;
const ACHIEVED_PREFIX = `${AGENT_STATE_PREFIX}achieved.`;

function kept(goal: Goal): boolean {
  return goal.parentGoalId === undefined && !isTerminalGoalStatus(goal.status);
}

/** Writes a goal's record, or removes it once the goal has finished. */
export function saveGoal(agent: Agent, goal: Goal): void {
  const key = GOAL_PREFIX + goal.id;
  if (kept(goal)) {
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

/**
 * Puts back the goals the belief base holds, before the first cycle. A goal
 * that was `active` is `pending` again, since the intention working it is
 * gone. A marker no restored goal depends on is dropped.
 */
export function restoreGoals(agent: Agent): void {
  for (const { value } of agent.store.queryByPrefix(GOAL_PREFIX)) {
    const goal = value as Goal;
    if (agent.goals.get(goal.id)) continue;
    agent.goals.add({
      ...goal,
      status: goal.status === "active" ? "pending" : goal.status,
    });
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

/**
 * A map whose every change is written through to the agent's belief base, under
 * `~agent.conv.<kind>.<key>`: how the agent keeps its conversations.
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
   * @param kind The part of the key after `~agent.conv.`.
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
    return `${CONVERSATION_PREFIX}${this.kind}.${key}`;
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

const CONVERSATION_PREFIX = `${AGENT_STATE_PREFIX}conv.`;

/** A standing commitment as kept: its trigger's goal in flight by id. */
export function encodeStanding(c: StandingCommitment): unknown {
  const { trigger, ...rest } = c;
  if (!trigger) return rest;
  const { inFlight, ...state } = trigger;
  return {
    ...rest,
    trigger: { ...state, ...(inFlight ? { inFlight: inFlight.id } : {}) },
  };
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

/**
 * Puts back the conversations the belief base holds, after the goals:
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
 * - `delegation`: requests sent for a plan's delegation. The intention waiting
 *   on one is not restored, so they are returned, for
 *   {@link cancelOrphanedDelegations} to cancel with the peer once the agent
 *   can send; the plan, run again, delegates afresh.
 *
 * Opened calls and proposals a plan sent belong to their intention, which is
 * not restored, and are not kept.
 */
export function restoreConversations(
  agent: Agent,
): Array<Delegation & { conversationId?: string }> {
  for (const { key, value } of agent.standing.held()) {
    const { trigger, ...c } = value as Omit<StandingCommitment, "trigger"> & {
      trigger?: Omit<TriggerState, "inFlight"> & { inFlight?: string };
    };
    let state: TriggerState | undefined;
    if (trigger) {
      const { inFlight, ...rest } = trigger;
      const goal =
        inFlight !== undefined ? agent.goals.get(inFlight) : undefined;
      state = { ...rest, ...(goal ? { inFlight: goal } : {}) };
    }
    agent.standing.load(key, { ...c, ...(state ? { trigger: state } : {}) });
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
  const orphans: Array<Delegation & { conversationId?: string }> = [];
  for (const { key, value } of agent.remoteDelegations.held()) {
    const { conversationId, ...delegation } = value as OrphanedDelegation;
    orphans.push({
      ...delegation,
      status: "cancelled",
      exchange: key,
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
    agent.remoteDelegations.discard(key);
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
 * Cancels, with each peer, a delegation whose intention a restart ended. The
 * peer's answer to the `cancel` ends the request as any cancel's would.
 */
export async function cancelOrphanedDelegations(
  agent: Agent,
  orphans: Array<Delegation & { conversationId?: string }>,
): Promise<void> {
  for (const { conversationId, ...delegation } of orphans) {
    await agent.cancelDelegation(delegation, conversationId);
  }
}
