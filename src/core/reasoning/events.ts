import type { Goal } from "../goals.js";
import { isTerminalGoalStatus } from "../goals.js";
import type { Intention } from "../intentions.js";
import { isTerminalIntentionStatus } from "../intentions.js";
import type { Agent } from "./agent.js";
import type {
  GoalRejection,
  GoalStatusChange,
  IntentionFailed,
} from "./types.js";

export function onGoalAdded(agent: Agent, goal: Goal): void {
  const stored = agent.goals.get(goal.id) ?? goal;
  agent.lastGoalStatus.set(stored.id, stored.status);
  agent.emitter.emit("goal:added", stored);
}

export function onGoalStatusChanged(agent: Agent, goal: Goal): void {
  const from = agent.lastGoalStatus.get(goal.id) ?? goal.status;
  agent.lastGoalStatus.set(goal.id, goal.status);
  agent.emitter.emit("goal:status", {
    goal,
    from,
    to: goal.status,
  } satisfies GoalStatusChange);

  // The terminal transition is where the request protocol's answer is owed,
  // so it is taken from there rather than from the handful of call sites that
  // reach it: `completeIntention`, `failIntention`, a goal dropped by
  // `dependsOn`, and anything else that finishes an agreed goal. One choke
  // point, so no path can end silently.
  if (isTerminalGoalStatus(goal.status)) {
    agent.queueOutcome(goal);
  }
}

/**
 * A goal left the queue. Releases the intentions waiting on it and drops the
 * remembered status, so neither outlives the goal.
 *
 * A goal collected after finishing has already had its terminal answer
 * queued, so its open request is gone by now. One still open means the goal
 * was taken out before it finished — an explicit `goals.remove()` — and the
 * requester, who holds an `agree` for it, is owed the `failure` here: no
 * terminal transition is coming that would send it.
 *
 * A goal taken out before it finished also takes its work with it: see
 * {@link abandonRemovedGoal}.
 */
export function onGoalRemoved(agent: Agent, goal: Goal): void {
  agent.lastGoalStatus.delete(goal.id);
  const open = agent.openRequests.get(goal.id);
  if (open) {
    agent.openRequests.delete(goal.id);
    agent.pendingOutcomes.push({
      ...open,
      performative: "failure",
      reason: "goal removed before it finished",
    });
  }
  agent.goalEndReasons.delete(goal.id);
  // Read by the parent's release, so dropped only after it.
  agent.releaseWaitingParents(goal);
  agent.goalResults.delete(goal.id);
  if (!isTerminalGoalStatus(goal.status)) {
    void agent.abandonRemovedGoal(goal);
  }
  agent.emitter.emit("goal:removed", goal);
}

/**
 * Stops the work of a goal removed before it finished. Its intention has
 * nothing left to work for, so it is failed — which cancels its open
 * delegations, as for any failed intention: a remote delegate is sent a
 * `cancel`, and its own sub-goals are withdrawn under the rules a `cancel`
 * follows. Goals that depended on it are dropped, since it will never be
 * achieved.
 *
 * An action already running is never interrupted. It finishes, its result
 * is applied, and the intention is failed then, before another action
 * starts (see {@link executeIntention}).
 */
export async function abandonRemovedGoal(
  agent: Agent,
  goal: Goal,
): Promise<void> {
  for (const intention of agent.intentions.getByGoal(goal.id)) {
    if (
      isTerminalIntentionStatus(intention.status) ||
      agent.actionsInFlight.has(intention.id)
    ) {
      continue;
    }
    await agent.failOrphanedIntention(intention);
  }
  agent.dropDependentGoals(goal.id);
}

/**
 * Fails an intention whose goal has left the queue. Unlike
 * {@link failIntention}, there is no goal to fail and no parent to tell —
 * removing the goal already released its parent — so this only ends the
 * intention and the work it handed off.
 */
export async function failOrphanedIntention(
  agent: Agent,
  intention: Intention,
): Promise<void> {
  const reason = "goal removed before it finished";
  agent.intentions.fail(intention.id, reason);
  agent.emitter.emit("intention:failed", {
    intention,
    reason,
  } satisfies IntentionFailed);
  await agent.abandonDelegations(intention, reason);
}

export function onIntentionRemoved(agent: Agent, intention: Intention): void {
  agent.delegationBatches.delete(intention.id);
  agent.emitter.emit("intention:removed", intention);
}

/**
 * Queues a refusal for the next cycle. Reporting is deferred, like the goal
 * acknowledgements, so a goal that arrives from a message is answered on a
 * tick rather than from inside the bus's synchronous delivery.
 */
export function onGoalRejected(agent: Agent, goal: Goal): void {
  const rejection = {
    goal,
    reason: `rejected: goal queue is full (limit ${agent.config.maxGoals})`,
  } satisfies GoalRejection;
  agent.pendingRejections.push(rejection);
  agent.emitter.emit("goal:rejected", rejection);
}
