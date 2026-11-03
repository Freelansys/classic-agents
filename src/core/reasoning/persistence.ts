import { AGENT_STATE_PREFIX } from "../beliefs.js";
import type { Goal } from "../goals.js";
import { isTerminalGoalStatus } from "../goals.js";
import type { Delegation } from "../intentions.js";
import { planName } from "../plans.js";
import { Trigger } from "../trigger.js";
import type { TriggerState } from "../trigger.js";
import type { Agent } from "./agent.js";
import type {
  AwaitedReply,
  HeldDirective,
  OpenRequest,
  PendingCancel,
  PendingProposal,
  PendingQuery,
  SentRequest,
  StandingCommitment,
} from "./internal.js";

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
 * The agent's conversations, under `~agent.conv.<kind>.<id>`: what it agreed
 * to and has not answered, what it asked and still waits on, and the
 * commitments it holds.
 *
 * - `standing`: `request-whenever` and `subscribe` commitments, with what
 *   their trigger has seen and a subscription's last value, so neither fires
 *   nor reports again for a condition that already held.
 * - `open`: directives agreed to and not yet answered terminally.
 * - `query`, `sent`, `awaited`, `cancel`: queries, requests and cancels sent
 *   and still awaiting their answer or reply deadline.
 * - `deferred`: directives the middleware chain holds for a later decision.
 * - `bid`: bids made on a `cfp` and not yet decided, with their plan by name.
 * - `protocol`: the interaction protocol of each exchange, for the replies.
 * - `delegation`: requests sent for a plan's delegation. The intention waiting
 *   on one is not restored, so a restart cancels it with the peer, and the
 *   plan, run again, delegates afresh.
 *
 * Opened calls and proposals a plan sent belong to their intention, which is
 * not restored, and are not kept.
 *
 * Conversations change in place in many spots, so rather than at each one
 * they are written at the end of every cycle: each entry is compared with
 * what was last written for it, and only the ones that changed are written.
 */
const CONVERSATION_PREFIX = `${AGENT_STATE_PREFIX}conv.`;

/** What was last written for each conversation key, as JSON. */
const written = new WeakMap<Agent, Map<string, string>>();

function writtenFor(agent: Agent): Map<string, string> {
  let map = written.get(agent);
  if (!map) {
    map = new Map();
    written.set(agent, map);
  }
  return map;
}

function conversationEntries(agent: Agent): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  const put = (kind: string, id: string, value: unknown) =>
    entries.set(`${CONVERSATION_PREFIX}${kind}.${id}`, value);
  for (const [id, c] of agent.standing) {
    const { trigger, evaluating: _evaluating, ...rest } = c;
    put("standing", id, {
      ...rest,
      ...(trigger ? { trigger: trigger.state() } : {}),
    });
  }
  for (const [id, r] of agent.openRequests) put("open", id, r);
  for (const [id, q] of agent.pendingQueries) put("query", id, q);
  for (const [id, r] of agent.sentRequests) put("sent", id, r);
  for (const [id, r] of agent.awaitingReply) put("awaited", id, r);
  for (const [id, c] of agent.pendingCancels) put("cancel", id, c);
  for (const [id, d] of agent.deferredDirectives) put("deferred", id, d);
  for (const [id, p] of agent.pendingProposals) {
    const { plan, evaluating: _evaluating, ...rest } = p;
    put("bid", id, { ...rest, plan: planName(plan) });
  }
  for (const [id, protocol] of agent.exchangeProtocols) {
    put("protocol", id, protocol);
  }
  for (const [id, { delegation, conversationId }] of agent.remoteDelegations) {
    put("delegation", id, {
      receiver: delegation.receiver,
      goal: delegation.goal,
      ...(delegation.goalId !== undefined ? { goalId: delegation.goalId } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
    } satisfies OrphanedDelegation);
  }
  return entries;
}

/** Writes the conversations that changed since the last write. */
export function saveConversations(agent: Agent): void {
  const last = writtenFor(agent);
  const current = conversationEntries(agent);
  for (const [key, value] of current) {
    const json = JSON.stringify(value);
    if (last.get(key) === json) continue;
    last.set(key, json);
    // Written as plain JSON, so the store holds no live object the agent
    // goes on changing, and a persistent store can write what it is given.
    agent.store.set(key, JSON.parse(json));
  }
  for (const key of [...last.keys()]) {
    if (current.has(key)) continue;
    last.delete(key);
    if (agent.store.has(key)) agent.store.remove(key);
  }
}

/** A request sent for a delegation whose intention a restart has ended. */
interface OrphanedDelegation {
  receiver: string;
  goal: string;
  goalId?: string;
  conversationId?: string;
}

/**
 * Puts back the conversations the belief base holds, after the goals. An
 * agreed directive whose goal is gone is answered with `failure`, and a bid
 * whose plan is gone is dropped. Returns the delegations to cancel, which
 * {@link cancelOrphanedDelegations} sends once the agent can send.
 */
export function restoreConversations(
  agent: Agent,
): Array<Delegation & { conversationId?: string }> {
  const last = writtenFor(agent);
  const orphans: Array<Delegation & { conversationId?: string }> = [];
  for (const { key, value } of agent.store.queryByPrefix(CONVERSATION_PREFIX)) {
    last.set(key, JSON.stringify(value));
    const rest = key.slice(CONVERSATION_PREFIX.length);
    const dot = rest.indexOf(".");
    const kind = rest.slice(0, dot);
    const id = rest.slice(dot + 1);
    switch (kind) {
      case "standing": {
        const { trigger: state, ...c } = value as Omit<
          StandingCommitment,
          "trigger"
        > & { trigger?: TriggerState };
        const trigger = new Trigger({ mode: "edge" });
        if (state) trigger.restore(state, agent.goals);
        agent.standing.set(id, { ...c, trigger });
        break;
      }
      case "open":
        agent.openRequests.set(id, value as OpenRequest);
        break;
      case "query":
        agent.pendingQueries.set(id, value as PendingQuery);
        break;
      case "sent":
        agent.sentRequests.set(id, value as SentRequest);
        break;
      case "awaited":
        agent.awaitingReply.set(id, value as AwaitedReply);
        break;
      case "cancel":
        agent.pendingCancels.set(id, value as PendingCancel);
        break;
      case "deferred":
        agent.deferredDirectives.set(id, value as HeldDirective);
        break;
      case "bid": {
        const { plan: name, ...bid } = value as Omit<
          PendingProposal,
          "plan"
        > & {
          plan: string;
        };
        const plan = agent.planLibrary.all().find((p) => planName(p) === name);
        if (plan) agent.pendingProposals.set(id, { ...bid, plan });
        break;
      }
      case "protocol":
        agent.exchangeProtocols.set(id, value as string);
        break;
      case "delegation": {
        const { conversationId, ...delegation } = value as OrphanedDelegation;
        orphans.push({
          ...delegation,
          status: "cancelled",
          exchange: id,
          ...(conversationId !== undefined ? { conversationId } : {}),
        });
        break;
      }
    }
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
