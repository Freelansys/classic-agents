import type { Message } from "../../bus/index.js";
import type { ExpressionLibrary } from "../expressions.js";
import type { Agent } from "./agent.js";
import { isRecord } from "./helpers.js";
import type { PendingQuery } from "./internal.js";

/** Whether another evaluation may start: see {@link AgentConfig.maxConcurrentEvaluations}. */
export function canEvaluate(agent: Agent): boolean {
  const limit = agent.config.maxConcurrentEvaluations;
  return limit <= 0 || agent.evaluationsInFlight < limit;
}

/**
 * Starts evaluating a proposition or expression without waiting for it, and
 * arranges for `then` to run, inside a later step of a tick, once it
 * settles. This is what keeps a slow evaluation — a service call, a model —
 * from stalling the reasoning cycle: the tick goes on with everything else,
 * and applies the outcome whenever it is ready.
 *
 * Bounded by {@link AgentConfig.evaluationTimeoutMs}: an evaluation still
 * running past it is abandoned and settles as an error, which the caller
 * answers `failure`.
 */
export function startEvaluation(
  agent: Agent,
  library: ExpressionLibrary,
  name: string,
  message: Message,
  then: (
    outcome: { value: unknown } | { error: unknown },
  ) => Promise<void> | void,
): void {
  const timeoutMs = agent.config.evaluationTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const evaluation = library.evaluate(name, agent.beliefs, message);
  const bounded =
    timeoutMs > 0
      ? Promise.race([
          evaluation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
            // A pending evaluation must not keep the process alive.
            timer.unref?.();
          }),
        ])
      : evaluation;

  agent.evaluationsInFlight++;
  const settle = (outcome: { value: unknown } | { error: unknown }): void => {
    if (timer) clearTimeout(timer);
    agent.evaluationsInFlight--;
    agent.settledEvaluations.push(async () => {
      await then(outcome);
    });
  };
  bounded.then(
    (value) => settle({ value }),
    (error: unknown) => settle({ error }),
  );
}

/** Runs the continuation of every evaluation that has settled, in order. */
export async function applySettledEvaluations(agent: Agent): Promise<void> {
  while (agent.settledEvaluations.length > 0) {
    const settled = agent.settledEvaluations;
    agent.settledEvaluations = [];
    for (const apply of settled) {
      try {
        await apply();
      } catch (error) {
        console.error(`[${agent.id}] Failed to apply an evaluation:`, error);
      }
    }
  }
}

/**
 * Opens the question a `query-if` or `query-ref` asks, the way
 * {@link markRequestIntention} opens a request: an `uncertain` belief at
 * `answer.<peer>.<name>.<exchange>`, with no value yet, settled when the
 * reply naming this query arrives.
 *
 * Scoped to the exchange because the name alone is not the whole question: a
 * proposition is evaluated against the asking message too, so `in-stock` for
 * one SKU and for another are two questions with two answers. Prefix-query
 * `answer.<peer>.<name>.` for every answer to that name.
 *
 * Only point-to-point queries are tracked — a query published to a topic has
 * no single peer whose answer settles it — and only ones that name what they
 * ask, since the key is built from the name.
 *
 * A `subscribe` opens the same way, at `subscription.<peer>.<name>.<exchange>`,
 * but stays open: every update the peer sends replaces the value, until this
 * agent cancels it or the peer refuses, fails or does not understand it.
 */
/** @internal */
export function markPendingQuery(
  agent: Agent,
  peer: string,
  query: Message,
): void {
  const name =
    isRecord(query.content) && typeof query.content.name === "string"
      ? query.content.name
      : "";
  if (!name || !query.replyWith) return;

  const standing = query.performative === "subscribe";
  const key = agent.exchangeKey(
    standing ? "subscription" : "answer",
    peer,
    name,
    query.replyWith,
  );
  agent.pendingQueries.set(query.replyWith, {
    peer,
    name,
    question: query.content,
    key,
    exchange: query.replyWith,
    ...(standing ? { standing } : {}),
  });
  agent.beliefs.set(key, undefined, "uncertain");
}

/**
 * The open query this message replies to, if any: it names one of this
 * agent's queries as `inReplyTo` and comes from the agent that was asked.
 * Anything else — an `inform` nobody asked for, or one from a third party
 * naming our id — is not an answer, and takes the ordinary path.
 */
export function pendingQueryFor(
  agent: Agent,
  msg: Message,
): PendingQuery | undefined {
  if (!msg.inReplyTo) return undefined;
  const pending = agent.pendingQueries.get(msg.inReplyTo);
  return pending && pending.peer === msg.sender ? pending : undefined;
}

/**
 * Settles an open query with its answer.
 *
 * The answer is an assertion, so it runs the same `middleware` chain as any
 * other: trust gates an answer exactly as it gates a claim nobody asked for.
 * What changes is where it is filed. Rather than one `msg.*` belief per
 * content key — which would leave `msg.name` and `msg.result` overwritten by
 * the next answer, and the result detached from the question — the result
 * goes to the question's own belief, held `positive`.
 *
 * The value carries the truth: a `query-if` answered `false` is
 * `answer.<peer>.<name>.<exchange> = false`, held positive, which is the
 * belief that the proposition does not hold — FIPA's `inform(¬φ)`. A
 * negative stance is never used to say "false"; one encoding, not two.
 *
 * An answer the chain rejects leaves the belief `uncertain`: the question was
 * answered, but not in a way this agent accepts. Either way the exchange is
 * closed.
 */
export async function settleQueryAnswer(
  agent: Agent,
  msg: Message,
  pending: PendingQuery,
): Promise<void> {
  // A subscription is answered again on every change, so its answer replaces
  // the last rather than closing the question.
  if (!pending.standing) {
    agent.pendingQueries.delete(pending.exchange);
  }
  const content = msg.content;
  const result =
    isRecord(content) && "result" in content ? content.result : content;

  await agent.ingestAssertion(msg, () => {
    agent.beliefs.set(pending.key, result, "positive");
    return { keys: [pending.key], status: "positive" };
  });
}

/**
 * Closes an open query that will not be answered: the peer refused it,
 * failed to evaluate it, or did not understand it.
 *
 * None of those says anything about the proposition or expression itself,
 * so the answer belief is removed rather than set `negative` — under the
 * one-encoding rule a negative stance on it would read as "the proposition
 * does not hold", which nobody said. Why it went unanswered is recorded
 * beside it at `unanswered.<peer>.<name>.<exchange>`, the counterpart of a
 * request's `infeasible.*` record. Held `positive`: it is a fact this agent
 * holds about the exchange.
 */
export function settleUnansweredQuery(
  agent: Agent,
  msg: Message,
  pending: PendingQuery,
): void {
  agent.pendingQueries.delete(pending.exchange);
  agent.beliefs.remove(pending.key);

  const content = isRecord(msg.content) ? msg.content : {};
  agent.beliefs.set(
    agent.exchangeKey(
      "unanswered",
      pending.peer,
      pending.name,
      pending.exchange,
    ),
    {
      performative: msg.performative,
      question: pending.question,
      ...(typeof content.verdict === "string"
        ? { verdict: content.verdict }
        : {}),
      ...(typeof content.reason === "string" ? { reason: content.reason } : {}),
    },
    "positive",
  );
}
