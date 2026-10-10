import { randomUUID } from "node:crypto";
import type { ChildFailure, Delegation, Intention } from "../intentions.js";
import {
  isOpenDelegation,
  isAwaitingWork,
  openDelegations,
} from "../intentions.js";
import type { DelegationRequest } from "../plans.js";
import type { Goal } from "../goals.js";
import type { Agent } from "./agent.js";
import type { DelegationSettled } from "./types.js";

/**
 * The record of the self-delegation that created a sub-goal. Every sub-goal
 * an action creates has one; an intention whose `children` were filled in by
 * hand gets one made up on the spot, so it settles the same way.
 */
export function localDelegation(
  agent: Agent,
  intention: Intention,
  child: Goal,
): Delegation {
  const found = intention.delegations.find(
    (d) => d.receiver === agent.id && d.goalId === child.id,
  );
  if (found) return found;
  const made: Delegation = {
    receiver: agent.id,
    goal: child.name,
    status: "agreed",
    goalId: child.id,
  };
  intention.delegations.push(made);
  return made;
}

/**
 * Settles one of an intention's delegations — its own sub-goal or a remote
 * request — and decides what the intention does about it. The one place a
 * waiting intention is released, whatever kind of work it was waiting for.
 *
 * A failure is recorded in `childFailures`; what happens next is decided by
 * {@link reviewDelegations} against the action's `waitFor`. A delegation
 * already settled is left alone, so a late or repeated answer changes
 * nothing.
 */
export async function settleDelegation(
  agent: Agent,
  intention: Intention,
  delegation: Delegation,
  outcome: { done: unknown } | { failed: string },
): Promise<void> {
  if (!isOpenDelegation(delegation)) {
    return;
  }
  if ("done" in outcome) {
    delegation.status = "done";
    if (outcome.done !== undefined) delegation.result = outcome.done;
  } else {
    delegation.status = "failed";
    delegation.reason = outcome.failed;
  }
  const local = delegation.exchange === undefined;
  if (local) {
    intention.children = intention.children.filter(
      (id) => id !== delegation.goalId,
    );
  }
  agent.emitter.emit("delegation:settled", {
    intention,
    delegation: { ...delegation },
  } satisfies DelegationSettled);

  if (intention.status !== "waiting") {
    return;
  }

  if ("failed" in outcome) {
    intention.childFailures.push({
      ...(delegation.goalId !== undefined ? { goalId: delegation.goalId } : {}),
      goal: delegation.goal,
      reason: outcome.failed,
      ...(local
        ? {}
        : { receiver: delegation.receiver, exchange: delegation.exchange }),
    } satisfies ChildFailure);
  }
  await agent.reviewDelegations(
    intention,
    "failed" in outcome ? delegation : undefined,
  );
}

/**
 * Decides what a waiting intention does now that one of its delegations
 * settled, from the batch the last delegating action made and its
 * `waitFor`:
 *
 * - **Enough succeeded**: the rest are no longer needed, so they are
 *   cancelled, and the intention resumes.
 * - **The target can still be met**: it keeps waiting, whatever failed.
 * - **It cannot**: the intention fails if any failure in the batch was one
 *   its `onFailure` says not to tolerate;
 *   otherwise it resumes once nothing is left open.
 */
export async function reviewDelegations(
  agent: Agent,
  intention: Intention,
  justFailed: Delegation | undefined,
): Promise<void> {
  const batch = agent.delegationBatches.get(intention.id) ?? {
    from: 0,
    needed: intention.delegations.length,
  };
  const members = intention.delegations.slice(batch.from);
  const open = members.filter(isOpenDelegation).length;
  const done = members.filter((d) => d.status === "done").length;
  // Sub-goals put in `children` by hand have no record in the batch, and
  // keep the intention waiting until they settle too.
  const strays = intention.children.some(
    (id) => !intention.delegations.some((d) => d.goalId === id),
  );

  if (done >= batch.needed && !strays) {
    if (open > 0) {
      await agent.abandonDelegations(
        intention,
        `no longer needed: ${done} of ${members.length} succeeded`,
      );
    }
    agent.resumeIntention(intention);
    return;
  }
  if (done + open >= batch.needed) {
    return;
  }

  const required = members.filter(
    (d) => d.status === "failed" && agent.failurePolicy(d) === "fail",
  );
  if (required.length > 0) {
    const culprit =
      justFailed && required.includes(justFailed)
        ? justFailed
        : required[required.length - 1];
    const failed =
      culprit.exchange === undefined
        ? `sub-goal "${culprit.goal}" failed: ${culprit.reason}`
        : `delegation of "${culprit.goal}" to ${culprit.receiver} failed: ${culprit.reason}`;
    await agent.failIntention(
      intention,
      batch.needed < members.length
        ? `${done} of ${batch.needed} needed delegations succeeded; ${failed}`
        : failed,
    );
    return;
  }
  if (!isAwaitingWork(intention)) {
    agent.resumeIntention(intention);
  }
}

/** Whether a delegation's failure is tolerated: `"fail"` unless it says so. */
export function failurePolicy(
  _agent: Agent,
  delegation: Delegation,
): "fail" | "continue" {
  return delegation.onFailure ?? "fail";
}

/** A waiting intention goes back to work, its batch of delegations done with. */
export function resumeIntention(agent: Agent, intention: Intention): void {
  agent.delegationBatches.delete(intention.id);
  agent.intentions.setStatus(intention.id, "executing");
}

/**
 * Hands one goal off for an action, and records the delegation on the
 * intention. A self-delegation becomes a sub-goal; any other a `request`.
 */
export async function delegate(
  agent: Agent,
  request: DelegationRequest,
  intention: Intention,
): Promise<Delegation> {
  const receiver = request.receiver ?? agent.id;
  const local = receiver === agent.id;
  const timeoutMs =
    request.timeoutMs === null
      ? 0
      : (request.timeoutMs ?? (local ? 0 : agent.config.delegationTimeoutMs));
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const parent = intention.goal;

  if (local) {
    const goalId = `goal-${randomUUID()}`;
    const delegation: Delegation = {
      receiver,
      goal: request.goal,
      status: "agreed",
      goalId,
      ...(deadline !== undefined ? { deadline } : {}),
      ...(request.onFailure ? { onFailure: request.onFailure } : {}),
    };
    intention.delegations.push(delegation);
    intention.children.push(goalId);
    agent.goals.add({
      id: goalId,
      name: request.goal,
      priority: request.priority ?? 5,
      status: "pending",
      data: request.view,
      parentGoalId: parent.id,
      rootGoalId: parent.rootGoalId ?? parent.id,
      // Inherited so the original sender stays traceable however deep the
      // decomposition goes.
      ...(parent.source ? { source: parent.source } : {}),
    });
    return delegation;
  }

  // A request of the goal's conversation, but an exchange of its own: no
  // `inReplyTo` (it answers nothing) and a fresh `replyWith`, which every
  // reply names back and which keys the delegation.
  const conversationId = parent.source?.conversationId;
  const sent = await agent.sendMessage(receiver, {
    performative: "request",
    sender: agent.id,
    receiver,
    content: { ...request.view, goal: request.goal },
    ...(conversationId ? { conversationId } : {}),
    timestamp: Date.now(),
  });
  const exchange = sent.replyWith!;
  const delegation: Delegation = {
    receiver,
    goal: request.goal,
    status: "sent",
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
  return delegation;
}

/**
 * A request this agent sent has ended — done, failed, refused, not
 * understood, unanswered, or cancelled. Stops tracking it, and settles the
 * delegation it carried, if it carried one.
 *
 * Every way a request ends comes through here, so no path can leave a
 * delegating intention waiting on a request that is already over.
 */
/** @internal */
export async function endSentRequest(
  agent: Agent,
  exchange: string,
  outcome: { done: unknown } | { failed: string },
): Promise<void> {
  agent.sentRequests.delete(exchange);
  const delegated = agent.remoteDelegations.get(exchange);
  if (!delegated) {
    return;
  }
  agent.remoteDelegations.delete(exchange);
  await agent.settleDelegation(
    delegated.intention,
    delegated.delegation,
    outcome,
  );
}

/**
 * Fails every open delegation whose deadline has passed, and asks its work
 * to stop: a remote receiver is sent a `cancel`, and a self-delegated
 * sub-goal is withdrawn under the same rules (see {@link withdraw}).
 */
export async function expireDelegations(agent: Agent): Promise<void> {
  const now = Date.now();
  for (const intention of agent.intentions.getByStatus("waiting")) {
    for (const delegation of openDelegations(intention)) {
      if (delegation.deadline === undefined || delegation.deadline > now) {
        continue;
      }
      const reason = `not done by ${new Date(delegation.deadline).toISOString()}`;
      if (delegation.exchange !== undefined) {
        const conversationId = agent.remoteDelegations.get(
          delegation.exchange,
        )?.conversationId;
        agent.remoteDelegations.delete(delegation.exchange);
        await agent.cancelDelegation(delegation, conversationId);
      }
      await agent.settleDelegation(intention, delegation, { failed: reason });
      if (delegation.exchange === undefined) {
        await agent.withdrawSubGoal(delegation);
      }
    }
  }
}

/**
 * An intention stopped waiting — it failed, or was cancelled — with
 * delegations still open. Each is marked `cancelled` and its work asked to
 * stop, so nobody goes on working for nobody: a remote receiver is sent a
 * `cancel`, and a self-delegated sub-goal is withdrawn the way that receiver
 * would treat it (see {@link withdraw}).
 *
 * `remoteOnly` leaves the sub-goals to the caller: a withdrawal already
 * drops every goal in its tree.
 */
/** @internal */
export async function abandonDelegations(
  agent: Agent,
  intention: Intention,
  reason: string,
  options: { remoteOnly?: boolean } = {},
): Promise<void> {
  const local: Delegation[] = [];
  for (const delegation of intention.delegations) {
    if (!isOpenDelegation(delegation)) {
      continue;
    }
    if (delegation.exchange === undefined && options.remoteOnly) {
      continue;
    }
    delegation.status = "cancelled";
    delegation.reason = reason;
    agent.emitter.emit("delegation:settled", {
      intention,
      delegation: { ...delegation },
    } satisfies DelegationSettled);
    if (delegation.exchange === undefined) {
      intention.children = intention.children.filter(
        (id) => id !== delegation.goalId,
      );
      local.push(delegation);
      continue;
    }
    const conversationId = agent.remoteDelegations.get(
      delegation.exchange,
    )?.conversationId;
    agent.remoteDelegations.delete(delegation.exchange);
    void agent.cancelDelegation(delegation, conversationId);
  }
  for (const delegation of local) {
    await agent.withdrawSubGoal(delegation);
  }
}

/**
 * Withdraws a self-delegated sub-goal nobody waits for any more. If it
 * cannot be withdrawn — a started plan is not `cancellable` — it runs on,
 * as a remote delegate that answered the `cancel` with `failure` would.
 */
export async function withdrawSubGoal(
  agent: Agent,
  delegation: Delegation,
): Promise<void> {
  if (delegation.goalId === undefined) return;
  await agent.withdraw(delegation.goalId, agent.id, async () => {});
}

/**
 * Asks a delegation's receiver to stop: a `cancel` naming the request as
 * `inReplyTo`. Its reply is filed like that of any cancel this agent sends.
 */
export async function cancelDelegation(
  agent: Agent,
  delegation: Delegation,
  conversationId: string | undefined,
): Promise<void> {
  try {
    const sent = await agent.sendMessage(delegation.receiver, {
      performative: "cancel",
      sender: agent.id,
      receiver: delegation.receiver,
      content: {
        goal: delegation.goal,
        ...(delegation.goalId !== undefined
          ? { goalId: delegation.goalId }
          : {}),
      },
      ...(conversationId ? { conversationId } : {}),
      inReplyTo: delegation.exchange!,
      timestamp: Date.now(),
    });
    const pending = agent.pendingCancels.get(sent.replyWith!);
    if (pending) {
      pending.abandoned = true;
    } else {
      // Not tracked — the request had already ended — so nothing will
      // close it later either.
      agent.sentRequests.delete(delegation.exchange!);
    }
  } catch (error) {
    // Undeliverable, so no answer is coming: stop tracking the request.
    agent.sentRequests.delete(delegation.exchange!);
    console.error(
      `[${agent.id}] Failed to cancel ${delegation.goal} with ${delegation.receiver}:`,
      error,
    );
  }
}
