import { randomUUID } from "node:crypto";
import type { Message } from "../../bus/index.js";
import { directivePriority } from "../../bus/performatives.js";
import { deepEqual } from "../beliefs.js";
import type { GoalSource } from "../goals.js";
import { Trigger } from "../trigger.js";
import type { Agent } from "./agent.js";
import { isRecord, replyAddress } from "./helpers.js";
import { asDirectiveHost } from "./internal.js";
import type { PendingAgreement, StandingCommitment } from "./internal.js";

/**
 * Agrees to a `request-when`, `request-whenever` or `subscribe` and starts
 * watching it, after the directive middleware chain has admitted it.
 *
 * Declines on the facts only this agent knows, as admission does for a
 * request: a conditional request whose goal no plan serves is refused
 * `no-plan`, and a name the libraries do not hold (the condition of a
 * `request-when*`, the expression of a `subscribe`) is `not-understood`, as
 * an unregistered name is for a query.
 *
 * A `request-when` is not watched here. Its goal is added at once, waiting on
 * its condition as `Goal.when` (see {@link evaluateGoalConditions}), so it
 * takes a queue slot like any request and a full queue refuses it
 * `capacity`. A `request-whenever` and a `subscribe` create no goal until
 * they fire, so capacity is not asked for them: a firing that finds the
 * queue full waits for room rather than being refused after the `agree`.
 *
 * The `agree` names what was committed to. For a conditional request it
 * carries FIPA's φ as `when`, which is what `agree(⟨i, act⟩, φ)` means: I
 * will act, but not until φ. A `request-when` also names its goal id, so the
 * sender can follow the goal while it waits.
 */
export function admitStanding(agent: Agent, msg: Message): void {
  const to = replyAddress(msg);
  if (
    !msg.sender ||
    msg.sender === agent.id ||
    !to ||
    to === agent.id ||
    !isRecord(msg.content)
  ) {
    return;
  }
  const kind = msg.performative as StandingCommitment["kind"] | "request-when";
  const content = msg.content;
  // Never the directive's `replyWith`: that is the sender's own label, unique
  // only among its messages, so two senders' commitments would collide. A
  // `cancel` finds a commitment by sender and `replyWith` instead.
  const id = `standing-${randomUUID()}`;

  const agreement: PendingAgreement = {
    to,
    goal: "",
    ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
    ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
  };

  if (kind === "subscribe") {
    const name = content.name as string;
    if (!agent.expressionLibrary.has(name)) {
      agent.sendNotUnderstood(
        msg,
        `no expression named "${name}" is registered`,
      );
      return;
    }
    agent.standing.set(id, {
      kind,
      message: msg,
      sender: msg.sender,
      replyTo: to,
      id,
      name,
    });
    agent.pendingAcks.push({ ...agreement, name });
    return;
  }

  const goal = content.goal as string;
  const when = content.when as string;
  if (!agent.planLibrary.declares(goal)) {
    asDirectiveHost(agent).declineDirective(msg, "no-plan", {
      reason: `no plan serves "${goal}"`,
    });
    return;
  }
  if (!agent.propositionLibrary.has(when)) {
    agent.sendNotUnderstood(
      msg,
      `no proposition named "${when}" is registered`,
    );
    return;
  }

  if (kind === "request-when") {
    // A request whose goal waits for its condition: added now, held back by
    // `Goal.when`, and agreed to like a request, so it takes a queue slot and
    // a full queue refuses it `capacity`. From here it is the request
    // protocol's: cancelled, failed and answered as any agreed request is.
    const outcome = agent.goalFromMessage(
      msg,
      directivePriority(msg.performative) ?? 5,
      { when },
    );
    if (!outcome) return;
    if (!outcome.admitted) {
      // The queue's own refusal is the one sent; see `admitDirective`.
      asDirectiveHost(agent).declineDirective(msg, "capacity", { send: false });
      return;
    }
    // Evaluated against the directive itself, so the sender's particulars
    // beside the condition's name still apply.
    agent.goalConditions.set(outcome.goalId, {
      holds: false,
      evaluating: false,
      message: msg,
    });
    return;
  }

  agent.standing.set(id, {
    kind,
    message: msg,
    sender: msg.sender,
    replyTo: to,
    id,
    name: when,
    goal,
    trigger: new Trigger({ mode: "edge" }),
  });
  agent.pendingAcks.push({ ...agreement, goal, when });
}

/**
 * Evaluates every standing commitment against the agent's current beliefs
 * and the directive that created it, and acts on what changed. Runs once a
 * tick.
 *
 * - **`request-whenever`** fires each time its proposition goes from not
 *   holding to holding (and once at the start, if it already holds), each
 *   firing a goal of its own with its own terminal answer, until cancelled.
 * - **`subscribe`** sends `inform { name, result }` with the expression's
 *   value now, and again each time the value changes, until cancelled.
 *
 * A firing that finds the goal queue full is kept and retried next tick: the
 * agent agreed to the work, so shedding it with a `refuse` now would break
 * that agreement. An evaluation that throws ends the commitment with a
 * `failure`, FIPA's ending for something undertaken and not completed.
 */
export function evaluateStanding(agent: Agent): void {
  for (const commitment of [...agent.standing.values()]) {
    // One evaluation at a time per commitment: a slow proposition is not
    // started again while the last run is still out.
    if (commitment.evaluating) continue;
    // At the limit, it is evaluated on a later cycle: it was agreed to, so
    // it waits for room rather than being declined.
    if (!agent.canEvaluate()) return;
    commitment.evaluating = true;

    const library =
      commitment.kind === "subscribe"
        ? agent.expressionLibrary
        : agent.propositionLibrary;
    agent.startEvaluation(
      library,
      commitment.name,
      commitment.message,
      async (outcome) => {
        commitment.evaluating = false;
        // Cancelled, or ended by an earlier outcome, while this one ran.
        if (agent.standing.get(commitment.id) !== commitment) return;
        await agent.applyStandingOutcome(commitment, outcome);
      },
    );
  }
}

/**
 * Acts on one evaluation of a standing commitment: reports a subscription's
 * new value, fires a conditional request whose proposition just came to
 * hold, or ends the commitment with `failure` when the evaluation threw or
 * timed out.
 */
export async function applyStandingOutcome(
  agent: Agent,
  commitment: StandingCommitment,
  outcome: { value: unknown } | { error: unknown },
): Promise<void> {
  if ("error" in outcome) {
    agent.standing.delete(commitment.id);
    const kind = commitment.kind === "subscribe" ? "expression" : "proposition";
    const error = outcome.error;
    await agent.sendStandingReply(commitment, "failure", {
      ...(commitment.goal ? { goal: commitment.goal } : {}),
      name: commitment.name,
      reason: `${kind} "${commitment.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  if (commitment.kind === "subscribe") {
    // `null` for "nothing matches", as a query answers it: JSON would drop
    // `undefined` from the content.
    const result = outcome.value === undefined ? null : outcome.value;
    if (commitment.last && deepEqual(commitment.last.value, result)) {
      return;
    }
    commitment.last = { value: result };
    await agent.sendStandingReply(commitment, "inform", {
      name: commitment.name,
      result,
    });
    return;
  }

  commitment.trigger?.observe(outcome.value === true);
  agent.tryFire(commitment);
}

/**
 * Fires a `request-whenever` that is due, if the goal queue has room. A
 * firing that finds it full stays due and is tried again each tick (see
 * {@link retryPendingFires}): the agent agreed to the work, so shedding it
 * with a `refuse` now would break that agreement.
 */
export function tryFire(agent: Agent, commitment: StandingCommitment): void {
  const trigger = commitment.trigger;
  if (!trigger?.ready(agent.goals)) {
    return;
  }
  const goalId = `goal-${randomUUID()}`;
  agent.fireStanding(commitment, goalId);
  trigger.fired(agent.goals.get(goalId));
}

/** Retries every firing that was waiting for room in the goal queue. */
export function retryPendingFires(agent: Agent): void {
  for (const commitment of [...agent.standing.values()]) {
    agent.tryFire(commitment);
  }
}

/**
 * Creates the goal a `request-whenever` firing asks for, sourced from the
 * directive exactly as a request's goal is, and opens the terminal answer it
 * is owed: the same `openRequests` entry an agreed request gets, so the reply
 * on completion or failure is the request protocol's.
 */
export function fireStanding(
  agent: Agent,
  commitment: StandingCommitment,
  goalId: string,
): void {
  const msg = commitment.message;
  const source: GoalSource = {
    sender: commitment.sender,
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
    ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
  };
  const content = isRecord(msg.content) ? msg.content : {};

  agent.openRequests.set(goalId, {
    to: commitment.replyTo,
    goal: commitment.goal ?? "",
    goalId,
    ...(source.conversationId ? { conversationId: source.conversationId } : {}),
    ...(source.inReplyTo ? { inReplyTo: source.inReplyTo } : {}),
  });
  agent.goals.add({
    id: goalId,
    name: commitment.goal ?? "",
    priority: directivePriority(msg.performative) ?? 5,
    status: "pending",
    data: content,
    dependsOn: Array.isArray(content.dependsOn)
      ? (content.dependsOn as string[])
      : undefined,
    source,
  });
}

/**
 * Evaluates the `when` of every pending goal that has one, so deliberation
 * can leave out those whose condition does not hold. Runs once a tick, like
 * {@link evaluateStanding}, and the same way: the proposition is evaluated
 * against the beliefs and a message, and the outcome is recorded whenever it
 * settles. For a `request-when`'s goal the message is the directive itself;
 * for any other goal it is one whose `content` is the goal's `data`.
 *
 * The goal fails, as any goal does, when its condition can never let it
 * through: it names a proposition the agent does not hold, or an evaluation
 * throws or times out. Either way the waiting intention or the requester is
 * told why, and a parent may tolerate the failure or try another plan.
 */
export async function evaluateGoalConditions(agent: Agent): Promise<void> {
  for (const goal of agent.goals.getByStatus("pending")) {
    const when = goal.when;
    if (when === undefined) continue;
    if (!agent.propositionLibrary.has(when)) {
      await agent.failUnplannedGoal(
        goal,
        `no proposition named "${when}" is registered`,
      );
      continue;
    }
    let condition = agent.goalConditions.get(goal.id);
    if (condition?.evaluating) continue;
    if (!agent.canEvaluate()) return;
    if (!condition) {
      condition = { holds: false, evaluating: false };
      agent.goalConditions.set(goal.id, condition);
    }
    const watched = condition;
    watched.evaluating = true;
    agent.startEvaluation(
      agent.propositionLibrary,
      when,
      watched.message ?? {
        performative: "request-when",
        sender: agent.id,
        receiver: agent.id,
        content: goal.data ?? {},
        ...(goal.source?.conversationId
          ? { conversationId: goal.source.conversationId }
          : {}),
        timestamp: Date.now(),
      },
      async (outcome) => {
        watched.evaluating = false;
        // The goal left `pending`, or the queue, while this one ran.
        if (agent.goalConditions.get(goal.id) !== watched) return;
        if ("error" in outcome) {
          const error = outcome.error;
          await agent.failUnplannedGoal(
            goal,
            `proposition "${when}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        watched.holds = outcome.value === true;
      },
    );
  }
}

/** Sends a reply a standing commitment owes, in the directive's exchange. */
export async function sendStandingReply(
  agent: Agent,
  commitment: StandingCommitment,
  performative: "inform" | "failure",
  content: Record<string, unknown>,
): Promise<void> {
  const msg = commitment.message;
  try {
    await agent.sendMessage(commitment.replyTo, {
      performative,
      sender: agent.id,
      receiver: commitment.replyTo,
      content,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error(
      `[${agent.id}] Failed to report on ${commitment.kind} "${commitment.name}" to ${commitment.replyTo}:`,
      error,
    );
  }
}
