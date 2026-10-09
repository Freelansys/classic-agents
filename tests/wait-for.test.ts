import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning.js";
import type { IntentionFailed } from "../src/core/reasoning.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { Action, ActionResult, Plan } from "../src/core/plans.js";
import type {
  ChildFailure,
  Delegation,
  Intention,
} from "../src/core/intentions.js";

function agent(bus: InMemoryMessageBus, id: string, plans: Plan[]): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library });
}

/** A supplier that quotes after `steps` actions, or fails instead. */
function supplier(
  bus: InMemoryMessageBus,
  id: string,
  options: {
    steps: number;
    price?: number;
    fails?: string;
    cancellable?: boolean;
  },
): { agent: Agent; ran: string[] } {
  const ran: string[] = [];
  const body: Action[] = Array.from({ length: options.steps }, (_, i) => ({
    name: `work-${i}`,
    execute: async (): Promise<ActionResult> => {
      ran.push(`work-${i}`);
      return {};
    },
  }));
  body.push({
    name: "answer",
    execute: async (): Promise<ActionResult> =>
      options.fails
        ? { failure: { reason: options.fails } }
        : { result: { price: options.price } },
  });
  return {
    agent: agent(bus, id, [
      { name: "quote", cancellable: options.cancellable ?? true, body },
    ]),
    ran,
  };
}

/** A buyer whose plan asks the given suppliers, then records what it saw. */
function buyer(
  bus: InMemoryMessageBus,
  ask: ActionResult,
  extra: Partial<Plan> = {},
  plans: Plan[] = [],
) {
  const seen: Array<{ delegations: Delegation[]; failures: ChildFailure[] }> =
    [];
  const failures: string[] = [];
  const b = agent(bus, "buyer", [
    {
      name: "buy",
      body: [
        { name: "ask", execute: async () => ask },
        {
          name: "choose",
          execute: async (intention: Intention) => {
            seen.push({
              delegations: intention.delegations.map((d) => ({ ...d })),
              failures: [...intention.childFailures],
            });
            return {};
          },
        },
      ],
      ...extra,
    },
    ...plans,
  ]);
  b.on("intention:failed", (e: IntentionFailed) =>
    failures.push(`${e.intention.goal.name}: ${e.reason}`),
  );
  return { agent: b, seen, failures };
}

async function run(agents: Agent[], cycles = 12): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

async function startAll(...agents: Agent[]): Promise<void> {
  for (const a of agents) await a.start();
}

const askAll = (
  suppliers: string[],
  waitFor: ActionResult["waitFor"],
  onFailure?: "fail" | "continue",
): ActionResult => ({
  delegations: suppliers.map((receiver) => ({
    receiver,
    goal: "quote",
    ...(onFailure ? { onFailure } : {}),
  })),
  waitFor,
});

describe('waitFor: "any"', () => {
  it("takes the first answer and cancels the rest", async () => {
    const bus = new InMemoryMessageBus();
    const fast = supplier(bus, "fast", { steps: 1, price: 9 });
    const slow = supplier(bus, "slow", { steps: 8, price: 7 });
    const slower = supplier(bus, "slower", { steps: 12, price: 5 });
    const b = buyer(bus, askAll(["fast", "slow", "slower"], "any"));
    const cancelled: string[] = [];
    for (const s of [slow, slower]) {
      s.agent.on("goal:cancelled", (e) => cancelled.push(e.goal.name));
    }
    await startAll(b.agent, fast.agent, slow.agent, slower.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, fast.agent, slow.agent, slower.agent], 8);

    expect(b.seen).toHaveLength(1);
    expect(
      b.seen[0].delegations.map((d) => [d.receiver, d.status, d.result]),
    ).toEqual([
      ["fast", "done", { price: 9 }],
      ["slow", "cancelled", undefined],
      ["slower", "cancelled", undefined],
    ]);
    // The losers were told to stop, and did.
    expect(cancelled).toEqual(["quote", "quote"]);
    const ranAtCancel = slow.ran.length + slower.ran.length;
    await run([b.agent, fast.agent, slow.agent, slower.agent], 6);
    expect(slow.ran.length + slower.ran.length).toBe(ranAtCancel);
  });

  it("keeps racing past a failure, and records it", async () => {
    const bus = new InMemoryMessageBus();
    const broken = supplier(bus, "broken", { steps: 0, fails: "closed" });
    const ok = supplier(bus, "ok", { steps: 3, price: 8 });
    const b = buyer(bus, askAll(["broken", "ok"], "any"));
    await startAll(b.agent, broken.agent, ok.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, broken.agent, ok.agent]);

    expect(b.failures).toEqual([]);
    expect(b.seen[0].delegations.map((d) => d.status)).toEqual([
      "failed",
      "done",
    ]);
    expect(b.seen[0].failures).toEqual([
      {
        goal: "quote",
        reason: "closed",
        receiver: "broken",
        exchange: expect.any(String),
        goalId: expect.any(String),
      },
    ]);
  });

  it("fails the parent only once every one has failed", async () => {
    const bus = new InMemoryMessageBus();
    const a = supplier(bus, "a", { steps: 0, fails: "closed" });
    const c = supplier(bus, "c", { steps: 2, fails: "out of stock" });
    const b = buyer(bus, askAll(["a", "c"], "any"));
    await startAll(b.agent, a.agent, c.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, a.agent, c.agent]);

    expect(b.seen).toEqual([]);
    expect(b.failures).toEqual([
      'buy: 0 of 1 needed delegations succeeded; delegation of "quote" to c failed: out of stock',
    ]);
  });

  it("resumes with every failure recorded when all of them may fail", async () => {
    const bus = new InMemoryMessageBus();
    const a = supplier(bus, "a", { steps: 0, fails: "closed" });
    const c = supplier(bus, "c", { steps: 1, fails: "out of stock" });
    const b = buyer(bus, askAll(["a", "c"], "any", "continue"));
    await startAll(b.agent, a.agent, c.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, a.agent, c.agent]);

    expect(b.failures).toEqual([]);
    expect(b.seen[0].failures.map((f) => [f.receiver, f.reason])).toEqual([
      ["a", "closed"],
      ["c", "out of stock"],
    ]);
  });

  it("races sub-goals of its own too, withdrawing the ones that lost", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const steps = (name: string, n: number): Plan => ({
      name,
      cancellable: true,
      body: Array.from({ length: n }, (_, i) => ({
        name: `${name}-${i}`,
        execute: async (): Promise<ActionResult> => {
          ran.push(`${name}-${i}`);
          return {};
        },
      })),
    });
    const b = buyer(
      bus,
      { delegations: [{ goal: "near" }, { goal: "far" }], waitFor: "any" },
      {},
      [steps("near", 1), steps("far", 10)],
    );
    const cancelled: string[] = [];
    b.agent.on("goal:cancelled", (e) => cancelled.push(e.goal.name));
    await startAll(b.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent], 10);

    expect(b.seen[0].delegations.map((d) => [d.goal, d.status])).toEqual([
      ["near", "done"],
      ["far", "cancelled"],
    ]);
    expect(cancelled).toEqual(["far"]);
    expect(ran.filter((r) => r.startsWith("far")).length).toBeLessThan(10);
    expect(b.agent.goals.getUnfinished()).toEqual([]);
  });
});

describe("waitFor: a number", () => {
  it("resumes once that many are done, and cancels the rest", async () => {
    const bus = new InMemoryMessageBus();
    const a = supplier(bus, "a", { steps: 1, price: 1 });
    const c = supplier(bus, "c", { steps: 2, price: 2 });
    const d = supplier(bus, "d", { steps: 12, price: 3 });
    const b = buyer(bus, askAll(["a", "c", "d"], 2));
    await startAll(b.agent, a.agent, c.agent, d.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, a.agent, c.agent, d.agent], 8);

    expect(b.seen[0].delegations.map((x) => x.status)).toEqual([
      "done",
      "done",
      "cancelled",
    ]);
  });

  it("fails as soon as the quorum cannot be met, cancelling the one still open", async () => {
    const bus = new InMemoryMessageBus();
    const a = supplier(bus, "a", { steps: 0, fails: "closed" });
    const c = supplier(bus, "c", { steps: 1, fails: "closed too" });
    const d = supplier(bus, "d", { steps: 20, price: 3 });
    const b = buyer(bus, askAll(["a", "c", "d"], 2));
    const settled: Array<[string, string]> = [];
    b.agent.on("delegation:settled", (e) =>
      settled.push([e.delegation.receiver, e.delegation.status]),
    );
    await startAll(b.agent, a.agent, c.agent, d.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, a.agent, c.agent, d.agent], 8);

    expect(b.failures).toEqual([
      'buy: 0 of 2 needed delegations succeeded; delegation of "quote" to c failed: closed too',
    ]);
    expect(settled).toEqual([
      ["a", "failed"],
      ["c", "failed"],
      ["d", "cancelled"],
    ]);
  });

  it("is capped at how many delegations there are", async () => {
    const bus = new InMemoryMessageBus();
    const a = supplier(bus, "a", { steps: 1, price: 1 });
    const b = buyer(bus, askAll(["a"], 5));
    await startAll(b.agent, a.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, a.agent]);

    expect(b.seen[0].delegations.map((x) => x.status)).toEqual(["done"]);
  });

  it("fails the action, sending nothing, when it is not a whole number of at least 1", async () => {
    const bus = new InMemoryMessageBus();
    const received: Message[] = [];
    bus.registerAgent("a", (m) => received.push(m));
    const b = buyer(bus, askAll(["a"], 0));
    await startAll(b.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent], 3);

    expect(received).toEqual([]);
    expect(b.failures).toEqual([
      'buy: waitFor must be "all", "any" or a whole number of at least 1, not 0',
    ]);
  });
});

describe("onFailure per delegation", () => {
  it("lets an optional delegation fail while the rest are required", async () => {
    const bus = new InMemoryMessageBus();
    const main = supplier(bus, "main", { steps: 2, price: 10 });
    const extra = supplier(bus, "extra", { steps: 0, fails: "no gift wrap" });
    const b = buyer(bus, {
      delegations: [
        { receiver: "main", goal: "quote" },
        { receiver: "extra", goal: "quote", onFailure: "continue" },
      ],
    });
    await startAll(b.agent, main.agent, extra.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, main.agent, extra.agent]);

    expect(b.failures).toEqual([]);
    expect(b.seen[0].delegations.map((d) => [d.receiver, d.status])).toEqual([
      ["main", "done"],
      ["extra", "failed"],
    ]);
    expect(b.seen[0].delegations[1].onFailure).toBe("continue");
  });

  it("overrides a plan that tolerates failures", async () => {
    const bus = new InMemoryMessageBus();
    const a = supplier(bus, "a", { steps: 0, fails: "closed" });
    const b = buyer(
      bus,
      { delegations: [{ receiver: "a", goal: "quote", onFailure: "fail" }] },
      { onChildFailure: "continue" },
    );
    await startAll(b.agent, a.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, a.agent]);

    expect(b.failures).toEqual([
      'buy: delegation of "quote" to a failed: closed',
    ]);
  });

  it("falls back to the plan's onChildFailure when it sets none", async () => {
    const bus = new InMemoryMessageBus();
    const a = supplier(bus, "a", { steps: 0, fails: "closed" });
    const b = buyer(
      bus,
      { delegations: [{ receiver: "a", goal: "quote" }] },
      { onChildFailure: "continue" },
    );
    await startAll(b.agent, a.agent);
    b.agent.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });

    await run([b.agent, a.agent]);

    expect(b.failures).toEqual([]);
    expect(b.seen).toHaveLength(1);
  });
});
