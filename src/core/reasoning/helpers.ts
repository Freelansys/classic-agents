import type { ActionResult } from "../plans.js";
import type { RefusalVerdict } from "../plans.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a FIPA `reply-by` has passed. An absent or unparseable one never
 * has: a deadline nobody can read cannot be held against anyone.
 */
function isPast(replyBy: string | undefined): boolean {
  if (replyBy === undefined) return false;
  const deadline = Date.parse(replyBy);
  return !Number.isNaN(deadline) && deadline <= Date.now();
}

/**
 * Where replies to a message go: its FIPA `reply-to` when it names one,
 * otherwise its sender.
 */
function replyAddress(msg: { sender?: string; replyTo?: string }): string {
  return msg.replyTo ?? msg.sender ?? "";
}

/**
 * How many of an action's `count` delegations must succeed, from its
 * `waitFor`. A number is capped at `count`; one below 1, or not a whole
 * number, is a mistake in the plan and fails the action.
 */
function resolveWaitFor(
  waitFor: ActionResult["waitFor"],
  count: number,
): number {
  if (waitFor === undefined || waitFor === "all") return count;
  if (waitFor === "any") return 1;
  if (!Number.isInteger(waitFor) || waitFor < 1) {
    throw new Error(
      `waitFor must be "all", "any" or a whole number of at least 1, not ${String(waitFor)}`,
    );
  }
  return Math.min(waitFor, count);
}

/** Whether a received verdict is one of this library's {@link RefusalVerdict}s. */
function isRefusalVerdict(value: unknown): value is RefusalVerdict {
  return (
    value === "no-plan" ||
    value === "capacity" ||
    value === "unsupported" ||
    value === "middleware"
  );
}

/**
 * Whether an `inform` answering a request is its terminal reply: content
 * carrying `done: true`, as the automatic success reply does. Any other
 * `inform` in the exchange is a note — progress, a partial result.
 */
function isDone(content: unknown): boolean {
  return isRecord(content) && content.done === true;
}

export {
  isDone,
  isPast,
  isRecord,
  isRefusalVerdict,
  replyAddress,
  resolveWaitFor,
};
