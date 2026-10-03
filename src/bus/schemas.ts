import { z } from "zod";
import { FIPA_PERFORMATIVES, LEGACY_PERFORMATIVES } from "./performatives.js";

/**
 * All performatives this library recognises — FIPA-ACL 97 plus legacy aliases.
 */
const KNOWN_PERFORMATIVES = new Set([
  ...FIPA_PERFORMATIVES,
  ...Object.keys(LEGACY_PERFORMATIVES),
]);

/**
 * Whether the agent recognises the performative at all.
 *
 * An unknown performative cannot be understood — there is no handler for it —
 * so the agent answers `not-understood` rather than silently dropping the
 * message. This is distinct from a schema violation on a known performative:
 * one means "I know what you are doing but your message is malformed", the
 * other means "I have never seen this kind of act before".
 */
export const isKnownPerformative = (performative: string): boolean => {
  return KNOWN_PERFORMATIVES.has(performative);
};

/**
 * Shared fields present on conversation-reply performatives.
 */
const replyFields = z.object({
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
});

/**
 * Content shape of a `request` / `delegate` / `achieve`.
 *
 * The agent needs the goal name to create a goal and look up a plan, so it is
 * required. Without it the message cannot be understood as a directive.
 */
export const requestContentSchema = z.object({
  goal: z.string(),
  goalId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
});

/**
 * Content shape of an `agree`.
 *
 * The receiver must name the goal id it assigned so the sender can correlate
 * the reply with its original request. The goal name is optional because the
 * sender already knows it and only `goalId` is needed to promote the intention
 * belief.
 */
export const agreeContentSchema = z.object({
  goalId: z.string(),
  goal: z.string().optional(),
  ...replyFields.shape,
});

/**
 * Content shape of a `refuse`.
 *
 * The goal is required so the sender knows which request is being declined.
 * `verdict` and `reason` are optional because a peer may send a bare `refuse`.
 */
export const refuseContentSchema = z.object({
  goal: z.string(),
  verdict: z.string().optional(),
  reason: z.string().optional(),
  ...replyFields.shape,
});

/**
 * Content shape of a `failure`.
 *
 * `goal` is optional: the standard assertion path always runs, but the semantic
 * record at `failed.<sender>.<goal>` needs it. Without a goal name only the
 * generic `msg.*` keys are stored.
 */
export const failureContentSchema = z.object({
  goal: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Content shape of a `not-understood`.
 *
 * `event` is optional: the standard assertion path always runs, but the semantic
 * record at `not-understood.<sender>.<event>` needs it. Without an event name
 * only the generic `msg.*` keys are stored.
 */
export const notUnderstoodContentSchema = z.object({
  event: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Whether a performative has a content schema that must be satisfied for the
 * message to be understood.
 *
 * Only performatives that carry a compelled meaning (directives and conversation
 * replies) are schema-checked. Assertions are accepted as-is; the belief base
 * stores whatever content arrives, filtered only by middleware.
 */
export const hasContentSchema = (performative: string): boolean => {
  return (
    performative === "request" ||
    performative === "delegate" ||
    performative === "achieve" ||
    performative === "agree" ||
    performative === "refuse"
  );
};

/**
 * Validate a message's content against the schema for its performative.
 *
 * Returns `true` when the content satisfies the expected shape, or when the
 * performative has no schema requirement (assertions and conversation-only
 * performatives). Returns `false` when the content is missing a required field.
 */
export function validateContent(
  performative: string,
  content: unknown,
): boolean {
  if (!hasContentSchema(performative)) {
    return true;
  }

  let schema: z.ZodType<unknown>;
  switch (performative) {
    case "request":
    case "delegate":
    case "achieve":
      schema = requestContentSchema;
      break;
    case "agree":
      schema = agreeContentSchema;
      break;
    case "refuse":
      schema = refuseContentSchema;
      break;
    default:
      return true;
  }

  const result = schema.safeParse(content);
  return result.success;
}

/**
 * The human-readable reason to attach to a `not-understood` reply when schema
 * validation fails. Used by the agent when it detects a malformed directive or
 * reply and needs to tell the sender why it was not acted on.
 */
export function schemaViolationReason(
  performative: string,
  content: unknown,
): string {
  if (!hasContentSchema(performative)) {
    return "";
  }

  let schema: z.ZodType<unknown>;
  switch (performative) {
    case "request":
    case "delegate":
    case "achieve":
      schema = requestContentSchema;
      break;
    case "agree":
      schema = agreeContentSchema;
      break;
    case "refuse":
      schema = refuseContentSchema;
      break;
    default:
      return "";
  }

  const result = schema.safeParse(content);
  if (result.success) {
    return "";
  }

  const issues = result.error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  return `schema violation in "${performative}": ${issues.join("; ")}`;
}
