import { EventEmitter } from "node:events";
import type { Message, MessageBus, MessageHandler } from "./types.js";

/**
 * In-memory message bus implementation.
 *
 * Uses Node's EventEmitter for pub/sub and per-agent mailbox queues
 * for point-to-point delivery. Suitable for single-process, in-memory
 * agents. Drop-in replacements (Redis Streams, NATS) can satisfy the
 * same `MessageBus` interface.
 */
export class InMemoryMessageBus implements MessageBus {
  private readonly emitter = new EventEmitter();
  private readonly mailboxes = new Map<string, MessageHandler>();

  constructor() {
    // Prevent Node from throwing on unhandled 'newListener' events
    this.emitter.setMaxListeners(0);
  }

  async publish(topic: string, message: Message): Promise<void> {
    this.emitter.emit(topic, message);
  }

  async subscribe(topic: string, handler: MessageHandler): Promise<() => void> {
    this.emitter.on(topic, handler);
    return () => {
      this.emitter.off(topic, handler);
    };
  }

  async send(agentId: string, message: Message): Promise<void> {
    const inbox = this.mailboxes.get(agentId);
    if (inbox) {
      inbox(message);
    }
  }

  registerAgent(agentId: string, inbox: MessageHandler): void {
    this.mailboxes.set(agentId, inbox);
  }
}

export {
  directivePriority,
  directsAction,
  hasHearerEffect,
  isQueryDirective,
  isStandingDirective,
  isUnsupportedDirective,
  isPropositional,
  performativeClass,
  performativeClasses,
  FIPA_PERFORMATIVES,
  PERFORMATIVE_CLASSES,
} from "./performatives.js";
export type {
  CommunicativeActClass,
  FIPAPerformative,
  Performative,
} from "./performatives.js";

export { MessageSchema } from "./types.js";
export type { Message, MessageBus, MessageHandler } from "./types.js";
