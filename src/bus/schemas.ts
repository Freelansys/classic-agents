import { z } from "zod";
import { FIPA_PERFORMATIVES } from "./performatives.js";

/**
 * The whole FIPA-ACL vocabulary — nothing outside SC00037J is recognised.
 */
const KNOWN_PERFORMATIVES = new Set<string>(FIPA_PERFORMATIVES);

/**
 * Whether the agent recognises the performative at all.
 *
 * An unknown performative cannot be understood — there is no handler for it —
 * so the agent answers `not-understood` rather than silently dropping the
 * message. This is distinct from a schema violation on a known performative:
 * one means "I know what you are doing but your message is malformed", the
 * other means "I have never seen this kind of act before", which after the
 * vocabulary was cut back to the 22 CAL acts also covers every name the
 * library used to accept outside it.
 */
export const isKnownPerformative = (performative: string): boolean => {
  return KNOWN_PERFORMATIVES.has(performative);
};

/**
 * Correlation is not modelled here at all.
 *
 * `conversationId`, `reply-with` and `in-reply-to` are FIPA message parameters,
 * so they live on the envelope in {@link MessageSchema} and never inside
 * `content`. This file once carried a `replyFields` object spread into the
 * `agree` and `refuse` schemas, which put them in both places under two
 * different names — and the ones inside content were the ones anything actually
 * read. Schemas here describe what the act *means*; who is answering which
 * message is not part of the meaning.
 */

/**
 * Content shape of a `request`.
 *
 * The agent needs the goal name to create a goal and look up a plan, so it is
 * required. Without it the message cannot be understood as a directive.
 * `query-if` and `query-ref` extend this shape rather than replace it, since
 * both are requests that carry a goal name like any other.
 */
export const requestContentSchema = z.object({
  goal: z.string(),
  goalId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
});

/**
 * Content shape of an `agree`.
 *
 * The receiver names the goal id it assigned so the sender can pair the reply
 * with its request in the sense that matters — which goal this is about. Which
 * *message* it answers is `in-reply-to` on the envelope. The goal name is
 * optional because the sender already knows it.
 */
export const agreeContentSchema = z.object({
  goalId: z.string(),
  goal: z.string().optional(),
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
 * Content shape of a `query-if`.
 *
 * A `query-if` is a request whose goal answers the question, so its content
 * conforms to {@link requestContentSchema} — the required `goal` name is what
 * makes it a proper request the plan library can serve — and adds what is asked:
 * `key` names the belief and `proposition` is the claim to judge. The plan
 * serving the goal reads them to produce the answer: an `inform` carrying
 * `{ status, belief: { key, value } }`, which is the `inform-if` content shape.
 * The reply is sent as an `inform`, and that is a recorded decision, not a
 * deferral: SC00037J decomposes `query-if` as a request to perform `inform-if`
 * but gives it the rational effect of a plain `inform` of φ or ¬φ, so the
 * content shape — not the performative — says which kind of answer it was.
 */
export const queryIfContentSchema = requestContentSchema.extend({
  key: z.string(),
  proposition: z.unknown(),
});

/**
 * Content shape of a `query-ref`.
 *
 * The counterpart of {@link queryIfContentSchema}: a request whose goal responds
 * to the query, carrying `goal` like any request plus `key` and the `expression`
 * whose referent is being asked for. The reply comes as an `inform` carrying
 * `{ result, query }` — the `inform-ref` content shape, sent as an `inform` for
 * the same reason {@link queryIfContentSchema} gives: the rational effect SC00037J
 * assigns to `query-ref` is an `inform` naming the referent.
 */
export const queryRefContentSchema = requestContentSchema.extend({
  key: z.string(),
  expression: z.unknown(),
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
 * Content shape of a propositional performative (inform, confirm, disconfirm, etc.).
 *
 * The store accepts arbitrary content keys — they land in the belief base under
 * `msg.<key>`. The only structured field is an optional `state` that tells the
 * receiver what belief state to write with. When absent, the performative's own
 * default applies (positive for inform/confirm, negative for disconfirm). An
 * invalid state is a schema violation: the receiver cannot map it to a
 * BeliefStatus and must answer `not-understood`.
 */
export const assertionContentSchema = z
  .object({
    state: z.enum(["positive", "uncertain", "negative"]).optional(),
  })
  .loose();

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
    performative === "agree" ||
    performative === "refuse" ||
    performative === "query-if" ||
    performative === "query-ref"
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
      schema = requestContentSchema;
      break;
    case "agree":
      schema = agreeContentSchema;
      break;
    case "refuse":
      schema = refuseContentSchema;
      break;
    case "query-if":
      schema = queryIfContentSchema;
      break;
    case "query-ref":
      schema = queryRefContentSchema;
      break;
    default:
      return true;
  }

  const result = schema.safeParse(content);
  return result.success;
}

/**
 * Whether the performative is propositional and carries an optional state.
 *
 * `inform-if` and `inform-ref` are checked on the same terms as `inform`: both
 * are macro acts that expand into one (`⟨i, inform-if(j, φ)⟩ ≡ ⟨i, inform(j,
 * φ)⟩ | ⟨i, inform(j, ¬φ)⟩`, SC00037J), so a received instance is received as
 * the `inform` it abbreviates. `failure` and `not-understood` are propositional
 * but carry no state of their own.
 */
export const hasAssertionSchema = (performative: string): boolean => {
  return (
    performative === "inform" ||
    performative === "inform-if" ||
    performative === "inform-ref" ||
    performative === "confirm" ||
    performative === "disconfirm"
  );
};

/**
 * Validate a propositional message's content against the assertion schema.
 *
 * Returns `true` when the performative has no schema requirement or when the
 * content satisfies it. Returns `false` when a `state` field is present but
 * does not match one of the valid {@link BeliefStatus} values.
 *
 * `failure` and `not-understood` are also propositional but do not carry a state
 * field, so they bypass this check.
 */
export function validateAssertionContent(
  performative: string,
  content: unknown,
): boolean {
  if (!hasAssertionSchema(performative)) {
    return true;
  }

  const result = assertionContentSchema.safeParse(content);
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
      schema = requestContentSchema;
      break;
    case "agree":
      schema = agreeContentSchema;
      break;
    case "refuse":
      schema = refuseContentSchema;
      break;
    case "query-if":
      schema = queryIfContentSchema;
      break;
    case "query-ref":
      schema = queryRefContentSchema;
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

/**
 * The human-readable reason to attach to a `not-understood` reply when an
 * assertion's state field is invalid.
 */
export function assertionStateReason(content: unknown): string {
  const result = assertionContentSchema.safeParse(content);
  if (result.success) {
    return "";
  }

  const issues = result.error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  return `invalid belief state in content: ${issues.join("; ")}`;
}

/**
 * Whether the message's content carries an explicit belief state.
 *
 * Returns the parsed state when present and valid, or `undefined` when absent.
 */
export function parseAssertionState(
  performative: string,
  content: unknown,
): "positive" | "uncertain" | "negative" | undefined {
  if (!hasAssertionSchema(performative)) {
    return undefined;
  }

  const result = assertionContentSchema.safeParse(content);
  if (!result.success) {
    return undefined;
  }

  const parsed = result.data as {
    state?: "positive" | "uncertain" | "negative";
  };
  return parsed.state;
}
