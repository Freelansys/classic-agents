import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type RedisClientType } from "redis";
import { RedisMessageBus } from "../../src/bus/index.js";
import {
  createCoordinator,
  createWorker,
} from "../../src/contract-net/index.js";

const REDIS_URL = "redis://localhost:6379";
let redis: RedisClientType;

function pollFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
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

describe("RedisMessageBus (integration)", () => {
  beforeEach(async () => {
    redis = createClient({ url: REDIS_URL });
    await redis.connect();
  });

  afterEach(async () => {
    const allKeys = await redis.keys("agents:integration:*");
    if (allKeys.length > 0) {
      await redis.del(allKeys);
    }
    await redis.quit();
  });

  it("delivers publish/subscribe messages across bus instances", async () => {
    const tag = "integration";
    const topic = `${tag}.events`;
    const busA = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });
    const busB = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });

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
  }, 10000);

  it("delivers a point-to-point message sent before the agent registered", async () => {
    const tag = "integration";
    const bus = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });

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
  }, 10000);

  it("re-registering an agent replays only messages not yet delivered", async () => {
    const tag = "integration";
    const bus = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });

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

    bus.registerAgent("seq-agent", (msg) => {
      received.push(msg.content);
    });

    await sleep(500);
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);

    await bus.disconnect();
  }, 10000);

  it("runs multiple concurrent topic subscribers on one bus", async () => {
    const tag = "integration";
    const topic = `${tag}.fanout`;
    const bus = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });

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
  }, 10000);

  it("delivers point-to-point across separate bus instances sharing Redis", async () => {
    const tag = "integration";
    const senderBus = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });
    const receiverBus = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });

    const received: unknown[] = [];
    receiverBus.registerAgent("cross-agent", (msg) =>
      received.push(msg.content as unknown),
    );

    await sleep(200);

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
  }, 10000);

  it("completes a full contract-net coordination over Redis", async () => {
    const tag = "integration";
    const topics = {
      tasks: `${tag}.tasks`,
      claims: `${tag}.claims`,
      grants: `${tag}.grants`,
      results: `${tag}.results`,
    };

    const coordinatorBus = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });
    const workerBus = new RedisMessageBus({
      url: REDIS_URL,
      streamKeyPrefix: `agents:${tag}:`,
      readTimeoutMs: 1000,
    });

    const coordinator = createCoordinator({
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

    const worker = createWorker({
      id: "redis-worker",
      bus: workerBus,
      topics,
      step: (taskId: string, task: { n: number }) => {
        const progress =
          ((worker.agent.beliefs.get(`p.${taskId}`) as number | undefined) ??
            0) + 1;
        worker.agent.beliefs.set(`p.${taskId}`, progress);
        if (progress >= 2) {
          return { done: true, result: task.n * 10 };
        }
        return { done: false };
      },
    });

    coordinator.start(10);
    worker.start(10);

    let ticks = 0;
    while (ticks < 200 && !coordinator.isComplete()) {
      await Promise.all([coordinator.tick(), worker.tick()]);
      // Give reader loops time to drain Redis streams
      await sleep(50);
      ticks++;
    }

    expect(ticks).toBeLessThan(200);
    expect(coordinator.isComplete()).toBe(true);
    expect(
      coordinator
        .results()
        .map((r: any) => r.value)
        .sort((a: number, b: number) => a - b),
    ).toEqual([10, 20, 30]);
    expect(worker.completed().sort()).toEqual(["t1", "t2", "t3"]);

    coordinator.stop();
    worker.stop();
    await coordinatorBus.disconnect();
    await workerBus.disconnect();
  }, 30000);
});
