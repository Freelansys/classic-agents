import type { Message } from "../../bus/index.js";
import type { GoalSource } from "../goals.js";
import type { Agent } from "./agent.js";
import { isRecord, replyAddress } from "./helpers.js";
import { asDirectiveHost } from "./internal.js";
import type { DirectiveOutcome, PendingAgreement } from "./internal.js";
import { randomUUID } from "node:crypto";

/**
 * Decides whether to take on a directive, and acts on the decision.
 *
 * FIPA-ACL gives `request` a compelled hearer effect but does not make it an
 * obligation: the receiver may decline. So the directive is a request, and
 * this is where saying yes or no happens — before any goal exists, so a
 * declined directive consumes no queue slot and leaves nothing to collect.
 *
 * Reached only when the whole {@link DirectiveMiddleware} chain called
 * `next`, so by this point the application has declined anything it wanted to
 * decline. The agent agrees to every well-formed request it has capacity for,
 * declining on the two facts only it can know: whether a plan serves the
 * goal, and whether the queue has room. That is a choice, not a rule of FIPA:
 * it is what "compliant" means for an agent that has not been told otherwise.
 * Queries never reach here; `answerQuery` is their terminal step.
 */
export function admitDirective(
  agent: Agent,
  msg: Message,
  priority: number,
): void {
  const goalName = isRecord(msg.content)
    ? (msg.content.goal as string)
    : undefined;

  if (!goalName) {
    // A request with no goal in its content cannot be served: there is no
    // plan to consult and nothing sensible to put in the queue. Instead of
    // dropping it silently, refuse so the sender gets an answer. Every
    // directive schema requires a goal name — a query creates no goal, so
    // only `request` reaches here — and reaching this branch means the
    // middleware chain replaced the content with something unreadable, and
    // the agent still owes the sender a reply.
    asDirectiveHost(agent).declineDirective(msg, "unsupported", {
      reason: `this agent does not implement "${msg.performative}"`,
    });
    return;
  }

  // Asked before the goal exists, which is the only place worth asking from.
  // A plan library is fixed for the agent's lifetime and a plan declares the
  // goal it serves, so "no plan can do this" is a fact about the agent, not
  // a question about current beliefs. Answering here rather than leaving the
  // goal in the queue is what keeps an unservable request from holding a
  // `maxGoals` slot for the rest of the run: with nothing able to select a
  // plan for it, such a goal would never reach a terminal status, and the
  // agent would slowly brick itself, agreeing to work it could never do and
  // refusing the work it could.
  if (!agent.planLibrary.declares(goalName)) {
    asDirectiveHost(agent).declineDirective(msg, "no-plan", {
      reason: `no plan serves "${goalName}"`,
    });
    return;
  }

  const outcome = agent.goalFromMessage(msg, priority);
  if (!outcome) {
    return;
  }

  if (!outcome.admitted) {
    // The queue refused the goal at admission, for want of capacity. The
    // queue is what declined it, so it also owns the reply: reportRejections
    // has already queued the `refuse`, naming the id it assigned and the
    // bound it hit. Re-declining here would send the sender two refusals for
    // one request, so this only raises the local event, leaving the queue's
    // answer as the single one that goes out.
    asDirectiveHost(agent).declineDirective(msg, "capacity", { send: false });
  }
}

/**
 * Answers a `query-if` or `query-ref` from the agent's knowledge, after the
 * directive middleware chain has admitted the question.
 *
 * A query is a directive the receiver *answers*, not a piece of work: it
 * names a {@link Proposition} (`query-if`) or an {@link Expression}
 * (`query-ref`) and the agent evaluates it against its own beliefs and the
 * message that asked. The two map one-to-one onto the libraries chosen at
 * construction, so nothing here parses the subject — the wire carries a
 * name, and the receiver owns the implementation behind it. No goal is
 * created, nothing is queued, and apart from the middleware chain's say-so
 * there is nothing to refuse: the answer is the evaluation.
 *
 * The answer is a plain `inform` carrying `{ name, result }`, in the same
 * exchange as the question — the conversation, and `in-reply-to` naming it —
 * so the sender pairs it with its query. An unknown name is `not-understood`:
 * the agent does not know that condition, which is a different answer from
 * knowing it to be false, and it is how the sender learns whether the name
 * is a question this agent can read at all. Whether a name is known is
 * asked of the library's registry (`has`), never inferred from the result.
 * A registered expression that finds nothing — answers `undefined` — is
 * answered `result: null`: "none" is an answer. An evaluation that throws is
 * a `failure { name, reason }` in the same exchange: the question was read
 * and an answer attempted, and it could not be completed.
 */
export function answerQuery(agent: Agent, msg: Message): void {
  const to = replyAddress(msg);
  if (!msg.sender || msg.sender === agent.id || !to || to === agent.id) {
    return;
  }

  const content = isRecord(msg.content) ? msg.content : {};
  const name = content.name;
  if (typeof name !== "string" || name.length === 0) {
    const kind = msg.performative === "query-if" ? "proposition" : "expression";
    agent.sendNotUnderstood(msg, `a "${msg.performative}" names no ${kind}`);
    return;
  }

  const isProposition = msg.performative === "query-if";
  const kind = isProposition ? "proposition" : "expression";
  const library = isProposition
    ? agent.propositionLibrary
    : agent.expressionLibrary;

  // Asked before evaluating, so "this agent does not know that name" is
  // decided by the registry alone. A registered body that answers
  // `undefined` has answered; it must not read as an unknown name.
  if (!library.has(name)) {
    agent.sendNotUnderstood(msg, `no ${kind} named "${name}" is registered`);
    return;
  }

  const reply = {
    sender: agent.id,
    receiver: to,
    ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
    ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
  };

  // At the limit, the question is declined for now rather than queued: the
  // same backpressure a full goal queue answers a request with, and the
  // same transient verdict, so the asker may ask again.
  if (!agent.canEvaluate()) {
    void agent.sendMessage(to, {
      ...reply,
      performative: "refuse",
      content: {
        name,
        verdict: "capacity",
        reason: `evaluation limit reached (${agent.config.maxConcurrentEvaluations} at once)`,
      },
      timestamp: Date.now(),
    });
    return;
  }

  // Started, not awaited: a slow proposition answers on a later cycle
  // rather than holding this one up. See `startEvaluation`.
  agent.startEvaluation(library, name, msg, async (outcome) => {
    if ("error" in outcome) {
      // The agent read the question and tried to answer it, and the
      // evaluation could not complete (it threw, or ran past the evaluation
      // timeout): FIPA's `failure`, not a refusal.
      const error = outcome.error;
      await agent.sendMessage(to, {
        ...reply,
        performative: "failure",
        content: {
          name,
          reason: `${kind} "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        timestamp: Date.now(),
      });
      return;
    }

    // "Nothing matches" is an answer, not a failure to understand: the
    // question was read and evaluated, and its referent is none. It goes on
    // the wire as `null` because JSON drops `undefined` — `{ name, result:
    // undefined }` would arrive as `{ name }`, and the asker could not tell
    // an empty answer from a malformed one.
    const result = outcome.value;
    await agent.sendMessage(to, {
      ...reply,
      performative: "inform",
      content: { name, result: result === undefined ? null : result },
      timestamp: Date.now(),
    });
  });
}

/**
 * Turns a directive that carries a goal name — today only `request` — into a
 * goal, recording where it came from so the sender can follow it through
 * decomposition and failure notices.
 *
 * A caller may pin the id with `content.goalId`; it is honoured only while
 * free, since a taken id would otherwise silently overwrite an existing goal.
 * Either way the sender is told which id was assigned via an `agree`, so it
 * never has to guess.
 */
export function goalFromMessage(
  agent: Agent,
  msg: Message,
  priority: number,
): DirectiveOutcome | undefined {
  if (!isRecord(msg.content)) {
    return undefined;
  }

  const content = msg.content;
  const goalName = content.goal as string;
  if (!goalName) {
    return undefined;
  }

  const requestedId =
    typeof content.goalId === "string" && content.goalId.trim()
      ? content.goalId
      : undefined;

  const goalId =
    requestedId && !agent.goals.get(requestedId)
      ? requestedId
      : `goal-${randomUUID()}`;

  const source: GoalSource = {
    sender: msg.sender,
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
    ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
  };

  agent.goals.add({
    id: goalId,
    name: goalName,
    priority,
    status: "pending",
    data: content,
    dependsOn: Array.isArray(content.dependsOn)
      ? (content.dependsOn as string[])
      : undefined,
    source,
  });

  // The queue fails a goal it has no room for, having first admitted it so
  // the refusal is a lifecycle the event stream can describe. Read that back
  // rather than predicting it: the bound is checked inside the queue.
  const admitted = agent.goals.get(goalId)?.status !== "failed";

  // Agreed here, on admission, because by this point every question that can
  // be answered "no" has been: the middleware chain admitted it, the plan
  // library said it is able, and the queue said there is room. A plain
  // request carries no condition to defer on — the work starts on the next
  // cycle — so taking it on is the whole of the commitment.
  //
  // Answering ourselves would just be noise: an agent subscribed to a
  // topic receives its own publishes.
  const to = replyAddress(msg);
  if (
    admitted &&
    msg.sender &&
    msg.sender !== agent.id &&
    to &&
    to !== agent.id
  ) {
    const agreement: PendingAgreement = {
      to,
      goal: goalName,
      goalId,
      ...(source.conversationId
        ? { conversationId: source.conversationId }
        : {}),
      ...(source.inReplyTo ? { inReplyTo: source.inReplyTo } : {}),
    };
    agent.pendingAcks.push(agreement);
    // Opened with the `agree`, because agreeing is what makes a terminal
    // answer owed: from here until the goal settles, this exchange is
    // waiting for exactly one `inform` or `failure`.
    agent.openRequests.set(goalId, { ...agreement, goalId });
  }

  return { goalId, admitted };
}
