import { describe, expect, it } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message, Performative } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning.js";
import type {
  BeliefAcceptance,
  BeliefRejection,
} from "../src/core/reasoning.js";
import type { BeliefChangeDetail } from "../src/core/beliefs.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { AgentConfig } from "../src/core/reasoning.js";
import type { ActionResult, Plan } from "../src/core/plans.js";

function createAgent(
  id: string,
  bus: InMemoryMessageBus,
  plans: Plan[] = [],
  config: Partial<AgentConfig> = {},
): Agent {
  const lib = new PlanLibrary();
  for (const plan of plans) {
    lib.register(plan);
  }
  return new Agent({ id, bus, planLibrary: lib, ...config });
}

const send = (bus: InMemoryMessageBus, to: string, msg: Message) =>
  bus.send(to, msg);

/**
 * A plan per goal name, each named for the goal it serves and slow enough to
 * inspect.
 *
 * A plan has to serve a directive's goal by name before it is agreed to at
 * all — a request no plan serves is refused, not queued. The two-step body
 * keeps the goal active after a tick, which is what lets these tests look at
 * the queue: a one-step plan would work the goal to completion and collect it
 * inside the same tick.
 */
function plansFor(...goalNames: string[]): Plan[] {
  return goalNames.map((goal) => ({
    name: goal,
    body: [
      { name: "step-1", execute: async (): Promise<ActionResult> => ({}) },
      { name: "step-2", execute: async (): Promise<ActionResult> => ({}) },
    ],
  }));
}

const inform = (
  sender: string,
  content: Record<string, unknown>,
  performative: Performative = "inform",
): Message => ({ performative, sender, content, timestamp: Date.now() });

describe("Perception", () => {
  it("does not turn a delivered message into state until a cycle runs", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));

    // Delivery is not perception. Without the inbox this write would already
    // have happened, on the sender's stack, before the receiver had reasoned
    // about anything.
    expect(agent.inbox.size()).toBe(1);
    expect(agent.beliefs.has("msg.temperature")).toBe(false);

    await agent.tick();
    expect(agent.inbox.size()).toBe(0);
    expect(agent.beliefs.get("msg.temperature")).toBe(22);

    await agent.stop();
  });

  it("reports a message as received even before it is perceived", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const received: Message[] = [];
    agent.on("message:received", (msg) => received.push(msg));
    await agent.start();

    await send(bus, "a1", inform("scout", { x: 1 }));

    // A monitor watches the wire, not the agent's interior, so this still
    // fires at delivery — including for messages nothing will ever believe.
    expect(received).toHaveLength(1);

    await agent.stop();
  });

  it("perceives what arrived on a topic too", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();
    await agent.subscribe("weather");

    await bus.publish("weather", inform("station", { temperature: 30 }));
    await agent.tick();

    expect(agent.beliefs.get("msg.temperature")).toBe(30);
    await agent.stop();
  });

  it("perceives everything that arrived, in arrival order", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    for (const key of ["a", "b", "c"]) {
      await send(bus, "a1", inform("scout", { [key]: key }));
    }
    await agent.tick();

    expect(Object.keys(agent.beliefs.all())).toEqual([
      "msg.a",
      "msg.b",
      "msg.c",
    ]);
    await agent.stop();
  });

  it("keeps a message unperceived when the agent is not ticking", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    for (let i = 0; i < 3; i++) {
      await send(bus, "a1", inform("scout", { i }));
    }

    expect(agent.inbox.size()).toBe(3);
    expect(agent.beliefs.all()).toEqual({});
    await agent.stop();
  });

  it("sheds the oldest message rather than growing without limit", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], { maxInboxSize: 2 });
    await agent.start();

    for (const key of ["old", "mid", "new"]) {
      await send(bus, "a1", inform("scout", { [key]: key }));
    }
    await agent.tick();

    expect(agent.inbox.dropped).toBe(1);
    expect(agent.beliefs.has("msg.old")).toBe(false);
    expect(agent.beliefs.get("msg.mid")).toBe("mid");
    expect(agent.beliefs.get("msg.new")).toBe("new");
    await agent.stop();
  });
});

describe("Informs policy", () => {
  it("accepts assertions into beliefs by default", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(agent.beliefs.get("msg.temperature")).toBe(22);
    await agent.stop();
  });

  it("writes nothing when a middleware declines to continue", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], { middleware: [async () => {}] });
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    // The message was still received, and still drained — the agent just does
    // not treat being told as believing.
    expect(agent.inbox.size()).toBe(0);
    expect(agent.beliefs.all()).toEqual({});
    await agent.stop();
  });

  it("decides per message when given a chain that tests the sender", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      middleware: [
        async (msg, next) => {
          if (msg.sender !== "trusted-scout") {
            return;
          }
          await next();
        },
      ],
    });
    await agent.start();

    await send(bus, "a1", inform("trusted-scout", { temperature: 22 }));
    await send(bus, "a1", inform("random", { temperature: 99 }));
    await agent.tick();

    expect(agent.beliefs.get("msg.temperature")).toBe(22);
    await agent.stop();
  });

  it("does not let the belief chain apply to a directive", async () => {
    const bus = new InMemoryMessageBus();
    // The plan is a no-op, so the goal stays in the queue rather than being
    // achieved and collected inside the same tick.
    const agent = createAgent("a1", bus, plansFor("fetchData"), {
      middleware: [async () => {}],
    });
    await agent.start();

    await send(bus, "a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // A directive is the one performative with a compelled hearer effect: it
    // asks to be performed, so it becomes work rather than a proposition. A
    // policy about what to believe has nothing to say about what to do.
    expect(agent.goals.all()).toHaveLength(1);
    expect(agent.beliefs.all()).toEqual({});
    await agent.stop();
  });

  it("names accepted assertions wherever the policy says", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      beliefKey: (msg, key) => `${msg.sender}.${key}`,
    });
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    // The default loses which agent asserted what, and two agents asserting
    // the same key land on one belief. Qualifying by sender keeps both.
    expect(agent.beliefs.get("scout.temperature")).toBe(22);
    expect(agent.beliefs.has("msg.temperature")).toBe(false);
    await agent.stop();
  });

  it("keeps two senders' assertions apart when qualified by sender", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      beliefKey: (msg, key) => `${msg.sender}.${key}`,
    });
    await agent.start();

    await send(bus, "a1", inform("scout-1", { temperature: 22 }));
    await send(bus, "a1", inform("scout-2", { temperature: 31 }));
    await agent.tick();

    expect(agent.beliefs.get("scout-1.temperature")).toBe(22);
    expect(agent.beliefs.get("scout-2.temperature")).toBe(31);
    await agent.stop();
  });
});

describe("Perception by performative class", () => {
  it("accepts every propositional performative, not just `inform`", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    // `inform-if` asserts a conditional and `inform-ref` reports a referent;
    // both are assertives, so their content is offered to the belief base on
    // exactly `inform`'s terms.
    await send(bus, "a1", inform("registrar", { recorded: true }, "inform-if"));
    await send(bus, "a1", inform("scout", { price: 10 }, "inform-ref"));
    await send(bus, "a1", inform("scout", { detail: "x" }, "failure"));
    await send(bus, "a1", inform("scout", { detail: "x" }, "not-understood"));
    await agent.tick();

    expect(agent.beliefs.get("msg.recorded")).toBe(true);
    expect(agent.beliefs.get("msg.price")).toBe(10);
    await agent.stop();
  });

  it("stores nothing for a performative that is about the conversation", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    // An expressive reports the speaker's state and a commissive is a
    // promise: neither is a fact about the world to believe. `failure` and
    // `not-understood` are both assertive as well, so they do produce beliefs.
    for (const performative of [
      "refuse",
      "reject-proposal",
      "accept-proposal",
      "propose",
    ] as Performative[]) {
      await send(bus, "a1", inform("other", { detail: "x" }, performative));
    }
    await agent.tick();

    expect(agent.beliefs.all()).toEqual({});
    expect(agent.inbox.size()).toBe(0);
    await agent.stop();
  });

  it("stores nothing for a performative the specification leaves unclassified", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    for (const performative of ["propagate", "proxy"] as Performative[]) {
      await send(bus, "a1", inform("other", { detail: "x" }, performative));
    }
    await agent.tick();

    expect(agent.beliefs.all()).toEqual({});
    await agent.stop();
  });

  it("does not turn `subscribe` into work", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    // `subscribe` asks the receiver to monitor a proposition, not to perform
    // an action. It is a directive in FIPA-ACL's taxonomy, and still none of
    // the receiver's business to become a goal.
    await send(bus, "a1", {
      performative: "subscribe",
      sender: "user-proxy",
      content: { proposition: "brief(brief-3) is current" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.goals.all()).toEqual([]);
    expect(agent.beliefs.get("msg.proposition")).toBe(
      "brief(brief-3) is current",
    );
    await agent.stop();
  });

  it("creates a goal for each performative that directs action", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent(
      "a1",
      bus,
      plansFor("request-work", "query-if-work", "query-ref-work"),
    );
    await agent.start();

    await send(bus, "a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "request-work" },
      timestamp: Date.now(),
    });
    // A query carries a goal name like any request, plus what is asked.
    await send(bus, "a1", {
      performative: "query-if",
      sender: "ui",
      content: { goal: "query-if-work", key: "temp", proposition: 22 },
      timestamp: Date.now(),
    });
    await send(bus, "a1", {
      performative: "query-ref",
      sender: "ui",
      content: { goal: "query-ref-work", key: "temp", expression: "temp" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(
      agent.goals
        .all()
        .map((g) => g.name)
        .sort(),
    ).toEqual(["query-if-work", "query-ref-work", "request-work"]);
    await agent.stop();
  });

  it("weighs a query's goal like a request's, since neither is more urgent", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, plansFor("ordinary", "asking"));
    await agent.start();

    await send(bus, "a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "ordinary" },
      timestamp: Date.now(),
    });
    await send(bus, "a1", {
      performative: "query-if",
      sender: "ui",
      content: { goal: "asking", key: "temp", proposition: 22 },
      timestamp: Date.now(),
    });
    await agent.tick();

    // Same priority, so the first request admitted keeps the single slot the
    // queue's bound allows, and the query waits its turn.
    expect(agent.goals.getByStatus("active").map((g) => g.name)).toEqual([
      "ordinary",
    ]);
    await agent.stop();
  });

  it("keeps a directive's agreement out of the belief base, but believes a plain confirm", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const acks: string[] = [];
    agent.on("goalAcknowledged", (ack) => acks.push(ack.goalId));
    await agent.start();

    await send(bus, "a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    await send(bus, "a1", {
      performative: "agree",
      sender: "worker",
      content: { goal: "fetchData", goalId: "goal-1" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // `agree` is class-assertive, so on class alone it would be propositional
    // and believed like any other assertion. It is bookkeeping: a fact about a
    // conversation, not about the world. Believing it would put protocol
    // traffic into the belief base, where only world state belongs.
    expect(acks).toEqual(["goal-1"]);
    expect(agent.beliefs.all()).toEqual({});

    await send(bus, "a1", {
      performative: "confirm",
      sender: "worker",
      content: { done: true },
      timestamp: Date.now(),
    });
    await agent.tick();

    // A `confirm` that is not an answer to a directive is an ordinary
    // assertion about the world, and is believed as one. Reserving the
    // performative for acknowledgements would have silently swallowed these.
    expect(agent.beliefs.all()).toEqual({ "msg.done": true });
    await agent.stop();
  });
});

describe("An agent that does not believe what it is told", () => {
  it("acts on an assertion it accepted and ignores one it did not", async () => {
    const bus = new InMemoryMessageBus();
    const trusted: ActionResult[] = [];
    const agent = createAgent(
      "qualifier",
      bus,
      [
        {
          name: "check-lead",
          body: [
            {
              name: "record",
              execute: async (): Promise<ActionResult> => {
                trusted.push({});
                return {};
              },
            },
          ],
        },
      ],
      {
        middleware: [
          async (msg, next) => {
            if (msg.sender !== "trusted-scout") {
              return;
            }
            await next();
          },
        ],
      },
    );
    await agent.start();

    // The trusted scout both asserts the lead and asks for the work. The
    // request is what starts it; the assertion is what makes the lead
    // available, and only from a sender the middleware trusts.
    await send(bus, "qualifier", inform("trusted-scout", { lead: "l-42" }));
    await send(bus, "qualifier", {
      performative: "request",
      sender: "trusted-scout",
      content: { goal: "check-lead" },
      timestamp: Date.now(),
    });
    await send(bus, "qualifier", inform("random", { lead: "l-99" }));
    await agent.tick();
    await agent.tick();

    // The FIPA point in miniature: a generator asserting a lead does not make
    // it a lead, so the belief base holds only the accepted one.
    expect(trusted).toHaveLength(1);
    expect(agent.beliefs.get("msg.lead")).toBe("l-42");
    await agent.stop();
  });

  it("starts nothing on an assertion alone", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const agent = createAgent("a1", bus, [
      {
        name: "check-lead",
        body: [
          {
            name: "record",
            execute: async (): Promise<ActionResult> => {
              ran.push("check");
              return {};
            },
          },
        ],
      },
    ]);
    await agent.start();

    await send(bus, "a1", inform("scout", { lead: "l-42" }));
    await agent.tick();
    await agent.tick();

    // Work happens because a goal says it should. A plan declaring it could do
    // the job is a claim about capability, not a reason to start doing it.
    expect(ran).toEqual([]);
    expect(agent.goals.all()).toEqual([]);
    await agent.stop();
  });
});

describe("Belief middleware", () => {
  it("believes by default, with no middleware configured", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    // The trust assumption, restated as a test: nothing is intercepting, so an
    // assertion from a peer is believed.
    expect(agent.beliefs.get("msg.temperature")).toBe(22);
    await agent.stop();
  });

  it("cancels the write when a middleware does not call next", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      middleware: [(_msg, _next) => {}],
    });
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(agent.beliefs.all()).toEqual({});
    // Still drained: cancelled, not left to pile up in the inbox.
    expect(agent.inbox.size()).toBe(0);
    await agent.stop();
  });

  it("runs middleware in order and stops at the first to cancel", async () => {
    const bus = new InMemoryMessageBus();
    const seen: string[] = [];
    const agent = createAgent("a1", bus, [], {
      middleware: [
        async (_msg, next) => {
          seen.push("first");
          await next();
        },
        (_msg, _next) => {
          seen.push("second");
          // cancels here
        },
        async (_msg, next) => {
          seen.push("third");
          await next();
        },
      ],
    });
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(agent.beliefs.all()).toEqual({});
    expect(seen).toEqual(["first", "second"]);
    await agent.stop();
  });

  it("sees the whole message, not one belief key at a time", async () => {
    const bus = new InMemoryMessageBus();
    let observed: unknown;
    const agent = createAgent("a1", bus, [], {
      middleware: [
        async (msg, next) => {
          observed = msg.content;
          await next();
        },
      ],
    });
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22, humidity: 40 }));
    await agent.tick();

    expect(observed).toEqual({ temp: 22, humidity: 40 });
    expect(agent.beliefs.all()).toEqual({
      "msg.temp": 22,
      "msg.humidity": 40,
    });
    await agent.stop();
  });

  it("cancels the write when a middleware throws, and does not end the tick", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      middleware: [
        () => {
          throw new Error("acl unavailable");
        },
      ],
    });
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(agent.beliefs.all()).toEqual({});
    expect(agent.inbox.size()).toBe(0);
    await agent.stop();
  });

  it("awaits an async middleware before writing", async () => {
    const bus = new InMemoryMessageBus();
    const order: string[] = [];
    const agent = createAgent("a1", bus, [], {
      middleware: [
        async (_msg, next) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push("checked");
          await next();
        },
      ],
    });
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(order).toEqual(["checked"]);
    expect(agent.beliefs.get("msg.temperature")).toBe(22);
    await agent.stop();
  });

  it("does not guard goal creation from directives", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, plansFor("fetchData"), {
      middleware: [(_msg, _next) => {}],
    });
    await agent.start();

    await send(bus, "a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // A request is a different primitive. Withdrawing trust in a peer's claims
    // says nothing about whether its asks are still work, so the goal stands —
    // `middleware` guards beliefs, `directiveMiddleware` guards goals.
    expect(agent.goals.all()).toHaveLength(1);
    await agent.stop();
  });

  it("reports a write cancelled by middleware", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      middleware: [(_msg, _next) => {}],
    });
    const rejected: BeliefRejection[] = [];
    agent.on("belief:rejected", (r) => rejected.push(r));
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(rejected).toHaveLength(1);
    expect(rejected[0].agentId).toBe("a1");
    expect(rejected[0].reason).toBe("middleware");
    expect(rejected[0].message.sender).toBe("scout");
    await agent.stop();
  });

  it("reports a middleware that threw, and names what it said", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      middleware: [
        () => {
          throw new Error("acl unavailable");
        },
      ],
    });
    const rejected: BeliefRejection[] = [];
    agent.on("belief:rejected", (r) => rejected.push(r));
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(rejected[0].reason).toBe("middleware threw: acl unavailable");
    await agent.stop();
  });

  it("says nothing when the write happened", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const rejected: BeliefRejection[] = [];
    agent.on("belief:rejected", (r) => rejected.push(r));
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(rejected).toEqual([]);
    await agent.stop();
  });

  it("carries the message, so a monitor can see what was dropped", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      middleware: [(_msg, _next) => {}],
    });
    const rejected: BeliefRejection[] = [];
    agent.on("belief:rejected", (r) => rejected.push(r));
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    expect(rejected[0].message.content).toEqual({ temperature: 22 });
    await agent.stop();
  });

  it("puts nothing on the wire, so no agent can receive it as a claim", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      middleware: [(_msg, _next) => {}],
    });
    let sawMessage = 0;
    agent.on("message:sent", () => sawMessage++);
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    // Nothing went out on the wire: this is reported in-process only, which is
    // why no agent could ever receive it as something it was told.
    expect(sawMessage).toBe(0);
    expect(agent.beliefs.all()).toEqual({});
    await agent.stop();
  });
});

describe("belief:accepted", () => {
  it("reports the keys an assertion was stored under", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const accepted: BeliefAcceptance[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22, humidity: 40 }));
    await agent.tick();

    expect(accepted).toHaveLength(1);
    expect(accepted[0].agentId).toBe("a1");
    expect(accepted[0].keys).toEqual(["msg.temp", "msg.humidity"]);
    expect(accepted[0].message.sender).toBe("scout");
    await agent.stop();
  });

  it("reports the names a custom beliefKey produced, not the content's", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      beliefKey: (msg, key) => `${key}@${msg.sender}`,
    });
    const accepted: BeliefAcceptance[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }));
    await agent.tick();

    expect(accepted[0].keys).toEqual(["temp@scout"]);
    await agent.stop();
  });

  it("is the counterpart of belief:rejected: exactly one of the two fires", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const accepted: BeliefAcceptance[] = [];
    const rejected: BeliefRejection[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    agent.on("belief:rejected", (r) => rejected.push(r));
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }));
    await agent.tick();

    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual([]);
    await agent.stop();
  });

  it("does not fire when middleware cancelled the write", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      middleware: [(_msg, _next) => {}],
    });
    const accepted: BeliefAcceptance[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }));
    await agent.tick();

    expect(accepted).toEqual([]);
    await agent.stop();
  });

  it("fires with no keys for an empty assertion, which was still believed", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const accepted: BeliefAcceptance[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    await agent.start();

    await send(bus, "a1", inform("scout", {}));
    await agent.tick();

    expect(accepted).toHaveLength(1);
    expect(accepted[0].keys).toEqual([]);
    await agent.stop();
  });

  it("stays silent for content that asserts nothing at all", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const accepted: BeliefAcceptance[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    await agent.start();

    await send(bus, "a1", {
      performative: "inform",
      sender: "scout",
      content: "not a proposition",
      timestamp: Date.now(),
    });
    await agent.tick();

    // A string is not a rejected assertion; it is not an assertion. Reporting
    // it as accepted would claim a belief was formed when nothing was stored.
    expect(accepted).toEqual([]);
    await agent.stop();
  });

  it("does not fire for a directive, which became a goal instead", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, plansFor("fetchData"));
    const accepted: BeliefAcceptance[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    await agent.start();

    await send(bus, "a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "fetchData" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(accepted).toEqual([]);
    await agent.stop();
  });

  it("does not fire for belief writes an action made", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [
      {
        name: "note",
        body: [
          {
            name: "write",
            execute: async (): Promise<ActionResult> => ({
              beliefUpdates: [{ key: "noted", value: true }],
            }),
          },
        ],
      },
    ]);
    const accepted: BeliefAcceptance[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    await agent.start();

    await send(bus, "a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "note" },
      timestamp: Date.now(),
    });
    await agent.tick();

    // The agent concluded this for itself. It was not told, so there is no
    // message to report an acceptance of.
    expect(agent.beliefs.get("noted")).toBe(true);
    expect(accepted).toEqual([]);
    await agent.stop();
  });
});

describe("confirm", () => {
  it("is believed exactly as inform is", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }, "confirm"));
    await agent.tick();

    // SC00037 gives confirm and inform the same rational effect, Bj φ. The only
    // difference is a sender-side precondition, which the receiver cannot
    // check, so the two are the same act from here.
    expect(agent.beliefs.get("msg.temp")).toBe(22);
    await agent.stop();
  });

  it("goes through the same trust path", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], { middleware: [async () => {}] });
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }, "confirm"));
    await agent.tick();

    expect(agent.beliefs.all()).toEqual({});
    await agent.stop();
  });

  it("can be cancelled by middleware, which can tell it from an inform", async () => {
    const bus = new InMemoryMessageBus();
    const seen: string[] = [];
    const agent = createAgent("a1", bus, [], {
      middleware: [
        (msg, next) => {
          seen.push(msg.performative);
          if (msg.performative === "confirm") return;
          next();
        },
      ],
    });
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 1 }, "inform"));
    await send(bus, "a1", inform("scout", { temp: 2 }, "confirm"));
    await agent.tick();

    expect(seen).toEqual(["inform", "confirm"]);
    expect(agent.beliefs.get("msg.temp")).toBe(1);
    await agent.stop();
  });
});

describe("disconfirm", () => {
  it("holds the content negatively rather than believing it", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }, "disconfirm"));
    await agent.tick();

    // SC00037: Bj ¬φ. The key stays present and the sender's stance toward it
    // is recorded as negative — not absent, and certainly not held positively,
    // which is what this used to do.
    expect(agent.beliefs.has("msg.temp")).toBe(true);
    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("negative");
    await agent.stop();
  });

  it("flips an existing stance without discarding the value", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }));
    await agent.tick();
    expect(agent.beliefs.statusOf("msg.temp")).toBe("positive");

    await send(bus, "a1", inform("scout", { temp: 22 }, "disconfirm"));
    await agent.tick();

    expect(agent.beliefs.get("msg.temp")).toBe(22);
    expect(agent.beliefs.statusOf("msg.temp")).toBe("negative");
    await agent.stop();
  });

  it("reports the polarity it wrote", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const accepted: BeliefAcceptance[] = [];
    agent.on("belief:accepted", (a) => accepted.push(a));
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }, "disconfirm"));
    await agent.tick();

    expect(accepted).toHaveLength(1);
    expect(accepted[0].status).toBe("negative");
    await agent.stop();
  });

  it("is believed again by a later inform", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }, "disconfirm"));
    await agent.tick();
    expect(agent.beliefs.statusOf("msg.temp")).toBe("negative");

    await send(bus, "a1", inform("scout", { temp: 22 }));
    await agent.tick();

    // Keys are value-independent and last write wins, so a fresh assertion
    // replaces the standing one.
    expect(agent.beliefs.statusOf("msg.temp")).toBe("positive");
    await agent.stop();
  });

  it("gates a disconfirm too, since refusing to believe is still a gate", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], { middleware: [async () => {}] });
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }, "disconfirm"));
    await agent.tick();

    // The chain gates the polarity as well: a claim about what is negative is
    // still a claim, and is still stopped by not calling `next`.
    expect(agent.beliefs.all()).toEqual({});
    await agent.stop();
  });

  it("emits a change event for a pure polarity flip", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    const changes: BeliefChangeDetail[] = [];
    agent.beliefs.on("beliefUpdated", (d) => changes.push(d));
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }));
    await agent.tick();
    await send(bus, "a1", inform("scout", { temp: 22 }, "disconfirm"));
    await agent.tick();

    // The value did not move, but what the agent holds about it did, so the
    // change is still reported.
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe("negative");
    expect(changes[0].previousStatus).toBe("positive");
    await agent.stop();
  });

  it("is drained rather than left in the inbox", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus);
    await agent.start();

    await send(bus, "a1", inform("scout", { temp: 22 }, "disconfirm"));
    await agent.tick();

    expect(agent.inbox.size()).toBe(0);
    await agent.stop();
  });
});
