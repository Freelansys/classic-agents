import { resolveMaxGoals } from "../goals.js";
import type { BeliefKeyFn } from "./types.js";

/**
 * Default bound on the number of unfinished goals an agent holds, pending and
 * active together, sub-goals included. A goal offered once the bound is reached
 * is admitted and immediately failed rather than queued, and the rejection is
 * reported to whoever asked for the work. Override with
 * `AgentConfig.maxGoals`; `0` means unbounded.
 */
export const DEFAULT_MAX_GOALS = 1000;
/** The default {@link BeliefKeyFn}: content keys land under `msg.`. */
export const defaultBeliefKey: BeliefKeyFn = (_msg, key) => `msg.${key}`;
/** Default {@link AgentConfig.replyTimeoutMs}: thirty seconds. */
export const DEFAULT_REPLY_TIMEOUT_MS = 30_000;

/**
 * Default {@link AgentConfig.evaluationTimeoutMs}: ten seconds, well inside
 * the default reply timeout, so a slow query is answered `failure` before the
 * asker gives up on it.
 */
export const DEFAULT_EVALUATION_TIMEOUT_MS = 10_000;

/**
 * Default {@link AgentConfig.maxConcurrentEvaluations}: a hundred. Generous
 * for quick reads, and a ceiling on what a burst of queries can pile onto a
 * slow belief store.
 */
export const DEFAULT_MAX_CONCURRENT_EVALUATIONS = 100;

/**
 * Default {@link AgentConfig.delegationTimeoutMs}: five minutes. Long enough
 * for ordinary work, short enough that a delegate that went quiet does not
 * hold the delegating intention indefinitely.
 */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 300_000;

/**
 * Default `Desire.retryAfterMs`: one second. How long a desire waits, after a
 * goal it generated failed, before it fires again — so a goal that fails every
 * time is not re-run every cycle.
 */
export const DEFAULT_DESIRE_RETRY_MS = 1_000;

/**
 * How many exchanges' interaction protocols an agent remembers, so its replies
 * can carry the protocol of the message they answer. The oldest is forgotten
 * first; a reply to an exchange that old is sent without a `protocol` rather
 * than with a wrong one.
 */
export const MAX_REMEMBERED_PROTOCOLS = 10_000;

/** `maxGoals` is a count or unbounded, never a negative or fractional one. */
function resolveAgentMaxGoals(value: number | undefined): number {
  return resolveMaxGoals(value, DEFAULT_MAX_GOALS);
}

export { resolveAgentMaxGoals };
