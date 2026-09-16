import { createClient, type RedisClientType } from "redis";
import type { Message, MessageBus, MessageHandler } from "./types.js";

/**
 * Options for the {@link RedisMessageBus}.
 */
export interface RedisMessageBusOptions {
  /**
   * Connection URL passed to the underlying `redis` clients
   * (e.g. `redis://user:pass@host:6379`). Defaults to
   * `process.env.REDIS_URL` or `redis://localhost:6379`.
   */
  url?: string;
  /**
   * Prefix for the per-agent mailbox stream keys. Defaults to `"agents:"`.
   * Stream keys on a shared Redis instance can be namespaced per bus by
   * overriding this (e.g. `agents:service-b:`).
   */
  streamKeyPrefix?: string;
  /**
   * Milliseconds to block waiting for new mailbox messages per read cycle.
   * Defaults to 5000.
   */
  readTimeoutMs?: number;
  /**
   * Maximum number of messages read from a mailbox per cycle. Defaults to 16.
   */
  readCount?: number;
}

type MailboxListener = (message: string, channel: string) => void;

/**
 * Redis-backed `MessageBus` implementation.
 *
 * Delivery model:
 * - `publish`/`subscribe` operate on **Redis Pub/Sub channels** — fast,
 *   fire-and-forget topic delivery. Messages published with no subscriber
 *   are discarded, exactly like the {@link InMemoryMessageBus}.
 * - `send`/`registerAgent` operate on **[Redis Streams]** per agent id —
 *   durable point-to-point mailboxes. A message sent to an agent that has
 *   not (yet) been registered is buffered in the stream and delivered the
 *   first time the agent registers; re-registering replays anything still
 *   outstanding.
 *
 * [Redis Streams]: https://redis.io/docs/data-types/streams/
 *
 * The bus opens three connections: one command client (publish + stream
 * writes/reads), one subscriber client (topic channels), and one background
 * reader client that drains every registered mailbox. Call `disconnect()`
 * to close all three when the bus is no longer needed.
 */
export class RedisMessageBus implements MessageBus {
  private readonly cmd: RedisClientType;
  private readonly sub: RedisClientType;
  private readonly reader: RedisClientType;
  private readonly streamPrefix: string;
  private readonly readTimeoutMs: number;
  private readonly readCount: number;

  /** Registered mailboxes: stream key -> inbox handler. */
  private readonly mailboxes = new Map<string, MessageHandler>();
  /** Per-stream read cursor: last delivered message id. */
  private readonly cursors = new Map<string, string>();
  /** Topic channel -> node-redis listener (for selective unsubscribe). */
  private readonly topicListeners = new Map<string, MailboxListener>();

  private ready: Promise<void> | undefined;
  private closed = false;
  private lastError: Error | undefined;

  constructor(options: RedisMessageBusOptions = {}) {
    const url =
      options.url ?? process.env.REDIS_URL ?? "redis://localhost:6379";
    this.streamPrefix = options.streamKeyPrefix ?? "agents:";
    this.readTimeoutMs = options.readTimeoutMs ?? 5000;
    this.readCount = options.readCount ?? 16;

    const makeClient = (): RedisClientType => {
      const client = createClient({
        url,
        socket: { reconnectStrategy: false },
      });
      client.on("error", (err: Error) => {
        this.lastError = err;
      });
      return client;
    };

    this.cmd = makeClient();
    this.sub = makeClient();
    this.reader = makeClient();
  }

  private streamKey(agentId: string): string {
    return `${this.streamPrefix}${agentId}`;
  }

  private ensureConnected(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await Promise.all([
        this.cmd.connect(),
        this.sub.connect(),
        this.reader.connect(),
      ]);
      void this.readerLoop();
    })().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  async publish(topic: string, message: Message): Promise<void> {
    await this.ensureConnected();
    await this.cmd.publish(topic, JSON.stringify(message));
  }

  async subscribe(topic: string, handler: MessageHandler): Promise<() => void> {
    const listener: MailboxListener = (payload) => {
      try {
        handler(JSON.parse(payload) as Message);
      } catch {
        // Ignore malformed payloads; the handler never sees them.
      }
    };
    await this.ensureConnected();
    await this.sub.subscribe(topic, listener);
    this.topicListeners.set(topic, listener);
    return () => {
      this.topicListeners.delete(topic);
      void this.sub.unsubscribe(topic, listener).catch((err: unknown) => {
        this.lastError = err instanceof Error ? err : new Error(String(err));
      });
    };
  }

  async send(agentId: string, message: Message): Promise<void> {
    await this.ensureConnected();
    await this.cmd.xAdd(this.streamKey(agentId), "*", {
      payload: JSON.stringify(message),
    });
  }

  registerAgent(agentId: string, inbox: MessageHandler): void {
    const key = this.streamKey(agentId);
    this.mailboxes.set(key, inbox);
    this.cursors.delete(key); // replay anything still outstanding
    void this.ensureConnected();
  }

  /**
   * Close all Redis connections and stop draining mailboxes. Idempotent.
   */
  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([
      this.cmd.close(),
      this.sub.close(),
      this.reader.close(),
    ]);
  }

  private async readerLoop(): Promise<void> {
    // Every cycle reads the current mailbox set, so registering/unregistering
    // agents is picked up without restarting the loop.
    while (!this.closed) {
      if (this.mailboxes.size === 0) {
        await sleep(50);
        continue;
      }

      try {
        const streams = Array.from(this.mailboxes.keys()).map((key) => ({
          key,
          id: this.cursors.get(key) ?? "0",
        }));
        const result = (await this.reader.xRead(streams, {
          COUNT: this.readCount,
          BLOCK: this.readTimeoutMs,
        })) as Array<{
          name: string;
          messages: Array<{ id: string; message: unknown }>;
        }> | null;
        if (!result) continue;

        for (const { name, messages } of result) {
          const inbox = this.mailboxes.get(name);
          if (!inbox) continue;

          for (const message of messages) {
            const payload = readField(message.message, "payload");
            if (payload === undefined) continue;
            try {
              const msg = JSON.parse(payload) as Message;
              this.cursors.set(name, String(message.id));
              inbox(msg);
            } catch {
              // Skip malformed entries but keep the cursor advanced so they
              // are not redelivered in a tight loop.
              this.cursors.set(name, String(message.id));
            }
          }

          if (messages.length > 0) {
            await this.reader.xDel(
              name,
              messages.map((m) => String(m.id)),
            );
          }
        }
      } catch (err) {
        if (this.closed) return;
        this.lastError = err instanceof Error ? err : new Error(String(err));
        await sleep(50);
      }
    }
  }
}

function readField(message: unknown, field: string): string | undefined {
  if (message instanceof Map) {
    const value = message.get(field);
    return value === undefined ? undefined : String(value);
  }
  if (message !== null && typeof message === "object") {
    const value = (message as Record<string, unknown>)[field];
    return value === undefined ? undefined : String(value);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
