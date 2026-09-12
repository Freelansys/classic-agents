import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import { Agent, PlanLibrary } from "../src/core/index.js";
import { createCoordinator, createWorker } from "../src/contract-net/index.js";
import type { CoordinatorResult } from "../src/contract-net/index.js";
import type { ActionResult, Plan } from "../src/core/plans.js";

const TASK_IDS = ["a", "b"];

async function tickUntil(
  coordinator: ReturnType<typeof createCoordinator>,
  predicate: () => boolean,
  maxTicks = 10,
): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i++) {
    await coordinator.tick();
  }
}

// A minimal worker that mirrors the pub/sub coordinator protocol: subscribes
// to the tasks/grants topics, claims every task it sees, and publishes a
// (canned) result once it has been granted a task.
function makeWorker(id: string, bus: InMemoryMessageBus): Agent {
  const lib = new PlanLibrary();

  const claim: Plan = {
    name: "claim",
    trigger: (beliefs) =>
      TASK_IDS.some(
        (taskId) =>
          beliefs.has(`msg.task.${taskId}`) &&
          !beliefs.has(`claimed.${taskId}`),
      ),
    body: [
      {
        name: "claim-tasks",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const messages: ActionResult["messages"] = [];
          const beliefUpdates: Array<{ key: string; value: unknown }> = [];
          for (const taskId of TASK_IDS) {
            if (
              beliefs.has(`msg.task.${taskId}`) &&
              !beliefs.has(`claimed.${taskId}`)
            ) {
              messages.push({
                topic: "claims",
                performative: "inform",
                content: { [`claim.${id}.${taskId}`]: { taskId, worker: id } },
              });
              beliefUpdates.push({ key: `claimed.${taskId}`, value: true });
            }
          }
          return { messages, beliefUpdates };
        },
      },
    ],
  };

  const compute: Plan = {
    name: "compute",
    trigger: (beliefs) =>
      TASK_IDS.some(
        (taskId) =>
          beliefs.get<{ taskId: string; worker: string }>(`msg.grant.${taskId}`)
            ?.worker === id,
      ),
    body: [
      {
        name: "compute-and-report",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const messages: ActionResult["messages"] = [];
          const beliefUpdates: Array<{ key: string; value: unknown }> = [];
          for (const taskId of TASK_IDS) {
            const grant = beliefs.get<{ taskId: string; worker: string }>(
              `msg.grant.${taskId}`,
            );
            if (grant?.worker === id && !beliefs.has(`computed.${taskId}`)) {
              messages.push({
                topic: "results",
                performative: "inform",
                content: { [`result.${taskId}`]: `rslt-${taskId}-by-${id}` },
              });
              beliefUpdates.push({ key: `computed.${taskId}`, value: true });
            }
          }
          return { messages, beliefUpdates };
        },
      },
    ],
  };

  lib.register(claim);
  lib.register(compute);

  const agent = new Agent({ id, bus, planLibrary: lib, tickIntervalMs: 10 });
  agent.subscribe("tasks");
  agent.subscribe("grants");
  return agent;
}

describe("createCoordinator", () => {
  it("publishes tasks and grants to the protocol topics", async () => {
    const bus = new InMemoryMessageBus();
    const grants: unknown[] = [];
    bus.subscribe("grants", (msg) => grants.push(msg.content));

    const coordinator = createCoordinator({
      id: "coordinator",
      bus,
      workers: ["w1"],
      tasks: [{ id: "t1", payload: { n: 1 } }],
    });
    coordinator.start();

    await bus.publish("claims", {
      performative: "inform",
      sender: "w1",
      topic: "claims",
      content: { "claim.w1.t1": { taskId: "t1", worker: "w1" } },
      timestamp: Date.now(),
    });

    await tickUntil(coordinator, () => coordinator.ownerOf("t1") !== undefined);

    expect(coordinator.ownerOf("t1")).toBe("w1");
    expect(grants).toEqual([{ "grant.t1": { taskId: "t1", worker: "w1" } }]);

    coordinator.stop();
  });

  it("first-claim policy picks the earlier worker", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = createCoordinator({
      id: "coordinator",
      bus,
      workers: ["w1", "w2"],
      tasks: [{ id: "t1", payload: {} }],
    });
    coordinator.start();

    await bus.publish("claims", {
      performative: "inform",
      sender: "w1",
      topic: "claims",
      content: { "claim.w1.t1": { taskId: "t1", worker: "w1" } },
      timestamp: Date.now(),
    });
    await bus.publish("claims", {
      performative: "inform",
      sender: "w2",
      topic: "claims",
      content: { "claim.w2.t1": { taskId: "t1", worker: "w2" } },
      timestamp: Date.now(),
    });

    await tickUntil(coordinator, () => coordinator.ownerOf("t1") !== undefined);

    expect(coordinator.ownerOf("t1")).toBe("w1");

    coordinator.stop();
  });

  it("least-loaded policy balances tasks across workers", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = createCoordinator({
      id: "coordinator",
      bus,
      workers: ["w1", "w2"],
      tasks: [1, 2, 3, 4].map((n) => ({ id: `t${n}`, payload: { n } })),
      allocationPolicy: "least-loaded",
    });
    coordinator.start();

    for (const worker of ["w1", "w2"]) {
      await bus.publish("claims", {
        performative: "inform",
        sender: worker,
        topic: "claims",
        content: {
          [`claim.${worker}.t1`]: { taskId: "t1", worker },
          [`claim.${worker}.t2`]: { taskId: "t2", worker },
          [`claim.${worker}.t3`]: { taskId: "t3", worker },
          [`claim.${worker}.t4`]: { taskId: "t4", worker },
        },
        timestamp: Date.now(),
      });
    }

    await tickUntil(
      coordinator,
      () => Object.keys(coordinator.owners()).length === 4,
    );

    const counts = new Map<string, number>();
    for (const worker of Object.values(coordinator.owners())) {
      counts.set(worker, (counts.get(worker) ?? 0) + 1);
    }
    expect(counts.get("w1")).toBe(2);
    expect(counts.get("w2")).toBe(2);

    coordinator.stop();
  });

  it("no-repeat policy gives each worker at most one task", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = createCoordinator({
      id: "coordinator",
      bus,
      workers: ["w1", "w2"],
      tasks: [
        { id: "t1", payload: {} },
        { id: "t2", payload: {} },
      ],
      allocationPolicy: "no-repeat",
    });
    coordinator.start();

    for (const worker of ["w1", "w2"]) {
      await bus.publish("claims", {
        performative: "inform",
        sender: worker,
        topic: "claims",
        content: {
          [`claim.${worker}.t1`]: { taskId: "t1", worker },
          [`claim.${worker}.t2`]: { taskId: "t2", worker },
        },
        timestamp: Date.now(),
      });
    }

    await tickUntil(
      coordinator,
      () => Object.keys(coordinator.owners()).length === 2,
    );

    const owners = coordinator.owners();
    expect(new Set(Object.values(owners)).size).toBe(2);
    expect(owners.t1).not.toBe(owners.t2);

    coordinator.stop();
  });

  it("distributes tasks among real workers and collects all results", async () => {
    const bus = new InMemoryMessageBus();
    const assigned: Array<[string, string]> = [];
    const completed: CoordinatorResult<string>[] = [];

    const coordinator = createCoordinator<unknown, string>({
      id: "coordinator",
      bus,
      workers: ["w1", "w2"],
      tasks: [
        { id: "a", payload: { n: 1 } },
        { id: "b", payload: { n: 2 } },
      ],
      allocationPolicy: "no-repeat",
      onTaskAssigned: (taskId, worker) => assigned.push([taskId, worker]),
      onAllComplete: (results) => completed.push(...results),
    });

    const w1 = makeWorker("w1", bus);
    const w2 = makeWorker("w2", bus);

    coordinator.start();
    w1.start();
    w2.start();

    const maxTicks = 30;
    for (let i = 0; i < maxTicks && !coordinator.isComplete(); i++) {
      await Promise.all([coordinator.tick(), w1.tick(), w2.tick()]);
    }

    expect(coordinator.isComplete()).toBe(true);
    expect(assigned).toHaveLength(2);
    expect(assigned.map(([taskId]) => taskId).sort()).toEqual(["a", "b"]);
    expect(new Set(assigned.map(([, worker]) => worker)).size).toBe(2);

    const results = coordinator.results();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.taskId).sort()).toEqual(["a", "b"]);
    for (const result of results) {
      expect(result.value).toBe(`rslt-${result.taskId}-by-${result.worker}`);
    }

    expect(completed).toHaveLength(2);
    expect(completed.map((r) => r.taskId).sort()).toEqual(["a", "b"]);

    coordinator.stop();
    w1.stop();
    w2.stop();
  });

  it("invokes onResult for each completed task", async () => {
    const bus = new InMemoryMessageBus();
    const seen: Array<[string, number, string | undefined]> = [];

    const coordinator = createCoordinator<unknown, number>({
      id: "coordinator",
      bus,
      workers: ["w1"],
      tasks: [{ id: "t1", payload: {} }],
      onResult: (taskId, value, worker) => seen.push([taskId, value, worker]),
    });
    coordinator.start();

    await bus.publish("claims", {
      performative: "inform",
      sender: "w1",
      topic: "claims",
      content: { "claim.w1.t1": { taskId: "t1", worker: "w1" } },
      timestamp: Date.now(),
    });
    await bus.publish("results", {
      performative: "inform",
      sender: "w1",
      topic: "results",
      content: { "result.t1": 42 },
      timestamp: Date.now(),
    });

    for (let i = 0; i < 6 && seen.length === 0; i++) {
      await coordinator.tick();
    }

    expect(seen).toEqual([["t1", 42, "w1"]]);
    expect(coordinator.resultOf("t1")).toEqual({
      taskId: "t1",
      worker: "w1",
      value: 42,
    });

    coordinator.stop();
  });

  it("adopts tasks announced over the message bus (no seed tasks)", async () => {
    const bus = new InMemoryMessageBus();

    const generatorLib = new PlanLibrary();
    generatorLib.register({
      name: "announce",
      trigger: (beliefs) => !beliefs.get<boolean>("announced"),
      body: [
        {
          name: "publish",
          execute: async (): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "announced", value: true }],
            messages: [
              {
                topic: "tasks",
                performative: "inform",
                content: { "task.t1": { n: 1 }, "task.t2": { n: 2 } },
              },
            ],
          }),
        },
      ],
    });
    const generator = new Agent({
      id: "generator",
      bus,
      planLibrary: generatorLib,
    });

    const completed: CoordinatorResult<number>[] = [];
    const coordinator = createCoordinator<unknown, number>({
      id: "coordinator",
      bus,
      workers: ["w1"],
      onAllComplete: (results) => completed.push(...results),
    });

    const worker = createWorker<{ n: number }, number>({
      id: "w1",
      bus,
      step: (_taskId, payload) => ({ done: true, result: payload.n * 2 }),
    });

    coordinator.start();
    generator.start();
    worker.start();

    const maxTicks = 60;
    for (let i = 0; i < maxTicks && !coordinator.isComplete(); i++) {
      await Promise.all([coordinator.tick(), generator.tick(), worker.tick()]);
    }

    expect(coordinator.isComplete()).toBe(true);
    expect(coordinator.owners()).toEqual({ t1: "w1", t2: "w1" });
    expect(
      coordinator
        .results()
        .map((r) => r.taskId)
        .sort(),
    ).toEqual(["t1", "t2"]);
    expect(coordinator.resultOf("t2")?.value).toBe(4);
    expect(completed.map((r) => r.taskId).sort()).toEqual(["t1", "t2"]);

    coordinator.stop();
    generator.stop();
    worker.stop();
  });

  it("mixes seed tasks with tasks announced over the bus", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = createCoordinator<{ n: number }, number>({
      id: "coordinator",
      bus,
      workers: ["w1"],
      tasks: [{ id: "seed", payload: { n: 1 } }],
    });

    const worker = createWorker<{ n: number }, number>({
      id: "w1",
      bus,
      step: (_taskId, payload) => ({ done: true, result: payload.n }),
    });

    coordinator.start();
    worker.start();

    await bus.publish("tasks", {
      performative: "inform",
      sender: "gen",
      topic: "tasks",
      content: { "task.via-bus": { n: 3 } },
      timestamp: Date.now(),
    });

    const maxTicks = 40;
    for (let i = 0; i < maxTicks && !coordinator.isComplete(); i++) {
      await Promise.all([coordinator.tick(), worker.tick()]);
    }

    expect(coordinator.isComplete()).toBe(true);
    expect(
      coordinator
        .results()
        .map((r) => r.taskId)
        .sort(),
    ).toEqual(["seed", "via-bus"]);
    expect(coordinator.resultOf("seed")).toEqual({
      taskId: "seed",
      worker: "w1",
      value: 1,
    });
    expect(coordinator.resultOf("via-bus")).toEqual({
      taskId: "via-bus",
      worker: "w1",
      value: 3,
    });

    coordinator.stop();
    worker.stop();
  });

  it("fires onAllComplete again when new tasks arrive after completion", async () => {
    const bus = new InMemoryMessageBus();
    const completed: string[][] = [];
    const coordinator = createCoordinator<unknown, number>({
      id: "coordinator",
      bus,
      workers: ["w1"],
      onAllComplete: (results) => completed.push(results.map((r) => r.taskId)),
    });

    const worker = createWorker<unknown, number>({
      id: "w1",
      bus,
      step: () => ({ done: true, result: 1 }),
    });

    coordinator.start();
    worker.start();

    await bus.publish("tasks", {
      performative: "inform",
      sender: "gen",
      topic: "tasks",
      content: { "task.t1": {} },
      timestamp: Date.now(),
    });

    let ticks = 0;
    for (; ticks < 60 && !coordinator.isComplete(); ticks++) {
      await Promise.all([coordinator.tick(), worker.tick()]);
    }
    expect(coordinator.isComplete()).toBe(true);
    expect(completed[0]).toEqual(["t1"]);

    await bus.publish("tasks", {
      performative: "inform",
      sender: "gen",
      topic: "tasks",
      content: { "task.t2": {} },
      timestamp: Date.now(),
    });

    for (
      ;
      ticks < 120 &&
      !(coordinator.isComplete() && coordinator.results().length >= 2);
      ticks++
    ) {
      await Promise.all([coordinator.tick(), worker.tick()]);
    }

    expect(coordinator.isComplete()).toBe(true);
    expect(completed.length).toBeGreaterThanOrEqual(2);
    expect(completed[completed.length - 1]).toEqual(
      expect.arrayContaining(["t1", "t2"]),
    );

    coordinator.stop();
    worker.stop();
  });

  it("throws when configured with no workers", () => {
    const bus = new InMemoryMessageBus();
    expect(() =>
      createCoordinator({
        id: "c",
        bus,
        workers: [],
        tasks: [{ id: "t1", payload: {} }],
      }),
    ).toThrow(/at least one worker/);
  });
});
