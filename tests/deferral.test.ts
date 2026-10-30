import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  AgentConfig,
  DeferredDirective,
  DirectiveMiddleware,
  DirectiveWithdrawn,
  GoalRefusal,
} from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { Plan } from "../src/core/plans.js";
import { ExpressionLibrary } from "../src/core/expressions.js";

/** Ticks the agent `cycles` times. */
async function run(a: Agent, cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i++) await a.tick();
}

const done: Plan = {
  goal: "book-demo",
  body: [{ name: "book", execute: async () => ({ result: { booked: true } }) }],
};

/** Defers every directive: the person decides. */
const toPerson: DirectiveMiddleware = async (_req, res) => {
  res.defer();
};

/**
 * A `proxy` agent serving `plans` behind `middleware`, a `ui` inbox, and what
 * the proxy reported about deferred directives.
 */
async function setup(
  middleware: DirectiveMiddleware[],
  plans: Plan[] = [done],
  config: Partial<AgentConfig> = {},
) {
  const bus = new InMemoryMessageBus();
  const inbox: Message[] = [];
  bus.registerAgent("ui", (m) => inbox.push(m));
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  const proxy = new Agent({
    id: "proxy",
    bus,
    planLibrary: library,
    directiveMiddleware: middleware,
    ...config,
  });
  const deferred: DeferredDirective[] = [];
  const withdrawn: DirectiveWithdrawn[] = [];
  const expired: Message[] = [];
  const refused: GoalRefusal[] = [];
  proxy.on("directive:deferred", (d) => deferred.push(d));
  proxy.on("directive:withdrawn", (w) => withdrawn.push(w));
  proxy.on("directive:expired", (m) => expired.push(m));
  proxy.on("goal:refused", (r) => refused.push(r));
  await proxy.start();

  const send = (extra: Partial<Message>) =>
    bus.send("proxy", {
      performative: "request",
      sender: "ui",
      receiver: "proxy",
      content: { goal: "book-demo" },
      conversationId: "conv-ui",
      replyWith: "req-ui",
      timestamp: Date.now(),
      ...extra,
    });

  return {
    bus,
    proxy,
    inbox,
    deferred,
    withdrawn,
    expired,
    refused,
    send,
    performatives: () => inbox.map((m) => m.performative),
  };
}

describe("Deferring a directive", () => {
  it("holds it unanswered, then agrees and works it on admit", async () => {
    const t = await setup([toPerson]);
    await t.send({});
    await run(t.proxy);

    // Held: no agree, no refuse, no goal.
    expect(t.inbox).toEqual([]);
    expect(t.proxy.goals.all()).toEqual([]);
    expect(t.deferred).toHaveLength(1);
    expect(t.deferred[0].agentId).toBe("proxy");
    expect(t.deferred[0].message.replyWith).toBe("req-ui");

    expect(await t.proxy.admit(t.deferred[0].id)).toBe(true);
    await run(t.proxy);

    // An ordinary request from here: agreed, worked, and answered.
    expect(t.performatives()).toEqual(["agree", "inform"]);
    expect(t.inbox.every((m) => m.inReplyTo === "req-ui")).toBe(true);
    expect(t.inbox[1].content).toMatchObject({ done: true });
  });

  it("refuses it on decline, with the reason given", async () => {
    const t = await setup([toPerson]);
    await t.send({});
    await run(t.proxy);

    expect(t.proxy.decline(t.deferred[0].id, "busy", { until: "monday" })).toBe(
      true,
    );
    await run(t.proxy);

    expect(t.performatives()).toEqual(["refuse"]);
    expect(t.inbox[0].content).toMatchObject({
      goal: "book-demo",
      reason: "busy",
      details: { until: "monday" },
    });
    expect(t.refused).toHaveLength(1);
    expect(t.refused[0].verdict).toBe("middleware");
    expect(t.proxy.goals.all()).toEqual([]);
  });

  it("answers an id it does not hold with false, and sends nothing", async () => {
    const t = await setup([toPerson]);
    await t.send({});
    await run(t.proxy);
    const { id } = t.deferred[0];

    expect(await t.proxy.admit("no-such-id")).toBe(false);
    expect(t.proxy.decline("no-such-id")).toBe(false);

    // Decided once: a second decision finds nothing.
    expect(await t.proxy.admit(id)).toBe(true);
    expect(await t.proxy.admit(id)).toBe(false);
    expect(t.proxy.decline(id)).toBe(false);
    await run(t.proxy);
    expect(t.performatives()).toEqual(["agree", "inform"]);
  });

  it("resumes the chain after the middleware that deferred", async () => {
    const seen: string[] = [];
    const t = await setup([
      async (_req, _res, next) => {
        seen.push("first");
        await next();
      },
      async (_req, res) => {
        seen.push("deferring");
        res.defer();
      },
      async (_req, _res, next) => {
        seen.push("after");
        await next();
      },
    ]);
    await t.send({});
    await run(t.proxy);
    expect(seen).toEqual(["first", "deferring"]);

    await t.proxy.admit(t.deferred[0].id);
    expect(seen).toEqual(["first", "deferring", "after"]);
    await run(t.proxy);
    expect(t.performatives()).toEqual(["agree", "inform"]);
  });

  it("lets a later middleware refuse what was admitted", async () => {
    const t = await setup([
      toPerson,
      async (_req, res) => {
        res.refuse("middleware", "the calendar is full");
      },
    ]);
    await t.send({});
    await run(t.proxy);
    await t.proxy.admit(t.deferred[0].id);
    await run(t.proxy);

    expect(t.performatives()).toEqual(["refuse"]);
    expect(t.inbox[0].content).toMatchObject({
      reason: "the calendar is full",
    });
  });

  it("keeps the id when the rest of the chain defers it again", async () => {
    let passes = 0;
    const t = await setup([
      toPerson,
      async (_req, res, next) => {
        if (passes++ === 0) {
          res.defer();
          return;
        }
        await next();
      },
    ]);
    await t.send({});
    await run(t.proxy);
    const { id } = t.deferred[0];

    expect(await t.proxy.admit(id)).toBe(true);
    expect(t.deferred.map((d) => d.id)).toEqual([id, id]);
    await run(t.proxy);
    expect(t.inbox).toEqual([]);

    expect(await t.proxy.admit(id)).toBe(true);
    await run(t.proxy);
    expect(t.performatives()).toEqual(["agree", "inform"]);
  });

  it("lets refuse outrank defer", async () => {
    const t = await setup([
      async (_req, res, next) => {
        res.refuse("middleware", "no");
        res.defer();
        await next();
      },
    ]);
    await t.send({});
    await run(t.proxy);

    expect(t.deferred).toEqual([]);
    expect(t.performatives()).toEqual(["refuse"]);
  });

  it("holds it when the deferring middleware still calls next", async () => {
    const seen: string[] = [];
    const t = await setup([
      async (_req, res, next) => {
        res.defer();
        await next();
      },
      async (_req, _res, next) => {
        seen.push("after");
        await next();
      },
    ]);
    await t.send({});
    await run(t.proxy);

    // The rest of the chain ran, but the decision was left for later.
    expect(seen).toEqual(["after"]);
    expect(t.inbox).toEqual([]);

    await t.proxy.admit(t.deferred[0].id);
    // Admission goes straight to the decision: the chain already ran.
    expect(seen).toEqual(["after"]);
    await run(t.proxy);
    expect(t.performatives()).toEqual(["agree", "inform"]);
  });

  it("drops it once its reply-by passes", async () => {
    const t = await setup([toPerson]);
    await t.send({ replyBy: new Date(Date.now() + 40).toISOString() });
    await run(t.proxy);
    const { id } = t.deferred[0];

    await new Promise((resolve) => setTimeout(resolve, 60));
    await t.proxy.tick();

    expect(t.expired).toHaveLength(1);
    expect(t.withdrawn).toEqual([
      expect.objectContaining({ id, by: "reply-by" }),
    ]);
    expect(await t.proxy.admit(id)).toBe(false);
    await run(t.proxy);
    // Its sender has closed the exchange: nothing goes back.
    expect(t.inbox).toEqual([]);
  });

  it("will not admit or decline it after its reply-by, even before a tick", async () => {
    const t = await setup([toPerson]);
    await t.send({ replyBy: new Date(Date.now() + 40).toISOString() });
    await run(t.proxy);
    const [first] = t.deferred;

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await t.proxy.admit(first.id)).toBe(false);
    expect(t.expired).toHaveLength(1);
    expect(t.withdrawn).toEqual([
      expect.objectContaining({ id: first.id, by: "reply-by" }),
    ]);

    await t.send({
      replyWith: "req-2",
      replyBy: new Date(Date.now() + 40).toISOString(),
    });
    await run(t.proxy);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.proxy.decline(t.deferred[1].id, "too late")).toBe(false);
    await run(t.proxy);
    expect(t.inbox).toEqual([]);
  });

  it("withdraws it at its sender's cancel, and answers the cancel", async () => {
    const t = await setup([toPerson]);
    await t.send({});
    await run(t.proxy);
    const { id } = t.deferred[0];

    await t.send({
      performative: "cancel",
      content: {},
      replyWith: "cancel-ui",
      inReplyTo: "req-ui",
    });
    await run(t.proxy);

    expect(t.performatives()).toEqual(["inform"]);
    expect(t.inbox[0].content).toEqual({
      cancelled: "request",
      goal: "book-demo",
    });
    expect(t.inbox[0].inReplyTo).toBe("cancel-ui");
    expect(t.withdrawn).toEqual([
      expect.objectContaining({ id, by: "cancel" }),
    ]);
    expect(await t.proxy.admit(id)).toBe(false);
  });

  it("does not let another agent cancel it", async () => {
    const t = await setup([toPerson]);
    const other: Message[] = [];
    t.bus.registerAgent("other", (m) => other.push(m));
    await t.send({});
    await run(t.proxy);

    await t.send({
      performative: "cancel",
      sender: "other",
      content: {},
      replyWith: "cancel-other",
      inReplyTo: "req-ui",
    });
    await run(t.proxy);

    expect(other.map((m) => m.performative)).toEqual(["failure"]);
    expect(t.withdrawn).toEqual([]);
    expect(await t.proxy.admit(t.deferred[0].id)).toBe(true);
  });

  it("defers a cfp: the bid goes out on admit", async () => {
    const expressions = new ExpressionLibrary();
    expressions.register({ name: "quote", evaluate: () => ({ price: 40 }) });
    const t = await setup([toPerson], [{ ...done, bid: "quote" }], {
      expressionLibrary: expressions,
    });
    await t.send({ performative: "cfp", replyWith: "cfp-1" });
    await run(t.proxy);
    expect(t.inbox).toEqual([]);

    await t.proxy.admit(t.deferred[0].id);
    await run(t.proxy);

    expect(t.performatives()).toEqual(["propose"]);
    expect(t.inbox[0].content).toEqual({
      goal: "book-demo",
      terms: { price: 40 },
    });
    expect(t.inbox[0].inReplyTo).toBe("cfp-1");
  });
});
