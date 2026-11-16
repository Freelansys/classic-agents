import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message, Performative } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  AgentConfig,
  AgentError,
  MessageSendFailed,
} from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";
import { ExpressionLibrary } from "../src/core/expressions.js";

/**
 * A bus over which some peers cannot be reached, as a network bus may fail
 * any send: a send to one of `down` rejects, every other send is delivered.
 */
class FlakyBus extends InMemoryMessageBus {
  readonly down = new Set<string>();

  override async send(agentId: string, message: Message): Promise<void> {
    if (this.down.has(agentId)) throw new Error(`${agentId} unreachable`);
    return super.send(agentId, message);
  }
}

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
        conversationId: `c-${replyWith}`,
        replyWith,
        timestamp: Date.now(),
      });
    },
  };
}

async function run(a: Agent, cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i++) await a.tick();
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const step = (result: ActionResult = {}) => ({
  name: "step",
  execute: async (): Promise<ActionResult> => result,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("message:send-failed", () => {
  it("reports the agree and the inform a request is owed, as stamped", async () => {
    const bus = new FlakyBus();
    const worker = agent(bus, [
      { goal: "sum", body: [step({ result: { total: 42 } })] },
    ]);
    const ui = client(bus);
    const failed: MessageSendFailed[] = [];
    const sent: Message[] = [];
    worker.on("message:send-failed", (e) => failed.push(e));
    worker.on("message:sent", (m) => sent.push(m));
    await worker.start();

    bus.down.add("ui");
    await ui.send("request", { goal: "sum" }, "r1");
    await run(worker);

    expect(failed.map((e) => e.message.performative)).toEqual([
      "agree",
      "inform",
    ]);
    for (const e of failed) {
      expect(e.agentId).toBe("worker");
      expect((e.error as Error).message).toBe("ui unreachable");
      // As stamped for the bus: in the request's exchange, with ids of its
      // own, not a reconstruction.
      expect(e.message.receiver).toBe("ui");
      expect(e.message.conversationId).toBe("c-r1");
      expect(e.message.inReplyTo).toBe("r1");
      expect(e.message.replyWith).toEqual(expect.any(String));
      expect(e.message.protocol).toBe("fipa-request");
    }
    expect(failed[0].reason).toBe(
      `the agree to ${(failed[0].message.content as { goalId: string }).goalId} to ui`,
    );
    expect(failed[1].reason).toBe("the inform that ends sum to ui");
    expect(failed[1].message.content).toMatchObject({
      goal: "sum",
      done: true,
      result: { total: 42 },
    });
    // Never reported as sent.
    expect(sent).toEqual([]);
    expect(ui.inbox).toEqual([]);
  });

  it("carries a message that can be sent again as it was", async () => {
    const bus = new FlakyBus();
    const worker = agent(bus, [{ goal: "sum", body: [step()] }]);
    const ui = client(bus);
    const failed: MessageSendFailed[] = [];
    worker.on("message:send-failed", (e) => failed.push(e));
    await worker.start();

    bus.down.add("ui");
    await ui.send("request", { goal: "sum" }, "r1");
    await run(worker);
    bus.down.delete("ui");

    for (const { message } of failed) {
      await bus.send(message.receiver as string, message);
    }
    expect(ui.inbox).toEqual(failed.map((e) => e.message));
  });

  it("reports a failed answer to a query, rather than a failed evaluation", async () => {
    const bus = new FlakyBus();
    const expressions = new ExpressionLibrary();
    expressions.register({ name: "answer", evaluate: () => 42 });
    const worker = agent(bus, [], { expressionLibrary: expressions });
    client(bus);
    const failed: MessageSendFailed[] = [];
    const errors: AgentError[] = [];
    worker.on("message:send-failed", (e) => failed.push(e));
    worker.on("agent:error", (e) => errors.push(e));
    await worker.start();

    bus.down.add("ui");
    await bus.send("worker", {
      performative: "query-ref",
      sender: "ui",
      receiver: "worker",
      content: { name: "answer" },
      replyWith: "q1",
      timestamp: Date.now(),
    });
    await run(worker, 3);

    expect(failed).toHaveLength(1);
    expect(failed[0].message).toMatchObject({
      performative: "inform",
      inReplyTo: "q1",
      content: { name: "answer", result: 42 },
    });
    expect(failed[0].reason).toBe("the inform answering query answer to ui");
    expect(errors).toEqual([]);
  });

  it("reports a not-understood it could not send, with no unhandled rejection", async () => {
    const bus = new FlakyBus();
    const worker = agent(bus, []);
    client(bus);
    const failed: MessageSendFailed[] = [];
    worker.on("message:send-failed", (e) => failed.push(e));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    await worker.start();

    try {
      bus.down.add("ui");
      await bus.send("worker", {
        performative: "query-ref",
        sender: "ui",
        receiver: "worker",
        content: { name: "nobody-knows" },
        replyWith: "q1",
        timestamp: Date.now(),
      });
      await run(worker, 2);
      await wait(10);
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(failed.map((e) => e.message.performative)).toEqual([
      "not-understood",
    ]);
    expect(failed[0].message.inReplyTo).toBe("q1");
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("is logged when nobody listens, as is a handler that throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new FlakyBus();
    const worker = agent(bus, [{ goal: "sum", body: [step()] }]);
    const ui = client(bus);
    await worker.start();

    bus.down.add("ui");
    await ui.send("request", { goal: "sum" }, "r1");
    await run(worker);

    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(
      "[worker] Failed to send the inform that ends sum to ui:",
    );
    expect(errors.mock.calls.every((c) => c[1] instanceof Error)).toBe(true);

    errors.mockClear();
    worker.on("message:send-failed", () => {
      throw new Error("reporter failed");
    });
    await ui.send("request", { goal: "sum" }, "r2");
    // The cycle the handler threw on goes on, and so does the agent.
    await expect(run(worker)).resolves.toBeUndefined();
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      "[worker] A message:send-failed handler threw:",
      "[worker] A message:send-failed handler threw:",
    ]);
  });

  it("is not emitted for a send that reached the bus", async () => {
    const bus = new FlakyBus();
    const worker = agent(bus, [{ goal: "sum", body: [step()] }]);
    const ui = client(bus);
    const failed = vi.fn();
    worker.on("message:send-failed", failed);
    await worker.start();

    await ui.send("request", { goal: "sum" }, "r1");
    await run(worker);

    expect(ui.inbox.map((m) => m.performative)).toEqual(["agree", "inform"]);
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("agent:error", () => {
  it("reports an evaluation whose outcome could not be applied", async () => {
    const bus = new FlakyBus();
    const expressions = new ExpressionLibrary();
    expressions.register({ name: "answer", evaluate: () => 42 });
    const worker = agent(bus, [], { expressionLibrary: expressions });
    const errors: AgentError[] = [];
    worker.on("agent:error", (e) => errors.push(e));

    worker.startEvaluation(
      expressions,
      "answer",
      {
        performative: "query-ref",
        sender: "ui",
        receiver: "worker",
        content: { name: "answer" },
        timestamp: Date.now(),
      },
      () => {
        throw new Error("apply failed");
      },
    );
    await wait(1);
    await run(worker, 1);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ agentId: "worker", where: "evaluation" });
    expect((errors[0].error as Error).message).toBe("apply failed");
  });

  it("reports an intention whose execution rejected outside its action", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new FlakyBus();
    const worker = agent(bus, [{ goal: "job", body: [step(), step()] }]);
    const reported: AgentError[] = [];
    vi.spyOn(
      worker as unknown as { executeIntention: () => Promise<void> },
      "executeIntention",
    ).mockRejectedValue(new Error("stack broke"));

    worker.goals.add({ id: "g1", name: "job", priority: 5, status: "pending" });
    await run(worker, 2);
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain(
      "[worker] Intention execution error:",
    );

    worker.on("agent:error", (e) => reported.push(e));
    await run(worker, 1);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ agentId: "worker", where: "execute" });
    expect((reported[0].error as Error).message).toBe("stack broke");
  });
});
