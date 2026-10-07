import { z } from "zod";

import type { Performative } from "./performatives.js";

export type { Performative } from "./performatives.js";

/**
 * The FIPA-ACL message parameters, as the vocabulary this bus speaks.
 *
 * The interface below is derived from this schema rather than written beside
 * it, so the two cannot drift. That is not a style choice: `Message.id` and the
 * `messageId` used in reply payloads were once the same value under two names,
 * nothing ever read either of them, and neither had a FIPA counterpart. A
 * schema the type is generated from makes that failure unrepresentable.
 *
 * The `topic` parameter is a library addition rather than a FIPA one — pub/sub
 * has no counterpart in the ACL message structure — and it is kept here so
 * transport concerns stay part of the same validated shape.
 */
export const MessageSchema = z.object({
  performative: z
    .string()
    .describe("Denotes the type of the communicative act of the ACL message"),
  sender: z
    .string()
    .describe(
      "Denotes the identity of the sender of the message, that is, the name of the agent of the communicative act.",
    ),
  receiver: z
    .string()
    .optional()
    .describe(
      "Denotes the identity of the intended recipients of the message.",
    ),
  topic: z
    .string()
    .optional()
    .describe("Denotes the topic to which the message belongs."),
  replyTo: z
    .string()
    .optional()
    .describe(
      "This parameter indicates that subsequent messages in this conversation thread are to be directed to the agent named in thereply-to parameter, instead of to the agent named in the sender parameter.",
    ),
  content: z
    .unknown()
    .describe(
      "Denotes the content of the message; equivalently denotes the object of the action. The meaning of the content of any ACL message is intended to be interpreted by the receiver of the message. This is particularly relevant for instance when referring to referential expressions, whose interpretation might be different for the sender and the receiver.",
    ),
  language: z
    .string()
    .optional()
    .describe(
      "Denotes the language in which the content parameter is expressed.",
    ),
  encoding: z
    .string()
    .optional()
    .describe(
      "Denotes the specific encoding of the content language expression.",
    ),
  ontology: z
    .string()
    .optional()
    .describe(
      "Denotes the ontology(s) used to give a meaning to the symbols in the content expression.",
    ),
  protocol: z
    .string()
    .optional()
    .describe(
      "Denotes the interaction protocol that the sending agent is employing with this ACL message.",
    ),
  conversationId: z
    .string()
    .optional()
    .describe(
      "Introduces an expression (a conversation identifier) which is used to identify the ongoing sequence of communicative acts that together form a conversation.",
    ),
  replyWith: z
    .string()
    .optional()
    .describe(
      "Introduces an expression that will be used by the responding agent to identify this message.",
    ),
  inReplyTo: z
    .string()
    .optional()
    .describe(
      "Denotes an expression that references an earlier action to which this message is a reply.",
    ),
  replyBy: z
    .string()
    .optional()
    .describe(
      "Denotes a time and/or date expression which indicates the latest time by which the sending agent would like to receive a reply.",
    ),
  timestamp: z.number().describe("The time at which the message was created."),
});

/**
 * A message exchanged between agents on the bus.
 *
 * Only `performative` and `content` narrow off the schema: the vocabulary
 * rejects a performative the agent does not recognise, and `content` stays
 * generic so callers can type what they put in it.
 *
 * Every FIPA parameter is carried by this type whether the library reads it yet
 * or not, so a peer speaking the standard is never forced to drop a field it
 * cares about. The correlation parameters are all optional here for the same
 * reason: adopting a framework should not force an opinion on someone whose
 * producer already stamps its own ids, or whose ids live somewhere else.
 *
 * Optional on the type does not mean unset in practice. `Agent.sendMessage`
 * stamps `conversationId` and `replyWith` on every point-to-point message it
 * sends, so anything classic-agents sends is correlated. Nothing in the library
 * assumes they are present on a message it *receives*, so a third party that
 * sends a bare message still works — it simply participates in correlation
 * only as far as it opts in. The framing is the library's opinion; the type is
 * not.
 */
export type Message<T = unknown> = Omit<
  z.infer<typeof MessageSchema>,
  "performative" | "content"
> & {
  performative: Performative;
  content: T;
};

/** Handler function invoked when a message is received. */
export type MessageHandler = (msg: Message) => void;

/**
 * Transport-agnostic message bus.
 *
 * All transport implementations (in-memory, Redis Streams, NATS, etc.) must
 * satisfy this interface. Agent and plan code depend only on this abstraction
 * — never on a concrete transport.
 *
 * Supports both point-to-point (send/registerAgent) and pub/sub
 * (publish/subscribe) patterns. Implementations must not leak
 * synchronous delivery guarantees into agent logic.
 */
export interface MessageBus {
  /** Publish a message to a topic (all subscribers receive it). */
  publish(topic: string, message: Message): Promise<void>;

  /**
   * Subscribe to a topic. Resolves once the subscription is live on the
   * transport (e.g. Redis has acknowledged the SUBSCRIBE), so awaiting it
   * before publishing guarantees delivery. Returns an unsubscribe function.
   */
  subscribe(topic: string, handler: MessageHandler): Promise<() => void>;

  /** Send a message directly to an agent by id. */
  send(agentId: string, message: Message): Promise<void>;

  /** Register an agent's inbox callback for point-to-point delivery. */
  registerAgent(agentId: string, inbox: MessageHandler): void;
}
