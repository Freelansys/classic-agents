import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Minimal in-memory mock of node-redis that satisfies the RedisMessageBus
// contract used by the tests.
// ---------------------------------------------------------------------------

interface StreamEntry {
  id: string;
  message: Record<string, string>;
}

interface Stream {
  entries: StreamEntry[];
  nextId: number;
}

interface PubSubChannel {
  listeners: Set<() => void>;
}

interface MockClient {
  _connected: boolean;
  _pubsub: Map<string, Set<() => void>>;
  _closed: boolean;
  connect: () => Promise<void>;
  close: () => Promise<void>;
  publish: (channel: string, message: string) => Promise<number>;
  subscribe: (channel: string, listener: () => void) => Promise<void>;
  unsubscribe: (channel: string, listener: () => void) => Promise<void>;
  xAdd: (
    key: string,
    id: string,
    entry: Record<string, string>,
  ) => Promise<string>;
  xRead: (
    streams: Array<{ key: string; id: string }>,
    opts: { COUNT: number; BLOCK: number },
  ) => Promise<Array<{
    name: string;
    messages: Array<{ id: string; message: Record<string, string> }>;
  }> | null>;
  xDel: (key: string, ids: string[]) => Promise<number>;
  scanIterator: (opts: {
    MATCH: string;
    COUNT: number;
  }) => AsyncIterable<string[]>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}

const mockClients: MockClient[] = [];

// Shared stream store across all mock clients (cmd, sub, reader share state)
const sharedStreams: Map<string, Stream> = new Map();

function createMockClient(): MockClient {
  const client: MockClient = {
    _connected: false,
    _pubsub: new Map(),
    _closed: false,
    async connect() {
      this._connected = true;
    },
    async close() {
      this._closed = true;
      this._connected = false;
    },
    async publish(channel, message) {
      const count = this._pubsub.get(channel)?.size ?? 0;
      // Notify listeners stored in the mock store
      notifySubscribers(channel, message);
      return count;
    },
    async subscribe(channel, listener) {
      if (!this._pubsub.has(channel)) {
        this._pubsub.set(channel, new Set());
      }
      this._pubsub.get(channel)!.add(listener);
    },
    async unsubscribe(channel, listener) {
      this._pubsub.get(channel)?.delete(listener);
    },
    async xAdd(key, _id, entry) {
      if (!sharedStreams.has(key)) {
        sharedStreams.set(key, { entries: [], nextId: 0 });
      }
      const stream = sharedStreams.get(key)!;
      stream.nextId++;
      const id = `${stream.nextId}-0`;
      stream.entries.push({ id, message: { ...entry } });
      // Wake up any waiting xRead
      wakeXRead(key);
      return id;
    },
    async xRead(streams, opts) {
      const { COUNT, BLOCK } = opts;
      const results: Array<{
        name: string;
        messages: Array<{ id: string; message: Record<string, string> }>;
      }> = [];

      for (const { key, id: startId } of streams) {
        const stream = sharedStreams.get(key);
        if (!stream) continue;

        // Find entries after startId
        const startIdx = stream.entries.findIndex((e) => {
          const [a] = e.id.split("-").map(Number);
          const [b] = startId.split("-").map(Number);
          return a > b;
        });
        if (startIdx === -1) continue;

        const available = stream.entries.slice(startIdx);
        const taken = available.slice(0, COUNT);
        if (taken.length > 0) {
          results.push({
            name: key,
            messages: taken.map((e) => ({
              id: e.id,
              message: { ...e.message },
            })),
          });
        }
      }

      if (results.length > 0) return results;
      if (BLOCK > 0) {
        const timeoutMs = BLOCK;
        const timeoutPromise = new Promise<null>((_resolve) => {
          const timer = setTimeout(() => _resolve(null), timeoutMs);
          // Allow cancellation via wake
          _resolveTimer = timer;
        });
        const wakePromise = waitForWake();
        const winner = await Promise.race([wakePromise, timeoutPromise]);
        if (winner === null) return null;

        // Re-check after wake — collect results again
        const newResults: typeof results = [];
        for (const { key, id: startId } of streams) {
          const stream = sharedStreams.get(key);
          if (!stream) continue;
          const startIdx = stream.entries.findIndex((e) => {
            const [a] = e.id.split("-").map(Number);
            const [b] = startId.split("-").map(Number);
            return a > b;
          });
          if (startIdx === -1) continue;
          const available = stream.entries.slice(startIdx);
          const taken = available.slice(0, COUNT);
          if (taken.length > 0) {
            newResults.push({
              name: key,
              messages: taken.map((e) => ({
                id: e.id,
                message: { ...e.message },
              })),
            });
          }
        }
        return newResults.length > 0 ? newResults : null;
      }
      return null;
    },
    async xDel(key, ids) {
      const stream = sharedStreams.get(key);
      if (!stream) return 0;
      const before = stream.entries.length;
      stream.entries = stream.entries.filter((e) => !ids.includes(e.id));
      return before - stream.entries.length;
    },
    async *scanIterator(_opts) {
      const allKeys: string[] = [];
      for (const key of sharedStreams.keys()) {
        allKeys.push(key);
      }
      yield allKeys;
    },
    on(_event: string, _handler: (...args: unknown[]) => void) {
      // no-op for tests
    },
  };
  mockClients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// Global pub/sub store shared by all mock clients
// ---------------------------------------------------------------------------

interface SubEntry {
  clientIdx: number;
  channel: string;
  listener: () => void;
}

const subStore: SubEntry[] = [];

function notifySubscribers(channel: string, message: string): void {
  for (const entry of subStore) {
    if (entry.channel === channel) {
      try {
        (entry.listener as (msg: string, ch: string) => void)(
          message,
          entry.channel,
        );
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// xRead wake mechanism
// ---------------------------------------------------------------------------

let wakeResolve: (() => void) | null = null;
let _resolveTimer: NodeJS.Timeout | null = null;

function wakeXRead(_key: string): void {
  if (wakeResolve) {
    const fn = wakeResolve;
    wakeResolve = null;
    _resolveTimer?.refresh();
    fn();
  }
}

function waitForWake(): Promise<void> {
  return new Promise<void>((resolve) => {
    wakeResolve = resolve;
  });
}

// ---------------------------------------------------------------------------
// vi.mock setup
// ---------------------------------------------------------------------------

vi.mock("redis", () => ({
  createClient: vi.fn((opts?: { url?: string; socket?: unknown }) => {
    const client = createMockClient();
    // Store subscriber callbacks in the global store
    const origSubscribe = client.subscribe.bind(client);
    client.subscribe = async (channel: string, listener: () => void) => {
      subStore.push({
        clientIdx: mockClients.indexOf(client),
        channel,
        listener: listener as () => void,
      });
      return origSubscribe(channel, listener);
    };
    const origUnsubscribe = client.unsubscribe.bind(client);
    client.unsubscribe = async (channel: string, listener: () => void) => {
      const idx = subStore.findIndex(
        (e) =>
          e.clientIdx === mockClients.indexOf(client) && e.channel === channel,
      );
      if (idx !== -1) subStore.splice(idx, 1);
      return origUnsubscribe(channel, listener);
    };
    return client;
  }),
}));

import { createClient, type RedisClientType } from "redis";
import { RedisMessageBus } from "../src/bus/index.js";
import { createCoordinator, createWorker } from "../src/contract-net/index.js";
import type { Coordinator } from "../src/contract-net/index.js";

function makeBus(tag: string, prefix?: string): RedisMessageBus {
  return new RedisMessageBus({
    url: "redis://localhost:6379",
    streamKeyPrefix: `agents:${tag}:`,
  });
}

let tagCounter = 0;
const uniqueTag = (): string => `t${Date.now()}-${++tagCounter}`;

async function runUntilComplete(
  coordinator: Coordinator,
  workers: Array<{ tick(): Promise<void> }>,
  maxTicks = 40,
): Promise<number> {
  let ticks = 0;
  while (ticks < maxTicks && !coordinator.isComplete()) {
    await Promise.all([coordinator.tick(), ...workers.map((w) => w.tick())]);
    ticks++;
  }
  return ticks;
}

function pollFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("pollFor timed out"));
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RedisMessageBus (mocked)", () => {
  beforeEach(() => {
    subStore.length = 0;
    mockClients.length = 0;
    sharedStreams.clear();
  });

  it("delivers publish/subscribe messages across bus instances", async () => {
    const tag = uniqueTag();
    const topic = `${tag}.events`;
    const busA = makeBus(tag);
    const busB = makeBus(tag);

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    await busA.subscribe(topic, (msg) => receivedA.push(msg.content));
    await busB.subscribe(topic, (msg) => receivedB.push(msg.content));

    await busA.publish(topic, {
      performative: "inform",
      sender: "a",
      topic,
      content: { n: 1 },
      timestamp: Date.now(),
    });

    await pollFor(() => receivedA.length > 0 && receivedB.length > 0);

    expect(receivedA).toEqual([{ n: 1 }]);
    expect(receivedB).toEqual([{ n: 1 }]);

    await busA.disconnect();
    await busB.disconnect();
  });

  it("unsubscribe stops topic delivery", async () => {
    const tag = uniqueTag();
    const topic = `${tag}.quiet`;
    const bus = makeBus(tag);

    const received: unknown[] = [];
    const unsub = await bus.subscribe(topic, (msg) =>
      received.push(msg.content),
    );

    await bus.publish(topic, {
      performative: "inform",
      sender: "s",
      topic,
      content: { n: 1 },
      timestamp: Date.now(),
    });
    await pollFor(() => received.length > 0);

    unsub();
    await bus.publish(topic, {
      performative: "inform",
      sender: "s",
      topic,
      content: { n: 2 },
      timestamp: Date.now(),
    });

    await sleep(150);
    expect(received).toEqual([{ n: 1 }]);

    await bus.disconnect();
  });

  it("delivers a point-to-point message sent before the agent registered", async () => {
    const tag = uniqueTag();
    const bus = makeBus(tag);

    const content = { value: 42 };
    await bus.send("late-agent", {
      performative: "inform",
      sender: "s",
      receiver: "late-agent",
      content,
      timestamp: Date.now(),
    });

    let decoded: unknown;
    bus.registerAgent("late-agent", (msg) => {
      decoded = msg.content;
    });

    await pollFor(() => decoded !== undefined);

    expect(decoded).toEqual(content);

    await bus.disconnect();
  });

  it("re-registering an agent replays only messages not yet delivered", async () => {
    const tag = uniqueTag();
    const bus = makeBus(tag);

    await bus.send("seq-agent", {
      performative: "inform",
      sender: "s",
      content: { n: 1 },
      timestamp: Date.now(),
    });

    const received: unknown[] = [];
    bus.registerAgent("seq-agent", (msg) => {
      received.push(msg.content);
    });
    await pollFor(() => received.length === 1);

    await bus.send("seq-agent", {
      performative: "inform",
      sender: "s",
      content: { n: 2 },
      timestamp: Date.now(),
    });
    await pollFor(() => received.length === 2);
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);

    // Re-register: only still-outstanding messages may be replayed, and
    // since everything was delivered and acked, nothing should reappear.
    bus.registerAgent("seq-agent", (msg) => {
      received.push(msg.content);
    });
    await sleep(200);
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);

    await bus.disconnect();
  });

  it("runs multiple concurrent topic subscribers on one bus", async () => {
    const tag = uniqueTag();
    const topic = `${tag}.fanout`;
    const bus = makeBus(tag);

    const seen = new Set<number>();
    const seen2 = new Set<number>();
    await bus.subscribe(topic, (msg) =>
      seen.add((msg.content as { n: number }).n),
    );
    await bus.subscribe(topic, (msg) =>
      seen2.add((msg.content as { n: number }).n),
    );
    await bus.subscribe(topic, (msg) =>
      seen2.add((msg.content as { n: number }).n),
    );

    for (let i = 1; i <= 3; i++) {
      await bus.publish(topic, {
        performative: "inform",
        sender: "s",
        topic,
        content: { n: i },
        timestamp: Date.now(),
      });
    }

    await pollFor(() => seen.size === 3 && seen2.size === 3);

    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect([...seen2].sort()).toEqual([1, 2, 3]);

    await bus.disconnect();
  });

  it("delivers point-to-point across separate bus instances sharing Redis", async () => {
    const tag = uniqueTag();
    const senderBus = makeBus(tag);
    const receiverBus = makeBus(tag);

    const received: unknown[] = [];
    receiverBus.registerAgent("cross-agent", (msg) =>
      received.push(msg.content as unknown),
    );

    await senderBus.send("cross-agent", {
      performative: "inform",
      sender: "remote",
      receiver: "cross-agent",
      content: { cross: true },
      timestamp: Date.now(),
    });

    await pollFor(() => received.length === 1);
    expect(received).toEqual([{ cross: true }]);

    await senderBus.disconnect();
    await receiverBus.disconnect();
  });

  it("completes a full contract-net coordination over Redis", async () => {
    const tag = uniqueTag();
    const topics = {
      tasks: `${tag}.tasks`,
      claims: `${tag}.claims`,
      grants: `${tag}.grants`,
      results: `${tag}.results`,
    };

    const coordinatorBus = makeBus(tag);
    const workerBus = makeBus(tag);

    const coordinator = createCoordinator<{ n: number }, number>({
      id: "redis-coordinator",
      bus: coordinatorBus,
      workers: ["redis-worker"],
      tasks: [
        { id: "t1", payload: { n: 1 } },
        { id: "t2", payload: { n: 2 } },
        { id: "t3", payload: { n: 3 } },
      ],
      topics,
    });
    const worker = createWorker<{ n: number }, number>({
      id: "redis-worker",
      bus: workerBus,
      topics,
      step: (taskId, task) => {
        const progress =
          (worker.agent.beliefs.get<number>(`p.${taskId}`) ?? 0) + 1;
        worker.agent.beliefs.set(`p.${taskId}`, progress);
        if (progress >= 2) {
          return { done: true, result: task.n * 10 };
        }
        return { done: false };
      },
    });

    coordinator.start();
    worker.start();

    const ticks = await runUntilComplete(coordinator, [worker], 60);

    expect(ticks).toBeLessThan(60);
    expect(coordinator.isComplete()).toBe(true);
    expect(
      coordinator
        .results()
        .map((r) => r.value)
        .sort((a, b) => a - b),
    ).toEqual([10, 20, 30]);
    expect(worker.completed().sort()).toEqual(["t1", "t2", "t3"]);

    coordinator.stop();
    worker.stop();
    await coordinatorBus.disconnect();
    await workerBus.disconnect();
  });
});
