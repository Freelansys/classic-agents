import type { Message } from "../../bus/index.js";
import type { Agent } from "./agent.js";
import { isPast, isRecord } from "./helpers.js";
import type { HeldDirective } from "./internal.js";
import type { DeferredDirective, DirectiveWithdrawn } from "./types.js";

/**
 * Drops every deferred directive whose `reply-by` has passed, as one that
 * arrived late is: its sender has closed the exchange, so a belated `agree`
 * or `refuse` would be for nobody. Reported as `directive:expired`, and as
 * `directive:withdrawn` so whoever holds it for a decision lets it go.
 */
export function expireDeferred(agent: Agent): void {
  for (const held of [...agent.deferredDirectives.values()]) {
    if (isPast(held.message.replyBy)) {
      expire(agent, held);
    }
  }
}

/** Drops one deferred directive whose `reply-by` has passed; see {@link expireDeferred}. */
export function expire(agent: Agent, held: HeldDirective): void {
  agent.deferredDirectives.delete(held.id);
  agent.emitter.emit("directive:expired", held.message);
  agent.emitter.emit("directive:withdrawn", {
    ...payload(held),
    by: "reply-by",
  } satisfies DirectiveWithdrawn);
}

/**
 * Withdraws the deferred directive a `cancel` names, and answers it
 * `inform { cancelled, goal | name }`, with `cancelled` the directive's
 * performative. Matched as {@link handleCancel} matches a standing
 * commitment: by the directive's `replyWith`, or by its conversation when the
 * cancel names no message, and only for the agent that sent it. Returns
 * whether one was found.
 */
export async function withdrawDeferred(
  agent: Agent,
  msg: Message,
): Promise<boolean> {
  const held = [...agent.deferredDirectives.values()].find(
    ({ message }) =>
      message.sender === msg.sender &&
      (msg.inReplyTo !== undefined
        ? message.replyWith === msg.inReplyTo
        : msg.conversationId !== undefined &&
          message.conversationId === msg.conversationId),
  );
  if (!held) {
    return false;
  }

  agent.deferredDirectives.delete(held.id);
  const content = isRecord(held.message.content) ? held.message.content : {};
  await agent.replyToCancel(msg, "inform", {
    cancelled: held.message.performative,
    ...(typeof content.goal === "string" ? { goal: content.goal } : {}),
    ...(typeof content.name === "string" ? { name: content.name } : {}),
  });
  agent.emitter.emit("directive:withdrawn", {
    ...payload(held),
    by: "cancel",
  } satisfies DirectiveWithdrawn);
  return true;
}

/** The public view of a held directive, without the chain's bookkeeping. */
function payload(held: HeldDirective): DeferredDirective {
  return { agentId: held.agentId, id: held.id, message: held.message };
}
