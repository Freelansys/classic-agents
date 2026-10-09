import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message, Performative } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning.js";
import type { AgentConfig } from "../src/core/reasoning.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";
import { ExpressionLibrary } from "../src/core/expressions.js";
import type { Delegation, Intention } from "../src/core/intentions.js";

function agent(
  bus: InMemoryMessageBus,
  plans: Plan[],
  config: Partial<AgentConfig> = {},
): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id: "worker", bus, planLibrary: library, ...config });
}

/** An inbox at `ui`, and a way to send `worker` anything from it. */
function client(bus: InMemoryMessageBus) {
  const inbox: Message[] = [];
  bus.registerAgent("ui", (m) => inbox.push(m));
  return {
    inbox,
    send(
      performative: Performative,
      content: unknown,
      replyWith: string,
    ): Promise<void> {
      return bus.send("worker", {
        performative,
        sender: "ui",
        receiver: "worker",
        content,
        replyWith,
        timestamp: Date.now(),
      });
    },
    repliesTo(id: string): Message[] {
      return inbox.filter((m) => m.inReplyTo === id);
    },
  };
}

async function run(a: Agent, cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i++) await a.tick();
}

const step = (result: ActionResult = {}) => ({
  name: "step",
  execute: async (): Promise<ActionResult> => result,
});

describe("A request's result", () => {
  it("goes back with the done inform", async () => {
    const bus = new InMemoryMessageBus();
    const worker = agent(bus, [
      { name: "sum", body: [step({ result: { total: 42 } })] },
    ]);
    const ui = client(bus);
    await worker.start();

    await ui.send("request", { goal: "sum" }, "r1");
    await run(worker);

    const replies = ui.repliesTo("r1");
    expect(replies.map((m) => m.performative)).toEqual(["agree", "inform"]);
    expect(replies[1].content).toEqual({
      goal: "sum",
      goalId: expect.any(String),
      done: true,
      result: { total: 42 },
    });
  });

  it("is the last one set before the goal is achieved", async () => {
    const bus = new InMemoryMessageBus();
    const worker = agent(bus, [
      {
        name: "sum",
        body: [step({ result: "draft" }), step(), step({ result: "final" })],
      },
    ]);
    const ui = client(bus);
    await worker.start();

    await ui.send("request", { goal: "sum" }, "r1");
    await run(worker, 8);

    expect(ui.repliesTo("r1")[1].content).toMatchObject({ result: "final" });
  });

  it("is left out when the plan produced none", async () => {
    const bus = new InMemoryMessageBus();
    const worker = agent(bus, [{ name: "noop", body: [step()] }]);
    const ui = client(bus);
    await worker.start();

    await ui.send("request", { goal: "noop" }, "r1");
    await run(worker);

    expect(ui.repliesTo("r1")[1].content).toEqual({
      goal: "noop",
      goalId: expect.any(String),
      done: true,
    });
  });

  it("is not sent when the goal fails", async () => {
    const bus = new InMemoryMessageBus();
    const worker = agent(bus, [
      {
        name: "sum",
        body: [step({ result: 1 }), step({ failure: { reason: "overflow" } })],
      },
    ]);
    const ui = client(bus);
    await worker.start();

    await ui.send("request", { goal: "sum" }, "r1");
    await run(worker);

    const failure = ui.repliesTo("r1")[1];
    expect(failure.performative).toBe("failure");
    expect(failure.content).toEqual({ goal: "sum", reason: "overflow" });
  });

  it("of a self-delegated sub-goal lands on the delegation", async () => {
    const bus = new InMemoryMessageBus();
    const seen: Delegation[][] = [];
    const worker = agent(bus, [
      {
        name: "report",
        body: [
          step({ delegations: [{ goal: "count" }] }),
          {
            name: "read",
            execute: async (intention: Intention) => {
              seen.push(intention.delegations.map((d) => ({ ...d })));
              return {};
            },
          },
        ],
      },
      { name: "count", body: [step({ result: 7 })] },
    ]);
    await worker.start();
    worker.goals.add({
      id: "g",
      name: "report",
      priority: 5,
      status: "pending",
    });

    await run(worker, 8);

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toMatchObject({
      goal: "count",
      status: "done",
      result: 7,
    });
  });
});

describe("The evaluation cap", () => {
  /** An expression whose evaluation stays open until the test releases it. */
  function slowExpressions() {
    const pending: Array<() => void> = [];
    const library = new ExpressionLibrary();
    library.register({
      name: "slow",
      evaluate: () =>
        new Promise<number>((resolve) => pending.push(() => resolve(1))),
    });
    library.register({ name: "fast", evaluate: () => 2 });
    return {
      library,
      releaseAll(): void {
        for (const release of pending.splice(0)) release();
      },
    };
  }

  it("refuses a query over the limit as capacity, and answers the one in flight", async () => {
    const bus = new InMemoryMessageBus();
    const slow = slowExpressions();
    const worker = agent(bus, [], {
      expressionLibrary: slow.library,
      maxConcurrentEvaluations: 1,
    });
    const ui = client(bus);
    await worker.start();

    await ui.send("query-ref", { name: "slow" }, "q1");
    await run(worker, 1);
    await ui.send("query-ref", { name: "fast" }, "q2");
    await run(worker, 1);

    expect(ui.repliesTo("q2")).toEqual([
      expect.objectContaining({
        performative: "refuse",
        content: {
          name: "fast",
          verdict: "capacity",
          reason: "evaluation limit reached (1 at once)",
        },
      }),
    ]);
    expect(ui.repliesTo("q1")).toEqual([]);

    slow.releaseAll();
    await run(worker, 2);
    expect(ui.repliesTo("q1")[0].content).toEqual({ name: "slow", result: 1 });

    // With room again, the same question is answered.
    await ui.send("query-ref", { name: "fast" }, "q3");
    await run(worker, 1);
    expect(ui.repliesTo("q3")[0].content).toEqual({ name: "fast", result: 2 });
  });

  it("makes a standing directive wait for room instead of refusing it", async () => {
    const bus = new InMemoryMessageBus();
    const slow = slowExpressions();
    const worker = agent(bus, [], {
      expressionLibrary: slow.library,
      maxConcurrentEvaluations: 1,
    });
    const ui = client(bus);
    await worker.start();

    await ui.send("query-ref", { name: "slow" }, "q1");
    await run(worker, 1);
    await ui.send("subscribe", { name: "fast" }, "s1");
    await run(worker, 3);

    // Agreed to, but not evaluated while the slot is taken.
    expect(ui.repliesTo("s1").map((m) => m.performative)).toEqual(["agree"]);

    slow.releaseAll();
    await run(worker, 2);
    expect(ui.repliesTo("s1").map((m) => m.performative)).toEqual([
      "agree",
      "inform",
    ]);
  });

  it("has no limit at 0", async () => {
    const bus = new InMemoryMessageBus();
    const slow = slowExpressions();
    const worker = agent(bus, [], {
      expressionLibrary: slow.library,
      maxConcurrentEvaluations: 0,
    });
    const ui = client(bus);
    await worker.start();

    for (let i = 0; i < 5; i++) {
      await ui.send("query-ref", { name: "slow" }, `q${i}`);
    }
    await run(worker, 1);
    expect(ui.inbox.filter((m) => m.performative === "refuse")).toEqual([]);

    slow.releaseAll();
    await run(worker, 2);
    expect(ui.inbox.filter((m) => m.performative === "inform")).toHaveLength(5);
  });
});
