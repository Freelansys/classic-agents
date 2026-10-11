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
 *
 * Only a non-empty string counts for either. A message from a decoding
 * transport can be malformed — `reply-to` present but not a string — and a
 * reply addressed to a non-string names no mailbox; falling back to the sender
 * keeps the answer reachable when the sender itself is sound.
 */
function replyAddress(msg: { sender?: string; replyTo?: string }): string {
  const replyTo =
    typeof msg.replyTo === "string" && msg.replyTo.length > 0
      ? msg.replyTo
      : undefined;
  const sender =
    typeof msg.sender === "string" && msg.sender.length > 0
      ? msg.sender
      : undefined;
  return replyTo ?? sender ?? "";
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
    value === "declined" ||
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

/**
 * The distinct addresses a message's `receiver` names, in order.
 *
 * FIPA's `:receiver` is a set: the envelope carries one address or a list. A
 * set cannot be handed to a bus that delivers to one mailbox, so it is
 * flattened here — with duplicates dropped, since a set names each agent once
 * and a fan-out must not send the same message twice — before one send per
 * address. An absent `receiver`, or an empty list, names nobody.
 */
function asReceiverList(receiver: string | string[] | undefined): string[] {
  if (receiver === undefined) return [];
  const list = Array.isArray(receiver) ? receiver : [receiver];
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const id of list) {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      recipients.push(id);
    }
  }
  return recipients;
}

/** Whether a message's `receiver` names `id`. */
function addressedTo(
  receiver: string | string[] | undefined,
  id: string,
): boolean {
  if (receiver === undefined) return false;
  return Array.isArray(receiver) ? receiver.includes(id) : receiver === id;
}

export {
  addressedTo,
  asReceiverList,
  isDone,
  isPast,
  isRecord,
  isRefusalVerdict,
  replyAddress,
  resolveWaitFor,
};
