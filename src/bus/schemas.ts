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
 */
export const requestContentSchema = z.object({
  goal: z.string(),
  goalId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
});

/**
 * Content shape of an `agree`.
 *
 * An agreement names what it commits to, so the sender can pair the reply with
 * its directive in the sense that matters. Which *message* it answers is
 * `in-reply-to` on the envelope. At least one of:
 *
 * - `goalId` — the goal the receiver assigned: for a `request`, and for a
 *   `request-when`, whose goal id is assigned at agreement and used once the
 *   condition holds.
 * - `when` — FIPA's φ in `agree(⟨i, act⟩, φ)`: the proposition the receiver
 *   will act on, for a `request-when` or `request-whenever`. A
 *   `request-whenever` names no goal id, since each time it fires is a goal of
 *   its own.
 * - `name` — the expression a `subscribe` will report on.
 *
 * The goal name is optional because the sender already knows it.
 */
export const agreeContentSchema = z
  .object({
    goalId: z.string().optional(),
    goal: z.string().optional(),
    when: z.string().optional(),
    name: z.string().optional(),
  })
  .refine(
    (content) =>
      content.goalId !== undefined ||
      content.when !== undefined ||
      content.name !== undefined,
    { message: "an agree must name a goal id, a condition or an expression" },
  );

/**
 * Content shape of a `refuse`.
 *
 * A refusal names what it declines, so the sender knows which directive it
 * answers: `goal` for a refused `request`, `name` for a refused `query-if` or
 * `query-ref` — a query creates no goal, and names the proposition or
 * expression it asks about instead. One of the two is required. `verdict` and
 * `reason` are optional because a peer may send a bare `refuse`.
 */
export const refuseContentSchema = z
  .object({
    goal: z.string().optional(),
    name: z.string().optional(),
    verdict: z.string().optional(),
    reason: z.string().optional(),
  })
  .refine(
    (content) => content.goal !== undefined || content.name !== undefined,
    {
      message: "a refuse must name the goal or the query it declines",
    },
  );

/**
 * Content shape of a `failure`.
 *
 * `goal` is optional: the standard assertion path always runs, but the semantic
 * record at `failed.<sender>.<goal>` needs it. Without a goal name only the
 * generic `msg.*` keys are stored. A failed query carries `name` instead — the
 * proposition or expression whose evaluation could not complete.
 */
export const failureContentSchema = z.object({
  goal: z.string().optional(),
  name: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Content shape of a `query-if` and a `query-ref`.
 *
 * Both name a single computation the receiver answers from its own knowledge:
 * `query-if` names a {@link Proposition}, `query-ref` an {@link Expression}. The
 * performative already says which library answers, so one `name` field serves
 * both — the wire carries which one is wanted, and the receiver keeps the
 * implementation behind the name. A query carries no goal and creates no work;
 * the answer is an evaluation, not a plan run.
 */
export const queryContentSchema = z.object({
  name: z.string(),
});

/**
 * Content shape of a `request-when` and a `request-whenever`.
 *
 * A request, plus `when`: the name of the {@link Proposition} the receiver
 * evaluates against its own beliefs (and this message) to decide when to act.
 * The wire carries the name; the receiver owns the implementation.
 */
export const requestWhenContentSchema = requestContentSchema.extend({
  when: z.string(),
});

/**
 * Content shape of a `subscribe`: the name of the {@link Expression} whose
 * value the receiver reports now and each time it changes.
 */
export const subscribeContentSchema = z.object({
  name: z.string(),
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
 * The schema a performative's content must satisfy to be understood, by
 * performative. Only performatives that carry a compelled meaning (directives
 * and conversation replies) have one. Assertions are accepted as-is; the belief
 * base stores whatever content arrives, filtered only by middleware.
 */
const CONTENT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = {
  request: requestContentSchema,
  "request-when": requestWhenContentSchema,
  "request-whenever": requestWhenContentSchema,
  subscribe: subscribeContentSchema,
  agree: agreeContentSchema,
  refuse: refuseContentSchema,
  "query-if": queryContentSchema,
  "query-ref": queryContentSchema,
};

/**
 * Whether a performative has a content schema that must be satisfied for the
 * message to be understood.
 */
export const hasContentSchema = (performative: string): boolean => {
  return Object.hasOwn(CONTENT_SCHEMAS, performative);
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
  const schema = CONTENT_SCHEMAS[performative];
  return schema ? schema.safeParse(content).success : true;
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
  const schema = CONTENT_SCHEMAS[performative];
  if (!schema) {
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
