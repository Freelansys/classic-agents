import { randomUUID } from "node:crypto";
import type { Message } from "../../bus/index.js";
import { directivePriority } from "../../bus/performatives.js";
import { deepEqual } from "../beliefs.js";
import type { Goal, GoalSource } from "../goals.js";
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
 * an unregistered name is for a query. Capacity is not asked here: nothing is
 * queued until the condition holds, and a firing that finds the queue full
 * waits for room rather than being refused after the `agree`.
 *
 * The `agree` names what was committed to. For a conditional request it
 * carries FIPA's φ as `when`, which is what `agree(⟨i, act⟩, φ)` means: I
 * will act, but not until φ. A `request-when` also gets its goal id now, so
 * the sender can follow the goal that will exist later.
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
  const kind = msg.performative as StandingCommitment["kind"];
  const content = msg.content;
  const id = msg.replyWith ?? `standing-${randomUUID()}`;

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

  const goalId = kind === "request-when" ? `goal-${randomUUID()}` : undefined;
  agent.standing.set(id, {
    kind,
    message: msg,
    sender: msg.sender,
    replyTo: to,
    id,
    name: when,
    goal,
    ...(goalId !== undefined ? { goalId } : {}),
  });
  agent.pendingAcks.push({
    ...agreement,
    goal,
    when,
    ...(goalId !== undefined ? { goalId } : {}),
  });
}

/**
 * Evaluates every standing commitment against the agent's current beliefs
 * and the directive that created it, and acts on what changed. Runs once a
 * tick.
 *
 * - **`request-when`** fires the first time its proposition holds,
 *   including at once if it already holds when agreed to, and is then an
 *   ordinary request: its goal is created under the id the `agree` named,
 *   and answered `inform` or `failure` when it ends.
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

  const holds = outcome.value === true;
  const rose = holds && commitment.last?.value !== true;
  commitment.last = { value: holds };
  if (rose) {
    commitment.pendingFire = true;
  }
  agent.tryFire(commitment);
}

/**
 * Fires a conditional request that is due, if the goal queue has room. A
 * firing that finds it full stays due and is tried again each tick (see
 * {@link retryPendingFires}): the agent agreed to the work, so shedding it
 * with a `refuse` now would break that agreement.
 */
export function tryFire(agent: Agent, commitment: StandingCommitment): void {
  if (!commitment.pendingFire || agent.goals.atCapacity()) {
    return;
  }
  commitment.pendingFire = false;
  agent.fireStanding(commitment, commitment.goalId ?? `goal-${randomUUID()}`);
  if (commitment.kind === "request-when") {
    // Fired once, it is an ordinary request now, answered when its goal
    // ends; there is nothing left to watch or to cancel.
    agent.standing.delete(commitment.id);
  }
}

/** Retries every firing that was waiting for room in the goal queue. */
export function retryPendingFires(agent: Agent): void {
  for (const commitment of [...agent.standing.values()]) {
    agent.tryFire(commitment);
  }
}

/**
 * Creates the goal a conditional request asked for, sourced from the
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
