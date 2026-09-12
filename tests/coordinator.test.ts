import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import { Agent, PlanLibrary } from "../src/core/index.js";
import { createCoordinator } from "../src/contract-net/index.js";
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

  it("throws when configured with no tasks or no workers", () => {
    const bus = new InMemoryMessageBus();
    expect(() =>
      createCoordinator({ id: "c", bus, workers: ["w1"], tasks: [] }),
    ).toThrow(/at least one task/);
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
