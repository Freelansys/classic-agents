import type { Message } from "../../bus/index.js";
import type { Goal } from "../goals.js";
import { isTerminalGoalStatus } from "../goals.js";
import type { Agent } from "./agent.js";
import { replyAddress } from "./helpers.js";
import type { Withdrawal } from "./internal.js";
import type { GoalCancellation } from "./types.js";

/**
 * Withdraws a standing commitment at its sender's request.
 *
 * FIPA's `cancel(j, a)` is `disconfirm(j, I_i Done(a))`: the sender no longer
 * intends that this agent go on with it. The commitment is named by the
 * `cancel`'s `inReplyTo` (the directive's `replyWith`) or, when the cancel
 * names no message, by its conversation. Only the agent that asked may
 * cancel. The reply follows FIPA's cancel meta-protocol: `inform` once it is
 * withdrawn, `failure` when there is nothing of the sender's to withdraw.
 *
 * Cancelling an ordinary request already in progress, including a
 * `request-when` that has fired, is not supported and is refused
 * `unsupported`: it would mean tearing down a running intention.
 */
/** @internal */
export async function handleCancel(agent: Agent, msg: Message): Promise<void> {
  const sender = msg.sender;
  const to = replyAddress(msg);
  if (!sender || sender === agent.id || !to || to === agent.id) {
    return;
  }

  const byExchange =
    msg.inReplyTo !== undefined ? agent.standing.get(msg.inReplyTo) : undefined;
  const commitment =
    byExchange && byExchange.sender === sender
      ? byExchange
      : msg.inReplyTo === undefined && msg.conversationId !== undefined
        ? [...agent.standing.values()].find(
            (c) =>
              c.sender === sender &&
              c.message.conversationId === msg.conversationId,
          )
        : undefined;

  if (commitment) {
    agent.standing.delete(commitment.id);
    await agent.replyToCancel(msg, "inform", {
      cancelled: commitment.kind,
      ...(commitment.goal ? { goal: commitment.goal } : {}),
      name: commitment.name,
    });
    return;
  }

  // Matched on who asked for the goal, not where its replies go: only the
  // requester may cancel, even when it routed its replies elsewhere.
  const open = [...agent.openRequests.values()].find(
    (o) =>
      o.inReplyTo !== undefined &&
      o.inReplyTo === msg.inReplyTo &&
      agent.goals.get(o.goalId)?.source?.sender === sender,
  );
  if (open) {
    await agent.cancelRequest(msg, open.goalId);
    return;
  }

  await agent.replyToCancel(msg, "failure", { reason: "nothing to cancel" });
}

/**
 * Withdraws an agreed request at its requester's `cancel`, and answers the
 * canceller: `inform { cancelled: "request", goal }` once the work has
 * stopped, `failure` when it cannot be. The requester asked for the work to
 * end, so the request gets no `failure` of its own. See {@link withdraw} for
 * when work can be withdrawn.
 */
export async function cancelRequest(
  agent: Agent,
  msg: Message,
  rootGoalId: string,
): Promise<void> {
  await agent.withdraw(rootGoalId, msg.sender, async (outcome) => {
    if (outcome.withdrawn) {
      await agent.replyToCancel(msg, "inform", {
        cancelled: "request",
        goal: outcome.goal.name,
        ...(outcome.cleanupFailures.length > 0
          ? { cleanupFailures: outcome.cleanupFailures }
          : {}),
      });
      return;
    }
    await agent.replyToCancel(msg, "failure", {
      ...(outcome.goal ? { goal: outcome.goal.name } : {}),
      reason: outcome.reason,
    });
  });
}

/**
 * Withdraws a goal and everything under it — its sub-goals, and the
 * intentions working them — then calls `settle` with how it went. Two
 * things withdraw work: a requester's `cancel` of an agreed request, and
 * this agent itself, when it stops waiting for a sub-goal it delegated to
 * itself (the delegation timed out, or the intention waiting on it failed).
 * Both follow the same rules, which are the ones a remote delegate applies to
 * the `cancel` it is sent in the second case.
 *
 * Whether stopping is safe is the plan author's call, not the library's: an
 * action may have half-written a record or charged a card. So:
 *
 * - **Nothing started** — every goal in the tree is still pending — is
 *   always withdrawable: nothing has run that could need undoing.
 * - **Work started** is withdrawable only if every plan with a live
 *   intention in the tree is marked `cancellable: true`. Otherwise nothing
 *   is withdrawn, and the work carries on.
 * - **Never mid-action.** An action is never interrupted. If one of the
 *   tree's actions is running, the withdrawal waits for it and is carried
 *   out at the next action boundary; no further action starts meanwhile.
 *
 * Withdrawing runs each started plan's `onCancel` clean-up (deepest first),
 * cancels the remote delegations those intentions were waiting on, drops the
 * goals, and reports `goal:cancelled`.
 */
export async function withdraw(
  agent: Agent,
  goalId: string,
  by: string,
  settle: (outcome: Withdrawal) => Promise<void>,
): Promise<void> {
  const top = agent.goals.get(goalId);
  if (!top || isTerminalGoalStatus(top.status)) {
    await settle({ withdrawn: false, reason: "nothing to cancel" });
    return;
  }

  const tree = agent.goals
    .getUnfinished()
    .filter((g) => agent.isWithin(g, goalId));
  const started = tree.flatMap((g) =>
    agent.intentions
      .getByGoal(g.id)
      .filter(
        (i) =>
          i.status === "pending" ||
          i.status === "executing" ||
          i.status === "waiting",
      ),
  );

  const stubborn = started.find((i) => i.plan.cancellable !== true);
  if (stubborn) {
    await settle({
      withdrawn: false,
      goal: top,
      reason: `not cancellable: plan "${stubborn.plan.name}" has started and is not marked cancellable`,
    });
    return;
  }

  if (started.some((i) => agent.actionsInFlight.has(i.id))) {
    // Carried out at the next action boundary; nothing new starts until then.
    if (!agent.queuedCancels.some((q) => q.goalId === goalId)) {
      agent.queuedCancels.push({ goalId, by, settle });
    }
    return;
  }

  // A withdrawn request is answered by the cancel, so no terminal reply is
  // owed any more. Only a request's root has an entry; a sub-goal has none.
  agent.openRequests.delete(goalId);

  // Clean-up runs deepest first, so a sub-goal undoes its part before the
  // plan that spawned it.
  const depth = (goal: Goal): number => {
    let d = 0;
    let parent = goal.parentGoalId;
    while (parent) {
      d++;
      parent = agent.goals.get(parent)?.parentGoalId;
    }
    return d;
  };
  const ordered = [...started].sort((a, b) => depth(b.goal) - depth(a.goal));
  const cleanupFailures: Array<{ plan: string; reason: string }> = [];
  for (const intention of ordered) {
    const onCancel = intention.plan.onCancel;
    if (onCancel) {
      try {
        const result = await onCancel.execute(intention, agent.beliefs);
        // A clean-up may write beliefs and send messages; it may not start
        // work in a request that is being withdrawn.
        await agent.applyActionResult(
          { ...result, spawn: undefined, delegations: undefined },
          intention,
        );
        if (result.failure) {
          cleanupFailures.push({
            plan: intention.plan.name,
            reason: result.failure.reason,
          });
        }
      } catch (error) {
        cleanupFailures.push({
          plan: intention.plan.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    agent.intentions.fail(intention.id, "cancelled");
    // Its own sub-goals are in the tree, and are dropped below.
    await agent.abandonDelegations(intention, "cancelled", {
      remoteOnly: true,
    });
  }

  for (const goal of tree) {
    agent.goalEndReasons.set(goal.id, "cancelled");
    agent.goals.setStatus(goal.id, "dropped");
  }
  // Work that was waiting on this goal will not get it.
  agent.dropDependentGoals(goalId);

  agent.emitter.emit("goal:cancelled", {
    agentId: agent.id,
    goal: top,
    by,
    cleanupFailures,
  } satisfies GoalCancellation);

  await settle({ withdrawn: true, goal: top, cleanupFailures });
}

/**
 * Whether a goal is `ancestorId` or lies under it. Walked through
 * `parentGoalId` while the ancestors are still held, with `rootGoalId` for a
 * request's root, whose descendants all name it.
 */
export function isWithin(
  agent: Agent,
  goal: Goal,
  ancestorId: string,
): boolean {
  if (goal.id === ancestorId || goal.rootGoalId === ancestorId) return true;
  let parent = goal.parentGoalId;
  while (parent) {
    if (parent === ancestorId) return true;
    parent = agent.goals.get(parent)?.parentGoalId;
  }
  return false;
}

/** Carries out every queued withdrawal whose tree has no action running. */
export async function processQueuedCancels(agent: Agent): Promise<void> {
  if (agent.queuedCancels.length === 0) return;
  const queued = agent.queuedCancels;
  agent.queuedCancels = [];
  for (const { goalId, by, settle } of queued) {
    await agent.withdraw(goalId, by, settle);
  }
}

/** Answers a `cancel` in its own exchange, at its `reply-to`. */
export async function replyToCancel(
  agent: Agent,
  msg: Message,
  performative: "inform" | "failure",
  content: Record<string, unknown>,
): Promise<void> {
  const to = replyAddress(msg);
  try {
    await agent.sendMessage(to, {
      performative,
      sender: agent.id,
      receiver: to,
      content,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error(`[${agent.id}] Failed to answer a cancel to ${to}:`, error);
  }
}
