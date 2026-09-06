/**
 * Transport-agnostic message bus interface for agent communication.
 *
 * All transport implementations (in-memory, Redis Streams, NATS, etc.)
 * must satisfy this interface. Agent and plan code depend only on this
 * abstraction — never on a concrete transport.
 */

/** Performative speech act of a message, following FIPA-ACL style. */
export type Performative =
  "inform" | "request" | "achieve" | "query" | "confirm" | "failure";

/** A message exchanged between agents on the bus. */
export interface Message<T = unknown> {
  performative: Performative;
  sender: string;
  receiver?: string;
  topic?: string;
  content: T;
  conversationId?: string;
  timestamp: number;
}

/** Handler function invoked when a message is received. */
export type MessageHandler = (msg: Message) => void;

/**
 * Transport-agnostic message bus.
 *
 * Supports both point-to-point (send/registerAgent) and pub/sub
 * (publish/subscribe) patterns. Implementations must not leak
 * synchronous delivery guarantees into agent logic.
 */
export interface MessageBus {
  /** Publish a message to a topic (all subscribers receive it). */
  publish(topic: string, message: Message): Promise<void>;

  /** Subscribe to a topic. Returns an unsubscribe function. */
  subscribe(topic: string, handler: MessageHandler): () => void;

  /** Send a message directly to an agent by id. */
  send(agentId: string, message: Message): Promise<void>;

  /** Register an agent's inbox callback for point-to-point delivery. */
  registerAgent(agentId: string, inbox: MessageHandler): void;
}
