import { describe, expect, it } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message, Performative } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning.js";
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
 * A plan per goal name, each declaring what it serves but never willing yet.
 *
 * A plan has to declare which goal it does before a directive asking for that
 * goal can be agreed to at all — a request no plan declares is refused, not
 * queued. The trigger returns `false` so the goal is admitted and then simply
 * waits, which is what lets these tests look at the queue: a willing plan
 * would work the goal to completion and collect it inside the same tick.
 */
function plansFor(...goalNames: string[]): Plan[] {
  return goalNames.map((goal) => ({
    name: `do-${goal}`,
    respondTo: goal,
    trigger: () => false,
    body: [],
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

  it("perceives nothing into beliefs when told to ignore them", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], { informs: "ignore" });
    await agent.start();

    await send(bus, "a1", inform("scout", { temperature: 22 }));
    await agent.tick();

    // The message was still received, and still drained — the agent just does
    // not treat being told as believing.
    expect(agent.inbox.size()).toBe(0);
    expect(agent.beliefs.all()).toEqual({});
    await agent.stop();
  });

  it("decides per message when given a predicate", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, [], {
      informs: (msg) => msg.sender === "trusted-scout",
    });
    await agent.start();

    await send(bus, "a1", inform("trusted-scout", { temperature: 22 }));
    await send(bus, "a1", inform("random", { temperature: 99 }));
    await agent.tick();

    expect(agent.beliefs.get("msg.temperature")).toBe(22);
    await agent.stop();
  });

  it("does not let the policy apply to a directive", async () => {
    const bus = new InMemoryMessageBus();
    // The plan is a no-op, so the goal stays in the queue rather than being
    // achieved and collected inside the same tick.
    const agent = createAgent("a1", bus, plansFor("fetchData"), {
      informs: "ignore",
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

    // `declare` asserts something the sender brought about rather than merely
    // claimed, so it is equally a fact to store.
    await send(bus, "a1", inform("registrar", { recorded: true }, "declare"));
    await send(bus, "a1", inform("scout", { price: 10 }, "query-if-known"));
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
    // promise: neither is a fact about the world to believe.
    for (const performative of [
      "failure",
      "refuse",
      "sorry",
      "reject-proposal",
      "promise",
      "commit",
      "accept-proposal",
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

    for (const performative of [
      "invite",
      "invoke",
      "unsubscribe",
    ] as Performative[]) {
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
      plansFor(
        "request-work",
        "delegate-work",
        "request-when-work",
        "request-whenever-work",
        "achieve-work",
      ),
    );
    await agent.start();

    for (const performative of [
      "request",
      "achieve",
      "delegate",
      "request-when",
      "request-whenever",
    ] as Performative[]) {
      await send(bus, "a1", {
        performative,
        sender: "ui",
        content: { goal: `${performative}-work` },
        timestamp: Date.now(),
      });
    }
    await agent.tick();

    expect(
      agent.goals
        .all()
        .map((g) => g.name)
        .sort(),
    ).toEqual([
      "achieve-work",
      "delegate-work",
      "request-when-work",
      "request-whenever-work",
      "request-work",
    ]);
    await agent.stop();
  });

  it("still weighs the legacy `achieve` above `request`", async () => {
    const bus = new InMemoryMessageBus();
    const agent = createAgent("a1", bus, plansFor("ordinary", "pressing"));
    await agent.start();

    await send(bus, "a1", {
      performative: "request",
      sender: "ui",
      content: { goal: "ordinary" },
      timestamp: Date.now(),
    });
    await send(bus, "a1", {
      performative: "achieve",
      sender: "ui",
      content: { goal: "pressing" },
      timestamp: Date.now(),
    });
    await agent.tick();

    expect(agent.goals.getByStatus("active").map((g) => g.name)).toEqual([
      "pressing",
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
    // conversation, not about the world. Believing it would let an
    // acknowledgement trigger a plan.
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
          name: "check",
          respondTo: "check-lead",
          trigger: (beliefs) => beliefs.has("msg.lead"),
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
      { informs: (msg) => msg.sender === "trusted-scout" },
    );
    await agent.start();

    // The trusted scout both asserts the lead and asks for the work. Asserting
    // alone would not do it: an assertion never becomes a goal, so it cannot
    // start anything.
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
    // it a lead. Only the assertion the agent chose to accept drove the plan,
    // and the one it rejected left nothing to trigger on.
    expect(trusted).toHaveLength(1);
    expect(agent.beliefs.get("msg.lead")).toBe("l-42");
    await agent.stop();
  });

  it("starts nothing on an assertion alone", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const agent = createAgent("a1", bus, [
      {
        name: "check",
        respondTo: "check-lead",
        trigger: () => true,
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
