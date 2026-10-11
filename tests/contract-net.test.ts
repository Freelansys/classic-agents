import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import { ExpressionLibrary } from "../src/core/expressions.js";
import type {
  CallClosed,
  CallOpened,
  CallProposalReceived,
  IntentionFailed,
} from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { Action, ActionResult, Plan } from "../src/core/plans.js";
import type { Intention } from "../src/core/intentions.js";

/** An agent serving the given plans, with any extra config. */
function agent(
  bus: InMemoryMessageBus,
  id: string,
  plans: Plan[],
  extra: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library, ...extra });
}

/** A no-op action, so the goal it is in takes one more cycle. */
function noop(name = "noop"): Action {
  return { name, execute: async (): Promise<ActionResult> => ({}) };
}

/** `steps` no-op actions, for a plan body that must outlive a call. */
function noopActions(name: string, steps: number): Action[] {
  return Array.from({ length: steps }, (_, i) => noop(`${name}-${i}`));
}

/** A plan of `steps` no-op actions, so a goal takes that many cycles. */
function worker(name: string, steps = 1): Plan {
  return {
    name,
    body: Array.from({ length: steps }, (_, i) => noop(`${name}-${i}`)),
  };
}

/** An expression library answering a bid with a fixed `{ price }`, or `null`. */
function quoting(price: number | null): ExpressionLibrary {
  const expressions = new ExpressionLibrary();
  expressions.register({ name: "quote", evaluate: () => (price === null ? null : { price }) });
  return expressions;
}

/** A participant serving `goal`, bidding `price`, doing `steps` of work if it wins. */
function bidder(
  bus: InMemoryMessageBus,
  id: string,
  goal: string,
  price: number,
  steps = 1,
): Agent {
  return agent(
    bus,
    id,
    [{ name: goal, bid: "quote", body: worker(`${goal}-work`, steps).body }],
    { expressionLibrary: quoting(price) },
  );
}

/** A participant that serves `goal` but declines every call — no bid. */
function decliner(bus: InMemoryMessageBus, id: string, goal: string): Agent {
  return agent(bus, id, [{ name: goal, bid: "quote", body: worker(goal).body }], {
    expressionLibrary: quoting(null),
  });
}

/** A plain bus client at `ui`, and a way to send `boss` a request from it. */
function requester(bus: InMemoryMessageBus) {
  const inbox: Message[] = [];
  bus.registerAgent("ui", (m) => inbox.push(m));
  return {
    inbox,
    request(goal: string): Promise<void> {
      return bus.send("boss", {
        performative: "request",
        sender: "ui",
        receiver: "boss",
        content: { goal },
        conversationId: "conv-ui",
        replyWith: "req-ui",
        timestamp: Date.now(),
      });
    },
    performatives(): string[] {
      return inbox.map((m) => m.performative);
    },
  };
}

/** Ticks every agent, in turn, `cycles` times. */
async function run(agents: Agent[], cycles = 25): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

/** The action that opens a call for `goal` among the given receivers. */
function calling(goal: string, receivers: string[]): Action {
  return {
    name: "call",
    execute: async (): Promise<ActionResult> => ({
      calls: [{ goal, receivers }],
    }),
  };
}

/** An action that awards the cheapest offered proposal of the intention's calls. */
function awardingToCheapest(): Action {
  return {
    name: "award",
    execute: async (intention: Intention): Promise<ActionResult> => {
      const proposals = intention.calls.flatMap((call) => call.proposals);
      if (proposals.length === 0) {
        return { failure: { reason: "no bids" } };
      }
      const best = proposals
        .slice()
        .sort(
          (a, b) =>
            (a.terms as { price: number }).price -
            (b.terms as { price: number }).price,
        )[0];
      return { awards: [{ proposal: best.id }] };
    },
  };
}

describe("Contract Net — calling for proposals", () => {
  it("invites every bidder, awards the cheapest, and rejects the rest", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [calling("dig", ["b1", "b2"]), awardingToCheapest(), noop("done")],
      },
    ]);
    const b2 = bidder(bus, "b2", "dig", 10);
    const b1 = bidder(bus, "b1", "dig", 30);
    const ui = requester(bus);

    const opened: CallOpened[] = [];
    const proposed: CallProposalReceived[] = [];
    const closed: CallClosed[] = [];
    const completed: string[] = [];
    boss.on("call:opened", (e) => opened.push(e));
    boss.on("call:proposal", (e) => proposed.push(e));
    boss.on("call:closed", (e) => closed.push(e));
    boss.on("intention:completed", (i) => completed.push(i.goal.name));

    const toB1: Message[] = [];
    const toB2: Message[] = [];
    boss.on("message:sent", (m) => {
      if (m.receiver === "b1") toB1.push(m);
      if (m.receiver === "b2") toB2.push(m);
    });
    const accepted: string[] = [];
    b2.on("proposal:accepted", () => accepted.push("b2"));

    await boss.start();
    await b1.start();
    await b2.start();

    await ui.request("pave");
    await run([boss, b1, b2]);

    // One cfp per invitee, each its own exchange naming the goal, sharing the
    // request's conversation.
    expect(toB1.filter((m) => m.performative === "cfp")).toHaveLength(1);
    expect(toB2.filter((m) => m.performative === "cfp")).toHaveLength(1);
    expect(toB1[0].content).toEqual({ goal: "dig" });
    expect(toB1[0].conversationId).toBe("conv-ui");

    // Both bidders proposed; the call collected both and then closed.
    expect(proposed).toHaveLength(2);
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0].call.proposals.map((p) => p.sender).sort()).toEqual([
      "b1",
      "b2",
    ]);

    // The cheapest won: an accept for b2, a reject for b1.
    const award = toB2.find((m) => m.performative === "accept-proposal");
    expect(award?.content).toMatchObject({ goal: "dig", terms: { price: 10 } });
    expect(accepted).toEqual(["b2"]);
    const rejection = toB1.find((m) => m.performative === "reject-proposal");
    expect(rejection?.content).toMatchObject({ goal: "dig" });

    // The winner did the work, and its result resumed the caller to completion.
    expect(completed).toEqual(["pave"]);
    expect(ui.performatives()).toEqual(["agree", "inform"]);
    expect(ui.inbox[1].content).toMatchObject({ done: true });
  });

  it("fails the call when no one bids", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [calling("dig", ["b1"]), awardingToCheapest(), noop("done")],
      },
    ]);
    const b1 = decliner(bus, "b1", "dig");
    const ui = requester(bus);
    const failures: IntentionFailed[] = [];
    boss.on("intention:failed", (e) => failures.push(e));

    await boss.start();
    await b1.start();

    await ui.request("pave");
    await run([boss, b1]);

    // The single invitee refused, so the call had no bids to award.
    expect(failures).toHaveLength(1);
    expect(ui.performatives()).toEqual(["agree", "failure"]);
    expect(ui.inbox[1].content).toMatchObject({ reason: "no bids" });
  });

  it("answers an unsolicited propose rather than swallowing it", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [worker("pave")]);
    const inbox: Message[] = [];
    bus.registerAgent("ui", (m) => inbox.push(m));
    await boss.start();

    await bus.send("boss", {
      performative: "propose",
      sender: "ui",
      receiver: "boss",
      content: { goal: "dig", terms: { price: 5 } },
      timestamp: Date.now(),
    });
    await boss.tick();

    const rejection = inbox.find((m) => m.performative === "reject-proposal");
    expect(rejection?.content).toMatchObject({ reason: "no call open" });
  });

  it("turns away a bid naming a call that has already closed", async () => {
    const bus = new InMemoryMessageBus();
    // The body keeps the intention alive after the call closes, so the late
    // bid still finds the call — and is told it is closed, not that none ran.
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [calling("dig", ["b1"]), ...noopActions("hold", 30)],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    let cfpExchange: string | undefined;
    const closed: CallClosed[] = [];
    boss.on("message:sent", (m) => {
      if (m.performative === "cfp") cfpExchange = m.replyWith;
    });
    boss.on("call:closed", (e) => closed.push(e));

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, b1], 6);

    expect(closed).toHaveLength(1);
    expect(cfpExchange).toBeDefined();

    const inbox: Message[] = [];
    bus.registerAgent("late", (m) => inbox.push(m));
    await bus.send("boss", {
      performative: "propose",
      sender: "late",
      receiver: "boss",
      content: { goal: "dig", terms: { price: 5 } },
      inReplyTo: cfpExchange,
      timestamp: Date.now(),
    });
    await boss.tick();

    const rejection = inbox.find((m) => m.performative === "reject-proposal");
    expect(rejection?.content).toMatchObject({ reason: "call closed" });
  });
});
