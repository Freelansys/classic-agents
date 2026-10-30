import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  AgentConfig,
  IntentionFailed,
} from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";
import { GoalQueue } from "../src/core/goals.js";
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

/** Ticks the agent `cycles` times. */
async function run(a: Agent, cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i++) await a.tick();
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A requester inbox at `ui`, and a way to send `proxy` a request from it. */
function requester(bus: InMemoryMessageBus) {
  const inbox: Message[] = [];
  bus.registerAgent("ui", (m) => inbox.push(m));
  const send = (performative: "request" | "cancel", extra: Partial<Message>) =>
    bus.send("proxy", {
      performative,
      sender: "ui",
      receiver: "proxy",
      content: {},
      conversationId: "conv-ui",
      timestamp: Date.now(),
      ...extra,
    });
  return {
    inbox,
    request: (goal: string) =>
      send("request", { content: { goal }, replyWith: "req-ui" }),
    cancel: () =>
      send("cancel", { replyWith: "cancel-ui", inReplyTo: "req-ui" }),
    performatives: () => inbox.map((m) => m.performative),
  };
}

/**
 * A user proxy: a `task` request waits for the person's form, then a `reply`
 * plan answers with it. The form arrives as the belief `task.<id>.form`.
 */
function proxy(
  bus: InMemoryMessageBus,
  delegation: Record<string, unknown> = {},
  ran: string[] = [],
): Agent {
  const a = agent(bus, "proxy", [
    {
      goal: "task",
      cancellable: true,
      body: [
        {
          name: "wait-for-form",
          execute: async (intention): Promise<ActionResult> => ({
            delegations: [
              {
                goal: "reply",
                when: "form-filled",
                view: { task: intention.goal.id },
                timeoutMs: null,
                ...delegation,
              },
            ],
          }),
        },
      ],
    },
    {
      goal: "reply",
      body: [
        {
          name: "reply",
          execute: async (intention, beliefs): Promise<ActionResult> => {
            ran.push("reply");
            const { task } = intention.goal.data as { task: string };
            return { result: beliefs.get(`task.${task}.form`) };
          },
        },
      ],
    },
  ]);
  a.propositionLibrary.register({
    name: "form-filled",
    evaluate: (beliefs, message) =>
      beliefs.has(`task.${(message.content as { task: string }).task}.form`),
  });
  return a;
}

describe("A self-delegation with a when", () => {
  it("waits for its condition, then answers the requester once", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const a = proxy(bus, {}, ran);
    const ui = requester(bus);
    await a.start();

    await ui.request("task");
    await run(a, 10);

    expect(ran).toEqual([]);
    expect(ui.performatives()).toEqual(["agree"]);
    const reply = a.goals.getUnfinished().find((g) => g.name === "reply")!;
    expect(reply).toMatchObject({ status: "pending", when: "form-filled" });

    const task = (reply.data as { task: string }).task;
    a.beliefs.set(`task.${task}.form`, { name: "Ada" });
    await run(a, 5);

    expect(ran).toEqual(["reply"]);
    expect(ui.performatives()).toEqual(["agree", "inform"]);
    expect(ui.inbox[1].content).toMatchObject({ goal: "task", done: true });
    expect(a.goals.getUnfinished()).toEqual([]);
  });

  it("reports the wait on goal:added and its end on goal:removed", async () => {
    const bus = new InMemoryMessageBus();
    const a = proxy(bus);
    const added: Goal[] = [];
    const removed: string[] = [];
    a.on("goal:added", (g) => added.push({ ...g }));
    a.on("goal:removed", (g) => removed.push(g.name));
    await a.start();
    a.goals.add({ id: "t", name: "task", priority: 5, status: "pending" });

    await run(a, 4);
    const reply = added.find((g) => g.name === "reply")!;
    expect(reply.when).toBe("form-filled");
    expect(reply.data).toEqual({ task: "t" });
    expect(removed).toEqual([]);

    a.beliefs.set("task.t.form", true);
    await run(a, 5);
    expect(removed).toEqual(["reply", "task"]);
  });

  it("is withdrawn at once when the request is cancelled", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const a = proxy(bus, {}, ran);
    const ui = requester(bus);
    const ended: string[] = [];
    a.on("goal:status", (e) => ended.push(`${e.goal.name}:${e.to}`));
    await a.start();

    await ui.request("task");
    await run(a, 4);
    await ui.cancel();
    await run(a, 3);

    expect(ended).toContain("reply:dropped");
    expect(ended).not.toContain("reply:active");
    expect(ui.performatives()).toEqual(["agree", "inform"]);
    expect(ui.inbox[1].content).toMatchObject({ cancelled: "request" });
    expect(a.goals.getUnfinished()).toEqual([]);
    a.beliefs.set("task.whatever.form", true);
    await run(a, 3);
    expect(ran).toEqual([]);
  });

  it("fails when its timeout passes before the condition holds", async () => {
    const bus = new InMemoryMessageBus();
    const a = proxy(bus, { timeoutMs: 10 });
    const failures: string[] = [];
    a.on("intention:failed", (e: IntentionFailed) =>
      failures.push(`${e.intention.goal.name}: ${e.reason}`),
    );
    await a.start();
    a.goals.add({ id: "t", name: "task", priority: 5, status: "pending" });

    await run(a, 3);
    await wait(20);
    await run(a, 2);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^task: sub-goal "reply" failed: not done by/);
    expect(a.goals.getUnfinished()).toEqual([]);
  });

  it("is ignored on a delegation to another agent, which is a plain request", async () => {
    const bus = new InMemoryMessageBus();
    bus.registerAgent("clerk", () => {});
    const a = proxy(bus, { receiver: "clerk" });
    const sent: Message[] = [];
    a.on("message:sent", (m) => sent.push(m));
    await a.start();
    a.goals.add({ id: "t", name: "task", priority: 5, status: "pending" });

    await run(a, 3);

    expect(sent).toHaveLength(1);
    expect(sent[0].performative).toBe("request");
    expect(sent[0].content).toEqual({ task: "t", goal: "reply" });
  });
});

describe("A goal with a when", () => {
  function waiter(ran: string[]): Agent {
    return agent(new InMemoryMessageBus(), "a", [
      {
        goal: "go",
        body: [
          {
            name: "go",
            execute: async (): Promise<ActionResult> => {
              ran.push("go");
              return {};
            },
          },
        ],
      },
    ]);
  }

  it("added directly, is not selected until the condition holds", async () => {
    const ran: string[] = [];
    const a = waiter(ran);
    const seen: unknown[] = [];
    a.propositionLibrary.register({
      name: "ready",
      evaluate: (beliefs, message) => {
        seen.push(message.content);
        return beliefs.get("ready") === true;
      },
    });
    a.goals.add({
      id: "g",
      name: "go",
      priority: 5,
      status: "pending",
      data: { n: 1 },
      when: "ready",
    });

    await run(a, 5);
    expect(ran).toEqual([]);
    expect(seen[0]).toEqual({ n: 1 });

    a.beliefs.set("ready", true);
    await run(a, 3);
    expect(ran).toEqual(["go"]);
  });

  it("lets other goals run while it waits", async () => {
    const ran: string[] = [];
    const a = waiter(ran);
    a.propositionLibrary.register({ name: "never", evaluate: () => false });
    a.goals.add({
      id: "g1",
      name: "go",
      priority: 9,
      status: "pending",
      key: "1",
      when: "never",
    });
    a.goals.add({
      id: "g2",
      name: "go",
      priority: 1,
      status: "pending",
      key: "2",
    });

    await run(a, 4);

    expect(ran).toEqual(["go"]);
    expect(a.goals.getUnfinished().map((g) => g.id)).toEqual(["g1"]);
  });

  it("fails when it names a proposition the agent does not hold", async () => {
    const ran: string[] = [];
    const a = waiter(ran);
    const failed: string[] = [];
    a.on("goal:failed", (e) => failed.push(e.reason));
    a.goals.add({
      id: "g",
      name: "go",
      priority: 5,
      status: "pending",
      when: "missing",
    });

    await run(a, 2);

    expect(failed).toEqual(['no proposition named "missing" is registered']);
    expect(ran).toEqual([]);
  });

  it("fails when the proposition throws", async () => {
    const ran: string[] = [];
    const a = waiter(ran);
    const failed: string[] = [];
    a.on("goal:failed", (e) => failed.push(e.reason));
    a.propositionLibrary.register({
      name: "flaky",
      evaluate: () => {
        throw new Error("store down");
      },
    });
    a.goals.add({
      id: "g",
      name: "go",
      priority: 5,
      status: "pending",
      when: "flaky",
    });

    await run(a, 3);

    expect(failed).toEqual(['proposition "flaky" failed: store down']);
    expect(ran).toEqual([]);
  });

  it("fails a waiting sub-goal as a child failure the parent can tolerate", async () => {
    const bus = new InMemoryMessageBus();
    const seen: unknown[] = [];
    const a = agent(bus, "a", [
      {
        goal: "task",
        body: [
          {
            name: "wait",
            execute: async (): Promise<ActionResult> => ({
              delegations: [
                { goal: "reply", when: "flaky", onFailure: "continue" },
              ],
            }),
          },
          {
            name: "after",
            execute: async (intention): Promise<ActionResult> => {
              seen.push(...intention.childFailures.map((f) => f.reason));
              return {};
            },
          },
        ],
      },
      { goal: "reply", body: [] },
    ]);
    a.propositionLibrary.register({
      name: "flaky",
      evaluate: () => {
        throw new Error("store down");
      },
    });
    a.goals.add({ id: "t", name: "task", priority: 5, status: "pending" });

    await run(a, 6);

    expect(seen).toEqual(['proposition "flaky" failed: store down']);
    expect(a.goals.getUnfinished()).toEqual([]);
  });

  it("generated by a desire, waits the same way", async () => {
    const ran: string[] = [];
    const a = waiter(ran);
    a.propositionLibrary.register({
      name: "ready",
      evaluate: (beliefs) => beliefs.has("ready"),
    });
    a.desires.register({
      name: "wants-go",
      intend: () => ({ goal: "go", when: "ready" }),
    });

    await run(a, 4);
    expect(ran).toEqual([]);
    expect(a.goals.getUnfinished()[0]).toMatchObject({
      when: "ready",
      desire: "wants-go",
    });

    a.beliefs.set("ready", true);
    await run(a, 3);
    expect(ran).toEqual(["go"]);
  });
});

describe("GoalQueue.selectNext", () => {
  it("leaves out a goal with a when unless the caller says it holds", () => {
    const queue = new GoalQueue();
    queue.add({
      id: "a",
      name: "a",
      priority: 9,
      status: "pending",
      when: "c",
    });
    queue.add({ id: "b", name: "b", priority: 1, status: "pending" });

    expect(queue.selectNext()?.id).toBe("b");
    expect(queue.selectNext(() => false)?.id).toBe("b");
    expect(queue.selectNext((g) => g.id === "a")?.id).toBe("a");
  });
});
