import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type { CycleFailed } from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { Plan } from "../src/core/plans.js";

function agent(plans: Plan[]): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({
    id: "a",
    bus: new InMemoryMessageBus(),
    planLibrary: library,
  });
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves once `check` holds, polling every few milliseconds. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await wait(5);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("The start(tickIntervalMs) loop", () => {
  it("reports a failed cycle and keeps running", async () => {
    let runs = 0;
    const a = agent([
      {
        name: "job",
        body: [{ name: "run", execute: async () => (runs++, {}) }],
      },
    ]);
    let thrown = false;
    a.on("intention:started", () => {
      if (!thrown) {
        thrown = true;
        throw new Error("listener failed");
      }
    });
    const failures: CycleFailed[] = [];
    a.on("cycle:failed", (e) => failures.push(e));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      await a.start(5);
      a.goals.add({ id: "g1", name: "job", priority: 5, status: "pending" });
      a.goals.add({ id: "g2", name: "job", priority: 5, status: "pending" });
      await until(() => runs === 2 && a.goals.all().length === 0);
    } finally {
      await a.stop();
      process.off("unhandledRejection", unhandled);
    }

    expect(failures).toHaveLength(1);
    expect(failures[0].agentId).toBe("a");
    expect((failures[0].error as Error).message).toBe("listener failed");
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("logs a failed cycle when nobody listens, and a cycle:failed handler that throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = agent([
      { name: "job", body: [{ name: "run", execute: async () => ({}) }] },
    ]);
    let throws = 2;
    a.on("intention:started", () => {
      if (throws-- > 0) throw new Error("listener failed");
    });
    await a.start(5);
    a.goals.add({ id: "g1", name: "job", priority: 5, status: "pending" });
    await until(() => errors.mock.calls.length >= 1);
    a.on("cycle:failed", () => {
      throw new Error("reporter failed");
    });
    a.goals.add({ id: "g2", name: "job", priority: 5, status: "pending" });
    await until(() => errors.mock.calls.length >= 2);
    await until(() => a.goals.all().length === 0);
    await a.stop();

    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain("[a] Reasoning cycle failed:");
    expect(logged).toContain("[a] A cycle:failed handler threw:");
  });

  it("stop() waits for the running cycle by default", async () => {
    let finished = false;
    const a = agent([
      {
        name: "slow",
        body: [
          {
            name: "wait",
            execute: async () => {
              await wait(150);
              finished = true;
              return {};
            },
          },
        ],
      },
    ]);
    a.goals.add({ id: "s", name: "slow", priority: 5, status: "pending" });
    await a.start(5);
    await wait(40);

    expect(await a.stop()).toBe(true);
    expect(finished).toBe(true);
  });

  it("stop({ timeoutMs }) bounds the wait, and idle() waits out the rest", async () => {
    let finished = false;
    const a = agent([
      {
        name: "slow",
        body: [
          {
            name: "wait",
            execute: async () => {
              await wait(300);
              finished = true;
              return {};
            },
          },
        ],
      },
    ]);
    a.goals.add({ id: "s", name: "slow", priority: 5, status: "pending" });
    await a.start(5);
    await wait(40);

    const started = Date.now();
    expect(await a.stop({ timeoutMs: 50 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
    expect(finished).toBe(false);

    expect(await a.idle()).toBe(true);
    expect(finished).toBe(true);
  });

  it("stop({ timeoutMs: 0 }) returns at once", async () => {
    const a = agent([
      {
        name: "slow",
        body: [{ name: "wait", execute: async () => (await wait(200), {}) }],
      },
    ]);
    a.goals.add({ id: "s", name: "slow", priority: 5, status: "pending" });
    await a.start(5);
    await wait(40);

    const started = Date.now();
    expect(await a.stop({ timeoutMs: 0 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
    await a.idle();
  });

  it("schedules nothing after stop, even from a cycle that outlived it", async () => {
    let ticks = 0;
    const a = agent([
      {
        name: "slow",
        body: [{ name: "wait", execute: async () => (await wait(100), {}) }],
      },
    ]);
    const tick = a.tick.bind(a);
    a.tick = () => (ticks++, tick());
    a.goals.add({ id: "s", name: "slow", priority: 5, status: "pending" });
    await a.start(5);
    await wait(30);
    await a.stop({ timeoutMs: 0 });
    const atStop = ticks;
    await a.idle();
    await wait(50);

    expect(ticks).toBe(atStop);
  });

  it("a quick restart runs one loop, never overlapping the old cycle", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const a = agent([
      {
        name: "slow",
        body: [{ name: "wait", execute: async () => (await wait(100), {}) }],
      },
    ]);
    const tick = a.tick.bind(a);
    a.tick = async () => {
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      try {
        await tick();
      } finally {
        concurrent--;
      }
    };
    a.goals.add({ id: "s", name: "slow", priority: 5, status: "pending" });
    await a.start(5);
    await wait(30);
    await a.stop({ timeoutMs: 0 });
    await a.start(5);
    a.goals.add({ id: "t", name: "slow", priority: 5, status: "pending" });
    await until(() => a.goals.all().length === 0);
    await a.stop();

    expect(maxConcurrent).toBe(1);
  });
});
