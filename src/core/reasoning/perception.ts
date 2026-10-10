import type { Message } from "../../bus/index.js";
import {
  directivePriority,
  directsAction,
  hasHearerEffect,
  isPropositional,
  isQueryDirective,
  isStandingDirective,
  isUnsupportedDirective,
} from "../../bus/performatives.js";
import { isKnownPerformative } from "../../bus/schemas.js";
import type { BeliefStatus } from "../beliefs.js";
import type { InboxEntry } from "../inbox.js";
import type { Agent } from "./agent.js";
import { isPast, isRecord } from "./helpers.js";
import { asDirectiveHost } from "./internal.js";
import type { BeliefRejectionReason } from "./types.js";

export function handleMessage(agent: Agent, msg: Message): void {
  // Reported before queueing, so a monitor sees every message that
  // arrives — including the ones no performative produces anything from.
  agent.emitter.emit("message:received", msg);
  // Queued rather than acted on. The bus calls this synchronously, from
  // inside a `publish` or a `send`, so anything decided here would be
  // decided on the sender's stack, before the receiver had reasoned about
  // anything.
  agent.inbox.push(msg);
}

/**
 * Takes everything the bus has delivered since the last cycle.
 *
 * Percept of the cycle: the events that happened, in the order they did.
 * They are passed straight to {@link reviseBeliefs} and not retained — a
 * percept is not a belief, and holding one past the decision would make it
 * state after all.
 */
export function perceive(agent: Agent): InboxEntry[] {
  return agent.inbox.drain();
}

/**
 * Turns this cycle's percepts into beliefs and goals, by performative.
 *
 * The split is the point of FIPA-ACL's communicative-act classes, and it is
 * what separates what a message *asks* from what it *claims*:
 *
 * - a **directive** is the one performative with a compelled hearer effect.
 *   `request` is offered to the goal queue — and only because this library
 *   chooses to comply; FIPA leaves the receiver free to `refuse`, and a
 *   request can come back declined, for want of capacity or for want of a
 *   plan, before a goal ever exists. `query-if` and `query-ref` are
 *   directives too, but ones the receiver *answers* rather than works: they
 *   run the same middleware chain and are then evaluated against the agent's
 *   knowledge, creating no goal. `request-when`, `request-whenever` and
 *   `subscribe` leave a standing commitment instead, watched every tick.
 * - an **assertion** asks nothing of the receiver. FIPA's rational effect is
 *   that the receiver believes it, but that is the sender's aim, not a
 *   duty, so becoming a belief is a decision the agent makes under its
 *   `middleware` chain, never a consequence of having received it.
 * - everything else — an expressive, a commissive, an unclassified act — is
 *   about the conversation rather than the world, and produces no state.
 *   `cancel` included: it withdraws a commitment.
 *
 * The standing directives are classed assertive as well, because SC00037J
 * defines them as an `inform` of the sender's intention. What they assert is
 * that intention, not their content, so a directive's content never reaches
 * the belief base.
 */
export async function reviseBeliefs(
  agent: Agent,
  percepts: InboxEntry[],
): Promise<void> {
  for (const { message } of percepts) {
    // An unknown performative cannot be understood — there is no handler for
    // it. Answer `not-understood` so the sender can tell "heard and unknown"
    // from "never heard". The sender is required so we do not loop-reply to
    // ourselves.
    if (
      !isKnownPerformative(message.performative) &&
      message.sender &&
      message.sender !== agent.id
    ) {
      const reason = `unknown performative: "${message.performative}"`;
      agent.sendNotUnderstood(message, reason);
      continue;
    }

    // Any reply from the peer naming one of our directives is its first
    // reply, whatever it says, so the `reply-by` clock on it stops.
    if (
      message.inReplyTo !== undefined &&
      agent.awaitingReply.get(message.inReplyTo)?.peer === message.sender
    ) {
      agent.awaitingReply.delete(message.inReplyTo);
    }

    // A directive whose `reply-by` passed before this agent got to it is
    // dropped unanswered: its sender has already closed the exchange, so
    // agreeing or working would be for nobody. Reported locally instead.
    if (
      hasHearerEffect(message.performative) &&
      message.sender !== agent.id &&
      isPast(message.replyBy)
    ) {
      agent.emitter.emit("directive:expired", message);
      continue;
    }

    // The reply to a cancel this agent sent settles the request or
    // subscription it named, whatever the reply's act.
    const pendingCancel = agent.pendingCancelFor(message);
    if (pendingCancel) {
      await agent.settleCancelReply(message, pendingCancel);
      continue;
    }

    // A reply to one of this agent's own queries settles the question it
    // asked, before any other reading of the message. Matched by
    // `inReplyTo`, never by the content's shape, so an `inform` nobody asked
    // for is still an ordinary assertion.
    const pendingQuery = agent.pendingQueryFor(message);
    if (pendingQuery) {
      switch (message.performative) {
        case "inform":
        case "inform-if":
        case "inform-ref":
        case "confirm":
          await agent.settleQueryAnswer(message, pendingQuery);
          continue;
        case "agree":
          // FIPA's query protocol lets the receiver agree before answering.
          // The question stays open; the answer is still to come.
          continue;
        case "refuse":
          agent.settleUnansweredQuery(message, pendingQuery);
          await agent.handleRefusalMessage(message);
          continue;
        case "failure":
        case "not-understood":
          // The query went unanswered; the record says why. The generic
          // assertion path is skipped, so the reply does not also land as
          // loose `msg.*` beliefs detached from the question.
          agent.settleUnansweredQuery(message, pendingQuery);
          continue;
      }
    }

    // An `inform` answering one of this agent's requests is that request's
    // result, filed under its exchange rather than as loose `msg.*`
    // beliefs: `done: true` completes it, anything else is a note on it.
    const sentRequest = agent.sentRequestFor(message);
    if (
      sentRequest &&
      (message.performative === "inform" ||
        message.performative === "inform-if" ||
        message.performative === "inform-ref" ||
        message.performative === "confirm")
    ) {
      await agent.settleRequestInform(message, sentRequest);
      continue;
    }

    // The answer to a directive, before anything about the world: an
    // agreement or refusal is bookkeeping about a conversation, and must not
    // reach the belief base even though both are class-assertive.
    if (message.performative === "agree") {
      agent.handleAgreement(message);
      continue;
    }

    if (message.performative === "refuse") {
      await agent.handleRefusalMessage(message);
      continue;
    }

    // `failure` and `not-understood` are asserts in FIPA's own model (§3): their
    // rational effect is `Bj α`, the same shape as `inform`. They carry a
    // proposition about what happened (a failed attempt, a perceived problem)
    // and the receiver decides whether to believe it under its middleware.
    // In addition to the standard assertion path, we store a semantic belief
    // so plans can query what other agents have failed on or not understood.
    if (message.performative === "failure") {
      await agent.handleFailureMessage(message);
      continue;
    }

    if (message.performative === "not-understood") {
      await agent.handleNotUnderstoodMessage(message);
      continue;
    }

    // `cancel` withdraws a standing commitment this agent holds for the
    // sender. It is about the conversation, not the world, so it never
    // reaches the belief base either.
    if (message.performative === "cancel") {
      await agent.handleCancel(message);
      continue;
    }

    // Every directive this agent honours runs the same middleware chain, then
    // takes its own path: a request becomes a goal, a query is answered by
    // evaluating, and a standing directive — `request-when`,
    // `request-whenever`, `subscribe` — is agreed to and watched every tick.
    //
    // A directive this agent cannot act on does not go through
    // `considerDirective`. That is `cfp` alone: it asks for a proposal inside
    // a negotiation this library keeps no state for, and is answered
    // `unsupported` — FIPA's own latitude, the hearer of a directive may
    // refuse — rather than quietly doing something else.
    if (
      isQueryDirective(message.performative) ||
      isStandingDirective(message.performative)
    ) {
      await asDirectiveHost(agent).considerDirective(
        message,
        directivePriority(message.performative) ?? 5,
      );
    } else if (isUnsupportedDirective(message.performative)) {
      await asDirectiveHost(agent).handleUnsupportedDirective(message);
    } else if (directsAction(message.performative)) {
      await asDirectiveHost(agent).considerDirective(
        message,
        directivePriority(message.performative) ?? 5,
      );
    }

    // Only what the sender asserts reaches the belief base. `request-when`,
    // `request-whenever` and `subscribe` are classed assertive too, since
    // SC00037J defines them as an `inform` of the sender's intention, but
    // what they assert is that *intention* — not their content. Storing `{ goal, when }` as beliefs
    // would have the receiver believe its own instructions.
    if (
      isPropositional(message.performative) &&
      !hasHearerEffect(message.performative)
    ) {
      // A message carries no stance: the sender of an `inform` believes what
      // it says (FIPA's feasibility precondition), so the receiver's stance
      // follows from the act alone — see `ingestAssertion`.
      await agent.ingestAssertion(message);
    }
  }
}

/**
 * Runs an assertion's content into the belief base, through the configured
 * middleware that cancelled or threw before it.
 *
 * The chain is built per message: the terminal step performs the write, and
 * each middleware either calls `next` or cancels by returning. Both the chain
 * and the write are async, since a middleware is allowed to do I/O.
 *
 * Trust is the default and lives here: an agent with no middleware believes
 * what it is told. Everything that makes that interruptible is above the write,
 * not inside it, so a user withdrawing the assumption never has to reimplement
 * the storing.
 *
 * `store` replaces the default write — one belief per content key under the
 * act's own stance — for an assertion the agent files somewhere specific,
 * such as the answer to a query it asked. The chain in front of it is the
 * same, so trust gates an answer exactly as it gates any other claim.
 */
/**
 * Runs an assertion through the belief middleware and, if the chain lets it
 * through, stores it. Resolves to whether it was stored — believed.
 */
/** @internal */
export async function ingestAssertion(
  agent: Agent,
  msg: Message,
  store?: () => { keys: string[]; status: BeliefStatus },
): Promise<boolean> {
  // Captured rather than re-read inside the chain: the narrowing from
  // `isRecord` would not survive a property access inside a closure. A
  // custom `store` files the whole content itself, so it does not need a
  // record to iterate.
  const content = isRecord(msg.content) ? msg.content : undefined;
  if (!content && !store) {
    return false;
  }
  const middleware = agent.config.middleware;
  const index = { at: 0 };

  // At most one outcome per message, decided by the first thing that speaks
  // to it: the middleware that cancelled or threw before the write. Collected
  // and reported once below, so a single message can never produce two
  // notices.
  let outcome: { reason: BeliefRejectionReason } | undefined;
  let reachedWrite = false;
  let stored: string[] | undefined;
  let statusOf: BeliefStatus = "positive";

  // Terminal step: the write the chain exists to be able to interrupt.
  const write = async (): Promise<void> => {
    reachedWrite = true;

    if (store) {
      const written = store();
      stored = written.keys;
      statusOf = written.status;
      return;
    }

    // SC00037 gives disconfirm the rational effect Bj ¬φ — the receiver comes
    // to hold the *negation*, not merely to stop holding φ. The store keeps a
    // stance beside each value, so that is a write held "negatively": the key
    // is still there, still named the same content, and the sender's stance
    // toward it was the opposite. Reading that stance as *not p* needs an
    // ontology, so the reading stays with the user and classic-agents records
    // only the stance. Every other propositional act asserts its content, so
    // it is held "positively".
    //
    // The stance is the receiver's, derived from the act and never read off
    // the wire. FIPA has no uncertain `inform` — its sender must believe what
    // it says — so a message asserts or denies, and `"uncertain"` is only
    // ever something an agent holds about its own open questions. A `state`
    // key in the content is ordinary content like any other.
    statusOf =
      msg.performative === "disconfirm"
        ? ("negative" as const)
        : ("positive" as const);

    const beliefKey = agent.config.beliefKey;
    // Reached only with a record: without one, `store` was required above.
    const fields = content ?? {};
    stored = Object.keys(fields).map((key) => beliefKey(msg, key));
    for (const [key, value] of Object.entries(fields)) {
      agent.beliefs.set(beliefKey(msg, key), value, statusOf);
    }
  };

  const step = async (): Promise<void> => {
    if (index.at >= middleware.length) {
      await write();
      return;
    }
    const current = middleware[index.at++];
    try {
      await current(msg, step);
    } catch (error) {
      // A chain that threw has not established that the rest of it should be
      // trusted, so the write does not happen and the rest is not run. Caught
      // rather than rethrown: one bad middleware should not end the tick.
      outcome = {
        reason: `middleware threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  await step();

  // Reaching the write with nothing to say means the belief was stored — that
  // is the accepting case, reported as its own event. Reaching it without
  // either means the chain ended short: some middleware returned without calling
  // `next`, the documented way to cancel.
  if (outcome === undefined && !reachedWrite) {
    outcome = { reason: "middleware" };
  }
  if (outcome) {
    agent.emitter.emit("belief:rejected", {
      agentId: agent.id,
      reason: outcome.reason,
      message: msg,
    });
  } else if (stored) {
    agent.emitter.emit("belief:accepted", {
      agentId: agent.id,
      keys: stored,
      status: statusOf,
      message: msg,
    });
  }
  return outcome === undefined && reachedWrite;
}
