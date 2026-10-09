import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message, Performative } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning.js";
import type {
  AgentConfig,
  BeliefMiddleware,
  DelegationSettled,
  IntentionDelegated,
  IntentionFailed,
} from "../src/core/reasoning.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { Action, ActionResult, Plan } from "../src/core/plans.js";
import type { Delegation, Intention } from "../src/core/intentions.js";
import type { Goal } from "../src/core/goals.js";

/** An agent serving the given plans, with any extra config. */
function agent(
  bus: InMemoryMessageBus,
  id: string,
  plans: Plan[],
  config: Partial<AgentConfig> = {},
): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library, ...config });
}

/** A plan of `steps` no-op actions, so the goal takes that many cycles. */
function worker(name: string, steps = 1): Plan {
  return {
    name,
    body: Array.from({ length: steps }, (_, i) => ({
      name: `${name}-${i}`,
      execute: async (): Promise<ActionResult> => ({}),
    })),
  };
}

/** An action that hands off the given work. */
function delegating(result: ActionResult): Action {
  return { name: "delegate", execute: async () => result };
}

/** An action that records the intention's delegations, as it saw them. */
function observe(seen: Delegation[][]): Action {
  return {
    name: "observe",
    execute: async (intention: Intention): Promise<ActionResult> => {
      seen.push(intention.delegations.map((d) => ({ ...d })));
      return {};
    },
  };
}

/** Ticks every agent, in turn, `cycles` times. */
async function run(agents: Agent[], cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A peer that is not an agent: records what it receives and answers each
 * message however the test says, in the message's own exchange.
 */
function scriptedPeer(
  bus: InMemoryMessageBus,
  id: string,
  respond: (
    msg: Message,
    reply: (performative: Performative, content: unknown) => void,
  ) => void = () => {},
): Message[] {
  const received: Message[] = [];
  bus.registerAgent(id, (msg) => {
    received.push(msg);
    respond(msg, (performative, content) => {
      void bus.send(msg.sender, {
        performative,
        sender: id,
        receiver: msg.sender,
        content,
        ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
        ...(msg.replyWith ? { inReplyTo: msg.replyWith } : {}),
        timestamp: Date.now(),
      });
    });
  });
  return received;
}

/** A requester inbox at `ui`, and a way to send `boss` a request from it. */
function requester(bus: InMemoryMessageBus) {
  const inbox: Message[] = [];
  bus.registerAgent("ui", (m) => inbox.push(m));
  return {
    inbox,
    request(goal: string, ids: { replyWith?: string } = {}): Promise<void> {
      return bus.send("boss", {
        performative: "request",
        sender: "ui",
        receiver: "boss",
        content: { goal },
        conversationId: "conv-ui",
        replyWith: ids.replyWith ?? "req-ui",
        timestamp: Date.now(),
      });
    },
    cancel(target = "req-ui"): Promise<void> {
      return bus.send("boss", {
        performative: "cancel",
        sender: "ui",
        receiver: "boss",
        content: {},
        conversationId: "conv-ui",
        replyWith: "cancel-ui",
        inReplyTo: target,
        timestamp: Date.now(),
      });
    },
    performatives(): string[] {
      return inbox.map((m) => m.performative);
    },
  };
}

function recordFailures(a: Agent): string[] {
  const reasons: string[] = [];
  a.on("intention:failed", (e: IntentionFailed) =>
    reasons.push(`${e.intention.goal.name}: ${e.reason}`),
  );
  return reasons;
}

describe("Delegating to another agent", () => {
  it("waits for the delegate, then resumes with its result", async () => {
    const bus = new InMemoryMessageBus();
    const seen: Delegation[][] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [
              { receiver: "warehouse", goal: "pick", view: { orderId: "o-1" } },
            ],
          }),
          observe(seen),
        ],
      },
    ]);
    const warehouse = agent(bus, "warehouse", [
      {
        name: "pick",
        body: [
          worker("pick-a", 1).body[0],
          {
            name: "found",
            execute: async () => ({ result: { bin: "A3" } }),
          },
        ],
      },
    ]);
    const ui = requester(bus);
    const toWarehouse: Message[] = [];
    const fromWarehouse: Message[] = [];
    warehouse.on("message:sent", (m) => fromWarehouse.push(m));
    boss.on("message:sent", (m) => {
      if (m.receiver === "warehouse") toWarehouse.push(m);
    });
    await boss.start();
    await warehouse.start();

    await ui.request("ship");
    await run([boss, warehouse]);

    // The request is the goal's conversation, a new exchange of its own.
    const request = toWarehouse.find((m) => m.performative === "request")!;
    expect(request.content).toEqual({ orderId: "o-1", goal: "pick" });
    expect(request.conversationId).toBe("conv-ui");
    expect(request.inReplyTo).toBeUndefined();
    expect(request.replyWith).toBeDefined();

    // The next action ran only once the work was done, and saw it done.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      {
        receiver: "warehouse",
        goal: "pick",
        status: "done",
        exchange: request.replyWith,
        goalId: expect.any(String),
        result: { bin: "A3" },
        deadline: expect.any(Number),
      },
    ]);
    // The delegate's plan answered through `result`, carried by its `done`.
    expect(
      fromWarehouse.find((m) => m.performative === "inform")?.content,
    ).toEqual({
      goal: "pick",
      goalId: expect.any(String),
      done: true,
      result: { bin: "A3" },
    });

    // And the requester got one agree and one done, for its own request.
    expect(ui.performatives()).toEqual(["agree", "inform"]);
    expect(ui.inbox[1].inReplyTo).toBe("req-ui");
    expect(ui.inbox[1].content).toMatchObject({ done: true });
  });

  it("reports the delegation as agreed while the delegate works", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [{ receiver: "warehouse", goal: "pick" }],
          }),
          observe([]),
        ],
      },
    ]);
    const warehouse = agent(bus, "warehouse", [worker("pick", 10)]);
    await boss.start();
    await warehouse.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss, warehouse], 3);

    const [intention] = boss.intentions.getByGoal("g");
    expect(intention.status).toBe("waiting");
    expect(intention.delegations[0].status).toBe("agreed");
    expect(intention.delegations[0].goalId).toBe(
      warehouse.goals.getUnfinished().find((g) => g.name === "pick")!.id,
    );
  });

  it("fails the parent when the delegate refuses, and answers its requester failure", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [{ receiver: "warehouse", goal: "pick" }],
          }),
          observe([]),
        ],
      },
    ]);
    // Serves nothing, so the request is refused `no-plan`.
    const warehouse = agent(bus, "warehouse", []);
    const ui = requester(bus);
    const failures = recordFailures(boss);
    await boss.start();
    await warehouse.start();

    await ui.request("ship");
    await run([boss, warehouse]);

    expect(failures).toEqual([
      'ship: delegation of "pick" to warehouse failed: refused (no-plan): no plan serves "pick"',
    ]);
    expect(ui.performatives()).toEqual(["agree", "failure"]);
    expect(ui.inbox[1].inReplyTo).toBe("req-ui");
  });

  it("records the refusal and resumes when the delegation may fail", async () => {
    const bus = new InMemoryMessageBus();
    const failuresSeen: Intention["childFailures"][] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [
              { receiver: "warehouse", goal: "pick", onFailure: "continue" },
            ],
          }),
          {
            name: "recover",
            execute: async (intention) => {
              failuresSeen.push([...intention.childFailures]);
              return {};
            },
          },
        ],
      },
    ]);
    const warehouse = agent(bus, "warehouse", []);
    const completed: string[] = [];
    boss.on("intention:completed", (i) => completed.push(i.goal.name));
    await boss.start();
    await warehouse.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss, warehouse]);

    expect(failuresSeen).toEqual([
      [
        {
          goal: "pick",
          reason: 'refused (no-plan): no plan serves "pick"',
          receiver: "warehouse",
          exchange: expect.any(String),
        },
      ],
    ]);
    expect(completed).toEqual(["ship"]);
  });

  it("fails the parent when the delegate fails after agreeing, and cascades up", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [delegating({ delegations: [{ goal: "stage" }] }), observe([])],
      },
      {
        name: "stage",
        body: [
          delegating({
            delegations: [{ receiver: "warehouse", goal: "pick" }],
          }),
          observe([]),
        ],
      },
    ]);
    const warehouse = agent(bus, "warehouse", [
      {
        name: "pick",
        body: [
          {
            name: "shelf-empty",
            execute: async () => ({ failure: { reason: "out of stock" } }),
          },
        ],
      },
    ]);
    const ui = requester(bus);
    const failures = recordFailures(boss);
    await boss.start();
    await warehouse.start();

    await ui.request("ship");
    await run([boss, warehouse], 12);

    expect(failures).toEqual([
      'stage: delegation of "pick" to warehouse failed: out of stock',
      'ship: sub-goal "stage" failed: delegation of "pick" to warehouse failed: out of stock',
    ]);
    expect(ui.performatives()).toEqual(["agree", "failure"]);
  });

  it("waits for every delegation before resuming", async () => {
    const bus = new InMemoryMessageBus();
    const seen: Delegation[][] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [
              { receiver: "warehouse", goal: "pick" },
              { receiver: "courier", goal: "deliver" },
            ],
          }),
          observe(seen),
        ],
      },
    ]);
    const warehouse = agent(bus, "warehouse", [worker("pick", 1)]);
    const courier = agent(bus, "courier", [worker("deliver", 6)]);
    const settled: string[] = [];
    boss.on("delegation:settled", (e: DelegationSettled) =>
      settled.push(e.delegation.goal),
    );
    await boss.start();
    await warehouse.start();
    await courier.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss, warehouse, courier], 4);
    // The quick one is done; the parent is still waiting on the slow one.
    expect(settled).toEqual(["pick"]);
    expect(seen).toEqual([]);
    expect(boss.intentions.getByGoal("g")[0].status).toBe("waiting");

    await run([boss, warehouse, courier], 10);
    expect(settled).toEqual(["pick", "deliver"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].map((d) => d.status)).toEqual(["done", "done"]);
  });

  it("takes no queue slot on the delegator, and holds its intention slot while waiting", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [{ receiver: "warehouse", goal: "pick" }],
            }),
            observe([]),
          ],
        },
        worker("other"),
      ],
      { maxConcurrentIntentions: 1 },
    );
    const warehouse = agent(bus, "warehouse", [worker("pick", 10)]);
    await boss.start();
    await warehouse.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss, warehouse], 3);
    // Only the delegating goal is in the queue: the remote work is not.
    expect(boss.goals.getUnfinished().map((g) => g.name)).toEqual(["ship"]);

    // The waiting intention fills the only slot, so other work waits for it.
    boss.goals.add({ id: "o", name: "other", priority: 1, status: "pending" });
    await run([boss, warehouse], 2);
    expect(boss.intentions.getByGoal("o")).toEqual([]);

    await run([boss, warehouse], 15);
    expect(boss.goals.get("o")).toBeUndefined();
    expect(boss.goals.get("g")).toBeUndefined();
  });

  it("fails the delegation when the delegate does not understand it", async () => {
    const bus = new InMemoryMessageBus();
    scriptedPeer(bus, "warehouse", (msg, reply) => {
      if (msg.performative === "request") {
        reply("not-understood", { event: "request", reason: "unknown goal" });
      }
    });
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [{ receiver: "warehouse", goal: "pick" }],
          }),
        ],
      },
    ]);
    const failures = recordFailures(boss);
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 4);

    expect(failures).toEqual([
      'ship: delegation of "pick" to warehouse failed: not understood: unknown goal',
    ]);
  });

  it("fails the delegation when the delegate never replies by reply-by", async () => {
    const bus = new InMemoryMessageBus();
    scriptedPeer(bus, "warehouse");
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [{ receiver: "warehouse", goal: "pick" }],
            }),
          ],
        },
      ],
      { replyTimeoutMs: 20 },
    );
    const failures = recordFailures(boss);
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 2);
    expect(failures).toEqual([]);
    await wait(30);
    await run([boss], 1);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^ship: delegation of "pick" to warehouse failed: no reply by /,
    );
  });

  it("fails the delegation, and cancels the work, when it is not done in time", async () => {
    const bus = new InMemoryMessageBus();
    const received = scriptedPeer(bus, "warehouse", (msg, reply) => {
      if (msg.performative === "request") {
        reply("agree", { goal: "pick", goalId: "w-1" });
      }
    });
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [{ receiver: "warehouse", goal: "pick" }],
            }),
          ],
        },
      ],
      { delegationTimeoutMs: 20 },
    );
    const failures = recordFailures(boss);
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 3);
    expect(failures).toEqual([]);
    await wait(30);
    await run([boss], 1);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^ship: delegation of "pick" to warehouse failed: not done by /,
    );
    const request = received.find((m) => m.performative === "request")!;
    const cancel = received.find((m) => m.performative === "cancel")!;
    expect(cancel.inReplyTo).toBe(request.replyWith);
    expect(cancel.content).toEqual({ goal: "pick", goalId: "w-1" });
  });

  it("lets a delegation set its own deadline, or none", async () => {
    const bus = new InMemoryMessageBus();
    scriptedPeer(bus, "warehouse", (msg, reply) => {
      if (msg.performative === "request") reply("agree", { goalId: "w" });
    });
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [
                { receiver: "warehouse", goal: "pick", timeoutMs: null },
              ],
            }),
          ],
        },
      ],
      { delegationTimeoutMs: 10 },
    );
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 2);
    await wait(20);
    await run([boss], 2);

    const [intention] = boss.intentions.getByGoal("g");
    expect(intention.status).toBe("waiting");
    expect(intention.delegations[0].deadline).toBeUndefined();
  });

  it("closes the request, and fails the delegation, when middleware will not believe the result", async () => {
    const bus = new InMemoryMessageBus();
    const distrustWarehouse: BeliefMiddleware = async (msg, next) => {
      if (msg.sender !== "warehouse") await next();
    };
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [{ receiver: "warehouse", goal: "pick" }],
            }),
          ],
        },
      ],
      { middleware: [distrustWarehouse] },
    );
    const warehouse = agent(bus, "warehouse", [worker("pick")]);
    const failures = recordFailures(boss);
    await boss.start();
    await warehouse.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss, warehouse]);

    expect(failures).toEqual([
      'ship: delegation of "pick" to warehouse failed: result not accepted by belief middleware',
    ]);
    // Nothing is left open: the request ended with the peer's terminal reply.
    const sentRequests = (
      boss as unknown as { sentRequests: Map<string, unknown> }
    ).sentRequests;
    expect(sentRequests.size).toBe(0);
  });

  it("ignores a late reply to a delegation already settled", async () => {
    const bus = new InMemoryMessageBus();
    let replyLater: (() => void) | undefined;
    scriptedPeer(bus, "warehouse", (msg, reply) => {
      if (msg.performative === "request") {
        reply("agree", { goalId: "w" });
        replyLater = () => reply("inform", { goal: "pick", done: true });
      }
    });
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [
                { receiver: "warehouse", goal: "pick", onFailure: "continue" },
              ],
            }),
          ],
        },
      ],
      { delegationTimeoutMs: 10 },
    );
    const settled: Delegation[] = [];
    boss.on("delegation:settled", (e) => settled.push(e.delegation));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 2);
    await wait(20);
    await run([boss], 1);
    replyLater!();
    await run([boss], 2);

    expect(settled.map((d) => d.status)).toEqual(["failed"]);
  });

  it("cancels the open delegations of a parent that fails", async () => {
    const bus = new InMemoryMessageBus();
    const received = scriptedPeer(bus, "warehouse", (msg, reply) => {
      if (msg.performative === "request") reply("agree", { goalId: "w-1" });
      if (msg.performative === "cancel")
        reply("inform", { cancelled: "request" });
    });
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [
              { receiver: "warehouse", goal: "pick" },
              { goal: "check" },
            ],
          }),
        ],
      },
      {
        name: "check",
        body: [
          {
            name: "fail",
            execute: async () => ({ failure: { reason: "bad address" } }),
          },
        ],
      },
    ]);
    const settled: DelegationSettled[] = [];
    boss.on("delegation:settled", (e) => settled.push(e));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 6);

    expect(
      settled.map((e) => [e.delegation.goal, e.delegation.status]),
    ).toEqual([
      ["check", "failed"],
      ["pick", "cancelled"],
    ]);
    const request = received.find((m) => m.performative === "request")!;
    const cancels = received.filter((m) => m.performative === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].inReplyTo).toBe(request.replyWith);
    expect(
      boss.beliefs.get(`cancelled.warehouse.pick.${request.replyWith}`),
    ).toEqual({ cancelled: "request" });
  });

  it("passes a cancel of its own request on to its delegates", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        cancellable: true,
        body: [
          delegating({
            delegations: [{ receiver: "warehouse", goal: "pick" }],
          }),
          observe([]),
        ],
      },
    ]);
    const ranOnWarehouse: string[] = [];
    const warehouse = agent(bus, "warehouse", [
      {
        name: "pick",
        cancellable: true,
        body: Array.from({ length: 10 }, (_, i) => ({
          name: `pick-${i}`,
          execute: async (): Promise<ActionResult> => {
            ranOnWarehouse.push(`pick-${i}`);
            return {};
          },
        })),
      },
    ]);
    const ui = requester(bus);
    const cancelled: Goal[] = [];
    warehouse.on("goal:cancelled", (e) => cancelled.push(e.goal));
    await boss.start();
    await warehouse.start();

    await ui.request("ship");
    await run([boss, warehouse], 3);
    await ui.cancel();
    await run([boss, warehouse], 4);

    expect(ui.performatives()).toEqual(["agree", "inform"]);
    expect(ui.inbox[1].content).toMatchObject({ cancelled: "request" });
    expect(cancelled.map((g) => g.name)).toEqual(["pick"]);
    const ranAtCancel = ranOnWarehouse.length;
    await run([boss, warehouse], 4);
    expect(ranOnWarehouse.length).toBe(ranAtCancel);
    expect(ranAtCancel).toBeLessThan(10);
  });

  it("reports the delegations an action made, and those it waits on", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [
              { receiver: "warehouse", goal: "pick" },
              { goal: "pack" },
            ],
          }),
          observe([]),
        ],
      },
      worker("pack", 2),
    ]);
    scriptedPeer(bus, "warehouse");
    const delegated: IntentionDelegated[] = [];
    const waiting: Array<{ children: string[]; delegations: Delegation[] }> =
      [];
    boss.on("intention:delegated", (e) => delegated.push(e));
    boss.on("intention:waiting", (e) =>
      waiting.push({ children: e.children, delegations: e.delegations }),
    );
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 1);

    expect(delegated).toHaveLength(1);
    expect(
      delegated[0].delegations.map((d) => [d.receiver, d.goal, d.status]),
    ).toEqual([
      ["warehouse", "pick", "sent"],
      ["boss", "pack", "agreed"],
    ]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].children).toEqual([delegated[0].delegations[1].goalId]);
    expect(waiting[0].delegations).toHaveLength(2);
  });
});

describe("Delegating to this agent", () => {
  it("creates a sub-goal, with the view as its data, and waits for it", async () => {
    const bus = new InMemoryMessageBus();
    const seen: Delegation[][] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [
              { goal: "pack", view: { box: "large" }, priority: 7 },
            ],
          }),
          observe(seen),
        ],
      },
      worker("pack", 2),
    ]);
    const added: Goal[] = [];
    boss.on("goal:added", (g) => added.push({ ...g }));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 8);

    const pack = added.find((g) => g.name === "pack")!;
    expect(pack).toMatchObject({
      parentGoalId: "g",
      rootGoalId: "g",
      priority: 7,
      data: { box: "large" },
    });
    expect(seen).toEqual([
      [{ receiver: "boss", goal: "pack", status: "done", goalId: pack.id }],
    ]);
  });

  it("is also what receiver: <own id> means", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({ delegations: [{ receiver: "boss", goal: "pack" }] }),
        ],
      },
      worker("pack"),
    ]);
    const sent: Message[] = [];
    boss.on("message:sent", (m) => sent.push(m));
    const added: Goal[] = [];
    boss.on("goal:added", (g) => added.push({ ...g }));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 5);

    expect(sent).toEqual([]);
    expect(added.find((g) => g.name === "pack")?.parentGoalId).toBe("g");
  });

  it("has no deadline unless it sets one", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [{ goal: "slow" }, { goal: "slow", timeoutMs: 10 }],
            }),
          ],
        },
        worker("slow", 50),
      ],
      { delegationTimeoutMs: 10 },
    );
    const failures = recordFailures(boss);
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 1);
    const [intention] = boss.intentions.getByGoal("g");
    expect(intention.delegations.map((d) => d.deadline !== undefined)).toEqual([
      false,
      true,
    ]);
    await wait(20);
    await run([boss], 1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^ship: sub-goal "slow" failed: not done by /);
  });

  /** A plan of `steps` actions that records each one, and its clean-up. */
  function recording(
    name: string,
    steps: number,
    ran: string[],
    options: Partial<Plan> = {},
  ): Plan {
    return {
      name,
      body: Array.from({ length: steps }, (_, i) => ({
        name: `${name}-${i}`,
        execute: async (): Promise<ActionResult> => {
          ran.push(`${name}-${i}`);
          return {};
        },
      })),
      onCancel: {
        name: "undo",
        execute: async () => {
          ran.push(`${name}-undo`);
          return {};
        },
      },
      ...options,
    };
  }

  it("withdraws a timed-out sub-goal the way a delegate withdraws a cancelled request", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [delegating({ delegations: [{ goal: "pack", timeoutMs: 10 }] })],
      },
      recording("pack", 50, ran, { cancellable: true }),
    ]);
    const cancelled: Array<{ goal: string; by: string }> = [];
    boss.on("goal:cancelled", (e) =>
      cancelled.push({ goal: e.goal.name, by: e.by }),
    );
    const failures = recordFailures(boss);
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 3);
    await wait(20);
    await run([boss], 1);
    const ranAtTimeout = ran.length;
    await run([boss], 3);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^ship: sub-goal "pack" failed: not done by /);
    expect(cancelled).toEqual([{ goal: "pack", by: "boss" }]);
    // The clean-up ran, and no step after it.
    expect(ran[ranAtTimeout - 1]).toBe("pack-undo");
    expect(ran.length).toBe(ranAtTimeout);
    expect(boss.goals.getUnfinished()).toEqual([]);
  });

  it("lets a timed-out sub-goal finish when its started plan is not cancellable", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [delegating({ delegations: [{ goal: "pack", timeoutMs: 10 }] })],
      },
      recording("pack", 6, ran),
    ]);
    const cancelled: string[] = [];
    boss.on("goal:cancelled", (e) => cancelled.push(e.goal.name));
    const completed: string[] = [];
    boss.on("intention:completed", (i) => completed.push(i.goal.name));
    const failures = recordFailures(boss);
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 3);
    await wait(20);
    await run([boss], 10);

    expect(failures).toHaveLength(1);
    expect(cancelled).toEqual([]);
    // Ran to the end, as a delegate that answered the cancel `failure` would.
    expect(completed).toEqual(["pack"]);
    expect(ran).not.toContain("pack-undo");
  });

  it("drops a timed-out sub-goal that has not started, whatever its plan", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({ delegations: [{ goal: "pack", timeoutMs: 10 }] }),
          ],
        },
        recording("pack", 3, ran),
        worker("hog", 30),
      ],
      // "hog" and "ship" take both slots, so "pack" never starts.
      { maxConcurrentIntentions: 2 },
    );
    const cancelled: string[] = [];
    boss.on("goal:cancelled", (e) => cancelled.push(e.goal.name));
    await boss.start();
    boss.goals.add({ id: "h", name: "hog", priority: 9, status: "pending" });
    await run([boss], 1);
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 3);
    expect(boss.goals.getUnfinished().map((g) => g.name)).toContain("pack");
    await wait(20);
    await run([boss], 1);

    expect(cancelled).toEqual(["pack"]);
    expect(ran).toEqual([]);
    expect(boss.goals.getUnfinished().map((g) => g.name)).toEqual(["hog"]);
  });

  it("withdraws the open sub-goals of a parent that fails", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({ delegations: [{ goal: "check" }, { goal: "pack" }] }),
          observe([]),
        ],
      },
      {
        name: "check",
        body: [
          { name: "look", execute: async () => ({}) },
          {
            name: "fail",
            execute: async () => ({ failure: { reason: "bad address" } }),
          },
        ],
      },
      recording("pack", 20, ran, { cancellable: true }),
    ]);
    const settled: Array<[string, string]> = [];
    boss.on("delegation:settled", (e) =>
      settled.push([e.delegation.goal, e.delegation.status]),
    );
    const cancelled: string[] = [];
    boss.on("goal:cancelled", (e) => cancelled.push(e.goal.name));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 8);

    expect(settled).toEqual([
      ["check", "failed"],
      ["pack", "cancelled"],
    ]);
    expect(cancelled).toEqual(["pack"]);
    expect(ran.at(-1)).toBe("pack-undo");
    expect(ran.length).toBeLessThan(5);
    expect(boss.goals.getUnfinished()).toEqual([]);
  });
});

describe("Waiting on the last action's work", () => {
  it("does not answer the requester until delegated work from the last action is done", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [{ receiver: "warehouse", goal: "pick" }],
          }),
        ],
      },
    ]);
    const warehouse = agent(bus, "warehouse", [worker("pick", 5)]);
    const ui = requester(bus);
    await boss.start();
    await warehouse.start();

    await ui.request("ship");
    await run([boss, warehouse], 3);
    expect(ui.performatives()).toEqual(["agree"]);

    await run([boss, warehouse], 10);
    expect(ui.performatives()).toEqual(["agree", "inform"]);
  });

  it("does not complete the parent before sub-goals delegated by its last action", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [delegating({ delegations: [{ goal: "pack" }] })],
      },
      worker("pack", 3),
    ]);
    const completed: string[] = [];
    boss.on("intention:completed", (i) => completed.push(i.goal.name));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 10);

    expect(completed).toEqual(["pack", "ship"]);
  });
});

describe("Spawning independent goals", () => {
  it("adds root goals the intention neither waits for nor answers for", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          {
            name: "spawn",
            execute: async () => ({
              spawn: [{ name: "audit", priority: 3, data: { orderId: "o-1" } }],
            }),
          },
        ],
      },
      worker("audit", 3),
    ]);
    const ui = requester(bus);
    const added: Goal[] = [];
    boss.on("goal:added", (g) => added.push({ ...g }));
    const completed: string[] = [];
    boss.on("intention:completed", (i) => completed.push(i.goal.name));
    await boss.start();

    await ui.request("ship");
    await run([boss], 10);

    const audit = added.find((g) => g.name === "audit")!;
    expect(audit.parentGoalId).toBeUndefined();
    expect(audit.rootGoalId).toBeUndefined();
    expect(audit.source).toBeUndefined();
    expect(audit.data).toEqual({ orderId: "o-1" });
    // The parent finished first: it never waited for the spawned goal.
    expect(completed).toEqual(["ship", "audit"]);
    expect(ui.performatives()).toEqual(["agree", "inform"]);
  });

  it("keeps a spawned goal running when the goal that spawned it fails", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          {
            name: "spawn-then-fail",
            execute: async () => ({
              spawn: [{ name: "audit", priority: 3 }],
              failure: { reason: "nope" },
            }),
          },
        ],
      },
      worker("audit", 2),
    ]);
    const completed: string[] = [];
    boss.on("intention:completed", (i) => completed.push(i.goal.name));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 6);

    expect(completed).toEqual(["audit"]);
  });
});

describe("Removing a goal before it finished", () => {
  /** The agent's private request tracking, to check nothing is left behind. */
  function tracking(a: Agent) {
    const internals = a as unknown as {
      sentRequests: Map<string, unknown>;
      pendingCancels: Map<string, unknown>;
      remoteDelegations: Map<string, unknown>;
    };
    return {
      sentRequests: internals.sentRequests.size,
      pendingCancels: internals.pendingCancels.size,
      remoteDelegations: internals.remoteDelegations.size,
    };
  }

  it("fails its waiting intention and cancels its delegations", async () => {
    const bus = new InMemoryMessageBus();
    const received = scriptedPeer(bus, "warehouse", (msg, reply) => {
      if (msg.performative === "request") reply("agree", { goalId: "w-1" });
      if (msg.performative === "cancel")
        reply("inform", { cancelled: "request" });
    });
    const ran: string[] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [{ receiver: "warehouse", goal: "pick" }],
          }),
          {
            name: "after",
            execute: async () => {
              ran.push("after");
              return {};
            },
          },
        ],
      },
    ]);
    const ui = requester(bus);
    const failures = recordFailures(boss);
    await boss.start();

    await ui.request("ship");
    await run([boss], 3);
    const goalId = boss.goals.getUnfinished()[0].id;
    boss.goals.remove(goalId);
    await run([boss], 3);

    expect(failures).toEqual(["ship: goal removed before it finished"]);
    expect(boss.intentions.getAll()).toEqual([]);
    expect(received.map((m) => m.performative)).toEqual(["request", "cancel"]);
    expect(ran).toEqual([]);
    expect(ui.performatives()).toEqual(["agree", "failure"]);
    expect(tracking(boss)).toEqual({
      sentRequests: 0,
      pendingCancels: 0,
      remoteDelegations: 0,
    });
  });

  it("starts no further action of a plan that was part-way through", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const boss = agent(bus, "boss", [
      {
        name: "walk",
        body: Array.from({ length: 5 }, (_, i) => ({
          name: `step-${i}`,
          execute: async (): Promise<ActionResult> => {
            ran.push(`step-${i}`);
            return {};
          },
        })),
      },
    ]);
    await boss.start();
    boss.goals.add({ id: "g", name: "walk", priority: 5, status: "pending" });

    await run([boss], 2);
    boss.goals.remove("g");
    await run([boss], 4);

    expect(ran).toEqual(["step-0", "step-1"]);
    expect(boss.intentions.getAll()).toEqual([]);
  });

  it("lets a running action finish, applies its result, and starts nothing after it", async () => {
    const bus = new InMemoryMessageBus();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const actionStarted = new Promise<void>((r) => (started = r));
    const ran: string[] = [];
    const boss = agent(bus, "boss", [
      {
        name: "walk",
        body: [
          {
            name: "slow",
            execute: async (): Promise<ActionResult> => {
              started();
              await new Promise<void>((r) => (release = r));
              ran.push("slow");
              return { beliefUpdates: [{ key: "slow-done", value: true }] };
            },
          },
          {
            name: "next",
            execute: async (): Promise<ActionResult> => {
              ran.push("next");
              return {};
            },
          },
        ],
      },
    ]);
    const failures = recordFailures(boss);
    await boss.start();
    boss.goals.add({ id: "g", name: "walk", priority: 5, status: "pending" });

    const ticking = boss.tick();
    await actionStarted;
    boss.goals.remove("g");
    release();
    await ticking;
    await run([boss], 3);

    expect(ran).toEqual(["slow"]);
    expect(boss.beliefs.get("slow-done")).toBe(true);
    expect(failures).toEqual(["walk: goal removed before it finished"]);
    expect(boss.intentions.getAll()).toEqual([]);
  });

  it("withdraws its own sub-goals and drops the goals that depended on it", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [delegating({ delegations: [{ goal: "pack" }] }), observe([])],
      },
      {
        name: "pack",
        cancellable: true,
        body: Array.from({ length: 10 }, (_, i) => ({
          name: `pack-${i}`,
          execute: async (): Promise<ActionResult> => {
            ran.push(`pack-${i}`);
            return {};
          },
        })),
      },
      worker("invoice"),
    ]);
    const cancelled: string[] = [];
    boss.on("goal:cancelled", (e) => cancelled.push(e.goal.name));
    const statuses: Array<[string, string]> = [];
    boss.on("goal:status", ({ goal, to }) => statuses.push([goal.name, to]));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });
    boss.goals.add({
      id: "i",
      name: "invoice",
      priority: 1,
      status: "pending",
      dependsOn: ["g"],
    });

    await run([boss], 4);
    const ranAtRemoval = ran.length;
    boss.goals.remove("g");
    await run([boss], 4);

    expect(cancelled).toEqual(["pack"]);
    expect(ran.length).toBe(ranAtRemoval);
    expect(statuses).toContainEqual(["invoice", "dropped"]);
    expect(boss.goals.getUnfinished()).toEqual([]);
    expect(boss.intentions.getAll()).toEqual([]);
  });
});

describe("Tracking of an abandoned delegation", () => {
  function tracking(a: Agent) {
    const internals = a as unknown as {
      sentRequests: Map<string, unknown>;
      pendingCancels: Map<string, unknown>;
    };
    return {
      sentRequests: internals.sentRequests.size,
      pendingCancels: internals.pendingCancels.size,
    };
  }

  /**
   * Delegates to the warehouse, then fails on a local sub-goal, which
   * abandons the warehouse's delegation.
   */
  function failingBoss(bus: InMemoryMessageBus, config: Partial<AgentConfig>) {
    return agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [
                { receiver: "warehouse", goal: "pick" },
                { goal: "check" },
              ],
            }),
          ],
        },
        {
          name: "check",
          body: [
            {
              name: "fail",
              execute: async () => ({ failure: { reason: "bad address" } }),
            },
          ],
        },
      ],
      config,
    );
  }

  it("ends when the delegate never answers the cancel", async () => {
    const bus = new InMemoryMessageBus();
    const received = scriptedPeer(bus, "warehouse", (msg, reply) => {
      // Agrees, then goes silent: no final reply, no answer to the cancel.
      if (msg.performative === "request") reply("agree", { goalId: "w-1" });
    });
    const boss = failingBoss(bus, { replyTimeoutMs: 20 });
    const timeouts: string[] = [];
    boss.on("reply:timeout", (e) => timeouts.push(e.performative));
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 4);
    const cancel = received.find((m) => m.performative === "cancel")!;
    expect(cancel.replyBy).toBeDefined();
    expect(tracking(boss)).toEqual({ sentRequests: 1, pendingCancels: 1 });

    await wait(30);
    await run([boss], 1);

    expect(tracking(boss)).toEqual({ sentRequests: 0, pendingCancels: 0 });
    expect(timeouts).toEqual(["cancel"]);
    const request = received.find((m) => m.performative === "request")!;
    expect(
      boss.beliefs.get(`cancel-failed.warehouse.pick.${request.replyWith}`),
    ).toMatchObject({ performative: "timeout" });
  });

  it("ends when the delegate refuses to cancel", async () => {
    const bus = new InMemoryMessageBus();
    scriptedPeer(bus, "warehouse", (msg, reply) => {
      if (msg.performative === "request") reply("agree", { goalId: "w-1" });
      if (msg.performative === "cancel")
        reply("failure", { reason: "not cancellable" });
    });
    const boss = failingBoss(bus, {});
    await boss.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss], 6);

    expect(tracking(boss)).toEqual({ sentRequests: 0, pendingCancels: 0 });
  });
});

describe("Progress notes from a delegate", () => {
  /** A courier that reports how far it got after each leg. */
  function courier(bus: InMemoryMessageBus): Agent {
    const leg = (km: number): Action => ({
      name: `leg-${km}`,
      execute: async (intention) => ({
        messages: [
          {
            receiver: intention.goal.source!.sender,
            performative: "inform",
            content: { goal: "deliver", km },
          },
        ],
      }),
    });
    return agent(bus, "courier", [
      { name: "deliver", body: [leg(10), leg(20), leg(30)] },
    ]);
  }

  it("keeps the latest note on the delegation, and reports each one", async () => {
    const bus = new InMemoryMessageBus();
    const seen: Delegation[][] = [];
    const boss = agent(bus, "boss", [
      {
        name: "ship",
        body: [
          delegating({
            delegations: [{ receiver: "courier", goal: "deliver" }],
          }),
          observe(seen),
        ],
      },
    ]);
    const notes: unknown[] = [];
    boss.on("delegation:progress", (e) => notes.push(e.delegation.progress));
    const c = courier(bus);
    await boss.start();
    await c.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss, c], 3);
    const [waiting] = boss.intentions.getByGoal("g");
    expect(waiting.status).toBe("waiting");
    expect(notes.length).toBeGreaterThan(0);
    expect(waiting.delegations[0].progress).toEqual(notes.at(-1));

    await run([boss, c], 8);
    expect(notes).toEqual([
      { goal: "deliver", km: 10 },
      { goal: "deliver", km: 20 },
      { goal: "deliver", km: 30 },
    ]);
    expect(seen[0][0]).toMatchObject({
      status: "done",
      progress: { goal: "deliver", km: 30 },
    });
  });

  it("ignores a note the belief middleware will not believe", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(
      bus,
      "boss",
      [
        {
          name: "ship",
          body: [
            delegating({
              delegations: [{ receiver: "courier", goal: "deliver" }],
            }),
            observe([]),
          ],
        },
      ],
      {
        middleware: [
          async (msg, next) => {
            const content = msg.content as { done?: boolean };
            if (content.done) await next();
          },
        ],
      },
    );
    const notes: unknown[] = [];
    boss.on("delegation:progress", (e) => notes.push(e.delegation.progress));
    const c = courier(bus);
    await boss.start();
    await c.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });

    await run([boss, c], 3);

    expect(notes).toEqual([]);
    expect(boss.intentions.getByGoal("g")[0].delegations[0].progress).toBe(
      undefined,
    );
  });
});
