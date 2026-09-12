import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import { createCoordinator, createWorker } from "../src/contract-net/index.js";
import type { Coordinator } from "../src/contract-net/index.js";

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

describe("createWorker", () => {
  it("claims a task and reports a one-shot result", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = createCoordinator<{ n: number }, number>({
      id: "coordinator",
      bus,
      workers: ["w1"],
      tasks: [{ id: "t1", payload: { n: 21 } }],
    });
    const worker = createWorker<{ n: number }, number>({
      id: "w1",
      bus,
      step: (_taskId, task) => ({ done: true, result: task.n * 2 }),
    });

    coordinator.start();
    worker.start();

    const ticks = await runUntilComplete(coordinator, [worker]);

    expect(coordinator.isComplete()).toBe(true);
    expect(coordinator.results()).toEqual([
      { taskId: "t1", worker: "w1", value: 42 },
    ]);
    expect(worker.completed()).toEqual(["t1"]);
    expect(worker.resultOf("t1")).toBe(42);
    expect(ticks).toBeLessThan(40);
    expect(worker.claimed()).toEqual(["t1"]);

    coordinator.stop();
    worker.stop();
  });

  it("advances a multi-step task one step per tick", async () => {
    const bus = new InMemoryMessageBus();
    let stepCount = 0;

    const coordinator = createCoordinator<{ n: number }, number>({
      id: "coordinator",
      bus,
      workers: ["w1"],
      tasks: [{ id: "t1", payload: { n: 1 } }],
    });
    const worker = createWorker<{ n: number }, number>({
      id: "w1",
      bus,
      step: (taskId, _task, beliefs) => {
        stepCount++;
        const counter = (beliefs.get<number>(`steps.${taskId}`) ?? 0) + 1;
        beliefs.set(`steps.${taskId}`, counter);
        if (counter >= 3) return { done: true, result: counter };
        return { done: false };
      },
    });

    coordinator.start();
    worker.start();

    await runUntilComplete(coordinator, [worker]);

    expect(worker.resultOf("t1")).toBe(3);
    expect(worker.agent.beliefs.get("steps.t1")).toBe(3);
    expect(stepCount).toBeGreaterThanOrEqual(3);

    coordinator.stop();
    worker.stop();
  });

  it("canClaim limits which tasks a worker claims", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = createCoordinator<{ id: string }, number>({
      id: "coordinator",
      bus,
      workers: ["w1"],
      tasks: [
        { id: "t1", payload: { id: "a" } },
        { id: "t2", payload: { id: "b" } },
      ],
    });
    const worker = createWorker<{ id: string }, number>({
      id: "w1",
      bus,
      canClaim: (_taskId, task) => task.id === "a",
      step: (taskId) => ({ done: true, result: taskId.length }),
    });

    coordinator.start();
    worker.start();

    // t2 is never claimed, so the coordination never completes.
    await runUntilComplete(coordinator, [worker]);

    expect(coordinator.ownerOf("t1")).toBe("w1");
    expect(coordinator.ownerOf("t2")).toBeUndefined();
    expect(coordinator.isComplete()).toBe(false);
    expect(worker.claimed()).toEqual(["t1"]);
    expect(worker.completed()).toEqual(["t1"]);

    coordinator.stop();
    worker.stop();
  });

  it("handles several concurrent tasks per worker", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = createCoordinator<{ n: number }, number>({
      id: "coordinator",
      bus,
      workers: ["w1"],
      tasks: [
        { id: "t1", payload: { n: 1 } },
        { id: "t2", payload: { n: 2 } },
        { id: "t3", payload: { n: 3 } },
      ],
    });
    const worker = createWorker<{ n: number }, number>({
      id: "w1",
      bus,
      step: (taskId, task, beliefs) => {
        // two ticks' worth of work per task, tracked per task
        const progress = (beliefs.get<number>(`p.${taskId}`) ?? 0) + 1;
        beliefs.set(`p.${taskId}`, progress);
        if (progress >= 2) return { done: true, result: task.n * 10 };
        return { done: false };
      },
    });

    coordinator.start();
    worker.start();

    await runUntilComplete(coordinator, [worker]);

    expect(coordinator.isComplete()).toBe(true);
    expect(worker.completed().sort()).toEqual(["t1", "t2", "t3"]);
    expect(
      coordinator
        .results()
        .map((r) => r.value)
        .sort((a, b) => a - b),
    ).toEqual([10, 20, 30]);
    expect(worker.resultOf("t1")).toBe(10);

    coordinator.stop();
    worker.stop();
  });

  it("can be used with custom topics to isolate coordinations on one bus", async () => {
    const bus = new InMemoryMessageBus();

    const makePair = (suffix: string) => {
      const topics = {
        tasks: `job${suffix}.tasks`,
        claims: `job${suffix}.claims`,
        grants: `job${suffix}.grants`,
        results: `job${suffix}.results`,
      };
      const coordinator = createCoordinator<{ n: number }, number>({
        id: `coordinator${suffix}`,
        bus,
        workers: [`worker${suffix}`],
        tasks: [{ id: `t${suffix}`, payload: { n: 1 } }],
        topics,
      });
      const worker = createWorker<{ n: number }, number>({
        id: `worker${suffix}`,
        bus,
        topics,
        step: (_taskId, task) => ({ done: true, result: task.n }),
      });
      return { coordinator, worker };
    };

    const pairA = makePair("A");
    const pairB = makePair("B");

    pairA.coordinator.start();
    pairA.worker.start();
    pairB.coordinator.start();
    pairB.worker.start();

    await runUntilComplete(pairA.coordinator, [pairA.worker]);
    await runUntilComplete(pairB.coordinator, [pairB.worker]);

    expect(pairA.coordinator.isComplete()).toBe(true);
    expect(pairB.coordinator.isComplete()).toBe(true);
    // each coordination completes only its own task
    expect(pairA.worker.completed()).toEqual(["tA"]);
    expect(pairB.worker.completed()).toEqual(["tB"]);
    expect(pairA.coordinator.ownerOf("tA")).toBe("workerA");
    expect(pairB.coordinator.ownerOf("tB")).toBe("workerB");
    expect(pairA.coordinator.ownerOf("tB")).toBeUndefined();

    pairA.coordinator.stop();
    pairA.worker.stop();
    pairB.coordinator.stop();
    pairB.worker.stop();
  });
});
