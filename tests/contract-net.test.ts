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
  expressions.register({
    name: "quote",
    evaluate: () => (price === null ? null : { price }),
  });
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
  return agent(
    bus,
    id,
    [{ name: goal, bid: "quote", body: worker(goal).body }],
    {
      expressionLibrary: quoting(null),
    },
  );
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
        body: [
          calling("dig", ["b1", "b2"]),
          awardingToCheapest(),
          noop("done"),
        ],
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

  it("correlates a bid for a cfp the plan sent but does not wait on", async () => {
    const bus = new InMemoryMessageBus();
    // The `cfp` is an ordinary message, not an `ActionResult.calls` entry, so
    // the intention never waits on it — but its bid must still be correlated.
    const boss = agent(bus, "boss", [
      {
        name: "ping",
        body: [
          {
            name: "cfp",
            execute: async (): Promise<ActionResult> => ({
              messages: [
                {
                  receiver: "b1",
                  performative: "cfp",
                  content: { goal: "dig" },
                },
              ],
            }),
          },
          ...noopActions("hold", 5),
        ],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    const opened: CallOpened[] = [];
    const proposed: CallProposalReceived[] = [];
    const completed: string[] = [];
    const toB1: Message[] = [];
    boss.on("call:opened", (e) => opened.push(e));
    boss.on("call:proposal", (e) => proposed.push(e));
    boss.on("intention:completed", (i) => completed.push(i.goal.name));
    boss.on("message:sent", (m) => {
      if (m.receiver === "b1") toB1.push(m);
    });

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "ping", priority: 5, status: "pending" });
    await run([boss, b1], 15);

    expect(opened).toHaveLength(1);
    expect(proposed).toHaveLength(1);
    expect(proposed[0].proposal.sender).toBe("b1");
    // The plan was never held: it finished while the call was still open, and
    // b1's bid was filed rather than turned away.
    expect(completed).toEqual(["ping"]);
    expect(
      toB1.filter((m) => m.performative === "reject-proposal"),
    ).toHaveLength(0);
  });

  it("rejects the bids it holds when the request is cancelled mid-call", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        cancellable: true,
        body: [calling("dig", ["b1", "b2"]), ...noopActions("hold", 30)],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    const ui = requester(bus);

    let cfpExchange: string | undefined;
    const sent: Message[] = [];
    const closed: CallClosed[] = [];
    boss.on("message:sent", (m) => {
      sent.push(m);
      if (m.performative === "cfp") cfpExchange = m.replyWith;
    });
    boss.on("call:closed", (e) => closed.push(e));

    await boss.start();
    await b1.start();
    await ui.request("pave");
    await run([boss, b1], 4);

    await bus.send("boss", {
      performative: "cancel",
      sender: "ui",
      receiver: "boss",
      content: {},
      inReplyTo: "req-ui",
      conversationId: "conv-ui",
      timestamp: Date.now(),
    });
    await boss.tick();

    // The bid on the open call is rejected; the call was cancelled, not closed
    // by its deadline, so no `call:closed` is emitted.
    const rejections = sent.filter((m) => m.performative === "reject-proposal");
    expect(rejections.map((m) => m.receiver)).toEqual(["b1"]);
    expect(closed).toEqual([]);

    // A bid already in flight is still told the call is over, not that none ran.
    // `cfpExchange` is the last cfp sent, b2's, so the late bid is b2's.
    bus.registerAgent("b2", () => {});
    await bus.send("boss", {
      performative: "propose",
      sender: "b2",
      receiver: "boss",
      content: { goal: "dig", terms: { price: 5 } },
      inReplyTo: cfpExchange,
      timestamp: Date.now(),
    });
    await boss.tick();

    const toLate = sent.filter(
      (m) => m.performative === "reject-proposal" && m.receiver === "b2",
    );
    expect(toLate[0]?.content).toMatchObject({ reason: "call closed" });
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

    // b1 bids a second time, after the call it answered has closed.
    const toB1: Message[] = [];
    boss.on("message:sent", (m) => {
      if (m.receiver === "b1") toB1.push(m);
    });
    await bus.send("boss", {
      performative: "propose",
      sender: "b1",
      receiver: "boss",
      content: { goal: "dig", terms: { price: 5 } },
      inReplyTo: cfpExchange,
      replyWith: "b1-late-bid",
      timestamp: Date.now(),
    });
    await boss.tick();

    const rejection = toB1.find(
      (m) =>
        m.performative === "reject-proposal" && m.inReplyTo === "b1-late-bid",
    );
    expect(rejection?.content).toMatchObject({ reason: "call closed" });
  });
});

describe("Contract Net — bidding and being awarded", () => {
  /** A bidder whose winning plan echoes the terms it was awarded as its result. */
  function willingBidder(
    bus: InMemoryMessageBus,
    id: string,
    goal: string,
    price = 40,
  ): Agent {
    const expressions = new ExpressionLibrary();
    expressions.register({ name: "quote", evaluate: () => ({ price }) });
    return agent(
      bus,
      id,
      [
        {
          name: goal,
          bid: "quote",
          body: [
            {
              name: "work",
              execute: async (intention): Promise<ActionResult> => ({
                result: { terms: intention.goal.data },
              }),
            },
          ],
        },
      ],
      { expressionLibrary: expressions },
    );
  }

  /** A plain `ui` inbox at `ui`, and a way to send it to an agent id. */
  function inboxFor(bus: InMemoryMessageBus, id: string): Message[] {
    const inbox: Message[] = [];
    bus.registerAgent(id, (m) => inbox.push(m));
    return inbox;
  }

  it("admits the awarded job with the bid's terms and no agree", async () => {
    const bus = new InMemoryMessageBus();
    const bob = willingBidder(bus, "bob", "dig");
    const inbox = inboxFor(bus, "ui");
    const accepted: string[] = [];
    bob.on("proposal:accepted", (e) => accepted.push(e.goal));

    await bob.start();
    await bus.send("bob", {
      performative: "cfp",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig", site: "north" },
      replyWith: "cfp-1",
      timestamp: Date.now(),
    });
    await bob.tick();
    await bob.tick();

    const propose = inbox.find((m) => m.performative === "propose")!;
    expect(propose.content).toEqual({ goal: "dig", terms: { price: 40 } });
    expect(propose.inReplyTo).toBe("cfp-1");

    await bus.send("bob", {
      performative: "accept-proposal",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();
    await bob.tick();
    await bob.tick();

    // No `agree`: the winning bid was the commitment. The job was admitted
    // with the bid's terms — and the cfp's own content — and its result came
    // back in the terminal `inform`.
    expect(accepted).toEqual(["dig"]);
    expect(inbox.map((m) => m.performative)).toEqual(["propose", "inform"]);
    const done = inbox.at(-1)!;
    expect(done.content).toMatchObject({
      goal: "dig",
      done: true,
      result: { terms: { goal: "dig", site: "north", terms: { price: 40 } } },
    });
  });

  it("drops a rejected bid, so a later accept finds nothing", async () => {
    const bus = new InMemoryMessageBus();
    const bob = willingBidder(bus, "bob", "dig");
    const inbox = inboxFor(bus, "ui");
    const rejected: string[] = [];
    bob.on("proposal:rejected", (e) => rejected.push(e.goal));

    await bob.start();
    await bus.send("bob", {
      performative: "cfp",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig" },
      replyWith: "cfp-1",
      timestamp: Date.now(),
    });
    await bob.tick();
    await bob.tick();
    const propose = inbox.find((m) => m.performative === "propose")!;

    await bus.send("bob", {
      performative: "reject-proposal",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig", reason: "too dear" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();
    expect(rejected).toEqual(["dig"]);

    // The bid is gone, so an accept naming it is answered `failure`.
    await bus.send("bob", {
      performative: "accept-proposal",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();

    const failure = inbox.find((m) => m.performative === "failure");
    expect(failure?.content).toMatchObject({ reason: "no such proposal" });
  });

  it("withdraws a pending bid when its cfp is cancelled", async () => {
    const bus = new InMemoryMessageBus();
    const bob = willingBidder(bus, "bob", "dig");
    const inbox = inboxFor(bus, "ui");
    const expired: string[] = [];
    bob.on("proposal:expired", (e) => expired.push(e.goal));

    await bob.start();
    await bus.send("bob", {
      performative: "cfp",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig" },
      replyWith: "cfp-1",
      timestamp: Date.now(),
    });
    await bob.tick();
    await bob.tick();

    await bus.send("bob", {
      performative: "cancel",
      sender: "ui",
      receiver: "bob",
      content: {},
      inReplyTo: "cfp-1",
      conversationId: "conv-1",
      timestamp: Date.now(),
    });
    await bob.tick();

    const answer = inbox.find(
      (m) => m.performative === "inform" && m.content !== null,
    );
    expect(answer?.content).toMatchObject({ cancelled: "cfp", goal: "dig" });
    expect(expired).toEqual([]);
  });
});

describe("Contract Net — being called", () => {
  /** A plain bus client at `ui`, and a way to send `to` a `cfp` from it. */
  function caller(bus: InMemoryMessageBus, to: string) {
    const inbox: Message[] = [];
    bus.registerAgent("ui", (m) => inbox.push(m));
    return {
      inbox,
      cfp(goal: string, replyWith?: string): Promise<void> {
        return bus.send(to, {
          performative: "cfp",
          sender: "ui",
          receiver: to,
          content: { goal },
          ...(replyWith ? { replyWith } : {}),
          timestamp: Date.now(),
        });
      },
      lastOf(performative: string): Message | undefined {
        return [...inbox]
          .reverse()
          .find((m) => m.performative === performative);
      },
    };
  }

  /** A bidder whose plan does `steps` of work, but which fails when it wins. */
  function failingBidder(
    bus: InMemoryMessageBus,
    id: string,
    goal: string,
  ): Agent {
    return agent(
      bus,
      id,
      [
        {
          name: goal,
          bid: "quote",
          body: [
            {
              name: "work",
              execute: async (): Promise<ActionResult> => ({
                failure: { reason: "ground too hard" },
              }),
            },
          ],
        },
      ],
      { expressionLibrary: quoting(10) },
    );
  }

  it("declines a cfp for a goal no plan serves, as no-plan", async () => {
    const bus = new InMemoryMessageBus();
    const bob = agent(bus, "bob", [worker("other")]);
    const ui = caller(bus, "bob");

    await bob.start();
    await ui.cfp("dig", "cfp-1");
    await bob.tick();
    await bob.tick();

    expect(ui.lastOf("refuse")?.content).toMatchObject({ verdict: "no-plan" });
  });

  it("declines a cfp when its goal queue is full, as capacity", async () => {
    const bus = new InMemoryMessageBus();
    const bob = agent(
      bus,
      "bob",
      [{ name: "dig", bid: "quote", body: worker("dig-work").body }],
      { expressionLibrary: quoting(10), maxGoals: 1 },
    );
    const ui = caller(bus, "bob");

    await bob.start();
    bob.goals.add({
      id: "filler",
      name: "filler",
      priority: 1,
      status: "pending",
    });
    await ui.cfp("dig", "cfp-1");
    await bob.tick();
    await bob.tick();

    expect(ui.lastOf("refuse")?.content).toMatchObject({ verdict: "capacity" });
  });

  it("declines rather than propose when the bid expression fails", async () => {
    const bus = new InMemoryMessageBus();
    const expressions = new ExpressionLibrary();
    expressions.register({
      name: "quote",
      evaluate: () => {
        throw new Error("no pricing model");
      },
    });
    const bob = agent(
      bus,
      "bob",
      [{ name: "dig", bid: "quote", body: worker("dig-work").body }],
      { expressionLibrary: expressions },
    );
    const ui = caller(bus, "bob");

    await bob.start();
    await ui.cfp("dig", "cfp-1");
    await bob.tick();
    await bob.tick();

    expect(ui.lastOf("refuse")?.content).toMatchObject({ verdict: "declined" });
  });

  it("answers an accept from anyone but the caller with a failure", async () => {
    const bus = new InMemoryMessageBus();
    const bob = bidder(bus, "bob", "dig", 10);
    const ui = caller(bus, "bob");
    const eve: Message[] = [];
    bus.registerAgent("eve", (m) => eve.push(m));

    await bob.start();
    await ui.cfp("dig", "cfp-1");
    await bob.tick();
    await bob.tick();
    const propose = ui.lastOf("propose")!;

    await bus.send("bob", {
      performative: "accept-proposal",
      sender: "eve",
      receiver: "bob",
      content: { goal: "dig" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();

    expect(
      eve.find((m) => m.performative === "failure")?.content,
    ).toMatchObject({ reason: "no such proposal" });
  });

  it("answers an accept with a failure when there is no room", async () => {
    const bus = new InMemoryMessageBus();
    const bob = agent(
      bus,
      "bob",
      [{ name: "dig", bid: "quote", body: worker("dig-work").body }],
      { expressionLibrary: quoting(10), maxGoals: 1 },
    );
    const ui = caller(bus, "bob");

    await bob.start();
    await ui.cfp("dig", "cfp-1");
    await bob.tick();
    await bob.tick();
    const propose = ui.lastOf("propose")!;

    bob.goals.add({
      id: "filler",
      name: "filler",
      priority: 1,
      status: "pending",
    });
    await bus.send("bob", {
      performative: "accept-proposal",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();

    expect(ui.lastOf("failure")?.content).toMatchObject({
      reason: "no capacity",
    });
  });

  it("answers the caller failure when the accepted job's plan fails", async () => {
    const bus = new InMemoryMessageBus();
    const bob = failingBidder(bus, "bob", "dig");
    const ui = caller(bus, "bob");

    await bob.start();
    await ui.cfp("dig", "cfp-1");
    await bob.tick();
    await bob.tick();
    const propose = ui.lastOf("propose")!;

    await bus.send("bob", {
      performative: "accept-proposal",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();
    await bob.tick();

    expect(ui.lastOf("failure")).toBeDefined();
  });

  it("drops a bid after its reply-by has passed, so a late accept fails", async () => {
    const bus = new InMemoryMessageBus();
    const bob = agent(
      bus,
      "bob",
      [{ name: "dig", bid: "quote", body: worker("dig-work").body }],
      { expressionLibrary: quoting(10), proposalTimeoutMs: 5 },
    );
    const ui = caller(bus, "bob");
    const expired: string[] = [];
    bob.on("proposal:expired", (e) => expired.push(e.goal));

    await bob.start();
    await ui.cfp("dig", "cfp-1");
    await bob.tick();
    await bob.tick();
    const propose = ui.lastOf("propose")!;

    await new Promise((resolve) => setTimeout(resolve, 15));
    await bob.tick();
    expect(expired).toEqual(["dig"]);

    await bus.send("bob", {
      performative: "accept-proposal",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();

    expect(ui.lastOf("failure")?.content).toMatchObject({
      reason: "no such proposal",
    });
  });

  it("still drops a bid when the cfp had no reply-with to key it by", async () => {
    const bus = new InMemoryMessageBus();
    const bob = bidder(bus, "bob", "dig", 10);
    const ui = caller(bus, "bob");

    await bob.start();
    await ui.cfp("dig");
    await bob.tick();
    await bob.tick();
    const propose = ui.lastOf("propose")!;
    expect(propose.inReplyTo).toBeUndefined();

    await bus.send("bob", {
      performative: "reject-proposal",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig", reason: "not needed" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();

    // The bid is gone even though the `cfp` gave no id to index it by, so the
    // accept that follows names nothing.
    await bus.send("bob", {
      performative: "accept-proposal",
      sender: "ui",
      receiver: "bob",
      content: { goal: "dig" },
      inReplyTo: propose.replyWith,
      timestamp: Date.now(),
    });
    await bob.tick();

    expect(ui.lastOf("failure")?.content).toMatchObject({
      reason: "no such proposal",
    });
  });
});

describe("Contract Net — closing and awarding", () => {
  /** The action that opens a call for `goal` among `receivers` with `deadlineMs`. */
  function openFor(
    goal: string,
    receivers: string[],
    deadlineMs?: number,
  ): Action {
    return {
      name: "call",
      execute: async (): Promise<ActionResult> => ({
        calls: [
          {
            goal,
            receivers,
            ...(deadlineMs !== undefined ? { deadlineMs } : {}),
          },
        ],
      }),
    };
  }

  it("rejects every unawarded bid when the action awards nothing", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [
          calling("dig", ["b1", "b2"]),
          { name: "idle", execute: async (): Promise<ActionResult> => ({}) },
          noop("done"),
        ],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    const b2 = bidder(bus, "b2", "dig", 20);
    const rejected: Message[] = [];
    boss.on("message:sent", (m) => {
      if (m.performative === "reject-proposal") rejected.push(m);
    });

    await boss.start();
    await b1.start();
    await b2.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, b1, b2], 8);

    expect(rejected.map((m) => m.receiver).sort()).toEqual(["b1", "b2"]);
  });

  it("opens a call with no deadline without throwing", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      { name: "pave", body: [openFor("dig", ["b1"], 0), noop("done")] },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    const cfps: Message[] = [];
    boss.on("message:sent", (m) => {
      if (m.performative === "cfp") cfps.push(m);
    });

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, b1], 5);

    expect(cfps).toHaveLength(1);
    expect(cfps[0].replyBy).toBeUndefined();
  });

  it("rejects the bids it holds when the goal is removed mid-call", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [calling("dig", ["b1", "b2"]), ...noopActions("hold", 30)],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    const rejected: Message[] = [];
    boss.on("message:sent", (m) => {
      if (m.performative === "reject-proposal") rejected.push(m);
    });

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, b1], 3);

    // The call is still open (b2 has not answered) when the goal is taken away.
    boss.goals.remove("g");
    await run([boss, b1], 2);

    expect(rejected.map((m) => m.receiver)).toEqual(["b1"]);
  });

  it("closes at the deadline with the bids it has when an invitee stays silent", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [
          openFor("dig", ["b1", "b2"], 5),
          awardingToCheapest(),
          noop("done"),
        ],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    const closed: CallClosed[] = [];
    const sent: Message[] = [];
    boss.on("call:closed", (e) => closed.push(e));
    boss.on("message:sent", (m) => sent.push(m));

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, b1], 3);

    await new Promise((resolve) => setTimeout(resolve, 15));
    await run([boss, b1], 5);

    expect(closed).toHaveLength(1);
    const accept = sent.find((m) => m.performative === "accept-proposal");
    expect(accept?.receiver).toBe("b1");
  });
});

describe("Contract Net — regressions", () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("closes a call before its earliest bid expires, so the award still lands", async () => {
    // b1's bid is valid for 80ms; the bidding deadline is far longer, and
    // `silent` never answers. Waiting out the deadline would let the bid
    // expire, and the award would be answered "no such proposal".
    const bus = new InMemoryMessageBus();
    bus.registerAgent("silent", () => {});
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [
          {
            name: "call",
            execute: async (): Promise<ActionResult> => ({
              calls: [
                { goal: "dig", receivers: ["b1", "silent"], deadlineMs: 5_000 },
              ],
            }),
          },
          awardingToCheapest(),
          noop("done"),
        ],
      },
    ]);
    const b1 = agent(
      bus,
      "b1",
      [{ name: "dig", bid: "quote", body: worker("dig-work").body }],
      { expressionLibrary: quoting(10), proposalTimeoutMs: 80 },
    );
    const fromB1: Message[] = [];
    b1.on("message:sent", (m) => fromB1.push(m));
    const accepted: string[] = [];
    b1.on("proposal:accepted", (e) => accepted.push(e.peer));
    const completed: string[] = [];
    boss.on("intention:completed", (i) => completed.push(i.goal.name));

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });

    const started = Date.now();
    for (let i = 0; i < 100 && !completed.includes("pave"); i++) {
      await run([boss, b1], 1);
      await sleep(5);
    }

    expect(accepted).toEqual(["boss"]);
    expect(fromB1.filter((m) => m.performative === "failure")).toHaveLength(0);
    expect(completed).toEqual(["pave"]);
    // Well inside the bidding deadline: the bid, not the deadline, closed it.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("waits for an action's delegations and awards as one batch", async () => {
    const bus = new InMemoryMessageBus();
    const order: string[] = [];
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [
          calling("dig", ["b1"]),
          {
            name: "award-and-delegate",
            execute: async (intention: Intention): Promise<ActionResult> => ({
              awards: [{ proposal: intention.calls[0].proposals[0].id }],
              delegations: [{ receiver: "helper", goal: "pack" }],
            }),
          },
          {
            name: "after",
            execute: async (): Promise<ActionResult> => {
              order.push("boss:after");
              return {};
            },
          },
        ],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    // The delegation takes longer than the award, so an award settling first
    // must not release the intention on its own.
    const helper = agent(bus, "helper", [worker("pack", 6)]);
    helper.on("intention:completed", (i) =>
      order.push(`helper:${i.goal.name}`),
    );
    const toHelper: Message[] = [];
    boss.on("message:sent", (m) => {
      if (m.receiver === "helper") toHelper.push(m);
    });
    boss.on("intention:completed", (i) => order.push(`boss:${i.goal.name}`));

    await boss.start();
    await b1.start();
    await helper.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, b1, helper], 25);

    expect(order).toEqual(["helper:pack", "boss:after", "boss:pave"]);
    // The delegation was never abandoned as "no longer needed".
    expect(toHelper.map((m) => m.performative)).toEqual(["request"]);
  });

  it("keeps a cfp sent through messages open after its plan finishes", async () => {
    // The cfp is the plan's only action, so the intention is gone before the
    // bid arrives. The bid is still the application's to answer.
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "ping",
        body: [
          {
            name: "cfp",
            execute: async (): Promise<ActionResult> => ({
              messages: [
                {
                  receiver: "b1",
                  performative: "cfp",
                  content: { goal: "dig" },
                },
              ],
            }),
          },
        ],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    const proposed: CallProposalReceived[] = [];
    const closed: CallClosed[] = [];
    const completed: string[] = [];
    const rejected: Message[] = [];
    boss.on("call:proposal", (e) => proposed.push(e));
    boss.on("call:closed", (e) => closed.push(e));
    boss.on("intention:completed", (i) => completed.push(i.goal.name));
    boss.on("message:sent", (m) => {
      if (m.performative === "reject-proposal") rejected.push(m);
    });

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "ping", priority: 5, status: "pending" });
    await run([boss, b1], 10);

    expect(completed).toEqual(["ping"]);
    expect(proposed).toHaveLength(1);
    expect(proposed[0].proposal.sender).toBe("b1");
    expect(rejected).toHaveLength(0);
    // Its one invitee answered, so it closed; nothing waited on it.
    expect(closed).toHaveLength(1);
  });

  it("prunes a cfp sent through messages once its reply-by has passed", async () => {
    const bus = new InMemoryMessageBus();
    bus.registerAgent("silent", () => {});
    const boss = agent(bus, "boss", [
      {
        name: "ping",
        body: [
          {
            name: "cfp",
            execute: async (): Promise<ActionResult> => ({
              messages: [
                {
                  receiver: "silent",
                  performative: "cfp",
                  content: { goal: "dig" },
                  replyBy: new Date(Date.now() + 20).toISOString(),
                },
              ],
            }),
          },
        ],
      },
    ]);
    const closed: CallClosed[] = [];
    boss.on("call:closed", (e) => closed.push(e));

    await boss.start();
    boss.goals.add({ id: "g", name: "ping", priority: 5, status: "pending" });
    await run([boss], 3);
    expect(boss.callExchanges.size).toBe(1);

    await sleep(40);
    await run([boss], 2);

    expect(closed).toHaveLength(1);
    expect(boss.callExchanges.size).toBe(0);
  });
  it("awards nothing when the award action also fails, and rejects every bid", async () => {
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [
          calling("dig", ["b1"]),
          {
            name: "award-then-give-up",
            execute: async (intention: Intention): Promise<ActionResult> => ({
              awards: [{ proposal: intention.calls[0].proposals[0].id }],
              failure: { reason: "changed my mind" },
            }),
          },
        ],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10, 5);
    const toB1: Message[] = [];
    boss.on("message:sent", (m) => {
      if (m.receiver === "b1") toB1.push(m);
    });
    const failures: IntentionFailed[] = [];
    boss.on("intention:failed", (e) => failures.push(e));
    const accepted: string[] = [];
    b1.on("proposal:accepted", (e) => accepted.push(e.peer));

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, b1], 10);

    expect(failures.map((f) => f.reason)).toEqual(["changed my mind"]);
    // Never accepted and then cancelled: the bid was simply turned down.
    expect(toB1.map((m) => m.performative)).toEqual(["cfp", "reject-proposal"]);
    expect(accepted).toEqual([]);
  });

  it("rejects the bids on a closed call when the intention fails before awarding", async () => {
    // The call closes as soon as b1 bids, but the intention keeps waiting on a
    // sub-goal opened by the same action — which then fails. The award step
    // never runs, so the bid it would have answered is rejected instead.
    const bus = new InMemoryMessageBus();
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [
          {
            name: "call-and-prepare",
            execute: async (): Promise<ActionResult> => ({
              calls: [{ goal: "dig", receivers: ["b1"] }],
              delegations: [{ goal: "prepare" }],
            }),
          },
          awardingToCheapest(),
        ],
      },
      {
        name: "prepare",
        body: [
          ...noopActions("prepare", 4),
          {
            name: "give-up",
            execute: async (): Promise<ActionResult> => ({
              failure: { reason: "site flooded" },
            }),
          },
        ],
      },
    ]);
    const b1 = bidder(bus, "b1", "dig", 10);
    const closed: CallClosed[] = [];
    const toB1: Message[] = [];
    boss.on("call:closed", (e) => closed.push(e));
    boss.on("message:sent", (m) => {
      if (m.receiver === "b1") toB1.push(m);
    });
    const failed: string[] = [];
    boss.on("intention:failed", (e) => failed.push(e.intention.goal.name));

    await boss.start();
    await b1.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss, b1], 12);

    expect(closed).toHaveLength(1);
    expect(failed).toContain("pave");
    expect(toB1.map((m) => m.performative)).toEqual(["cfp", "reject-proposal"]);
  });

  it("takes bids and refusals on an invitee's cfp only from that invitee", async () => {
    const bus = new InMemoryMessageBus();
    bus.registerAgent("silent", () => {});
    const toIntruder: Message[] = [];
    bus.registerAgent("intruder", (m) => toIntruder.push(m));
    const boss = agent(bus, "boss", [
      {
        name: "pave",
        body: [
          {
            name: "call",
            execute: async (): Promise<ActionResult> => ({
              calls: [
                { goal: "dig", receivers: ["silent"], deadlineMs: 5_000 },
              ],
            }),
          },
          awardingToCheapest(),
        ],
      },
    ]);
    const cfps: Message[] = [];
    boss.on("message:sent", (m) => {
      if (m.performative === "cfp") cfps.push(m);
    });
    const closed: CallClosed[] = [];
    const proposed: CallProposalReceived[] = [];
    boss.on("call:closed", (e) => closed.push(e));
    boss.on("call:proposal", (e) => proposed.push(e));

    await boss.start();
    boss.goals.add({ id: "g", name: "pave", priority: 5, status: "pending" });
    await run([boss], 2);
    expect(cfps).toHaveLength(1);

    // A third agent answers the cfp that went to `silent`, both ways.
    const reply = {
      sender: "intruder",
      receiver: "boss",
      inReplyTo: cfps[0].replyWith!,
      conversationId: cfps[0].conversationId!,
      timestamp: Date.now(),
    };
    await bus.send("boss", {
      ...reply,
      performative: "refuse",
      content: { goal: "dig", verdict: "declined" },
    });
    await bus.send("boss", {
      ...reply,
      performative: "propose",
      replyWith: "intruder-bid",
      content: { goal: "dig", terms: { price: 1 } },
    });
    await run([boss], 3);

    // Neither counted as `silent`'s answer: no bid filed, and the call is
    // still open waiting on the agent it actually asked.
    expect(proposed).toHaveLength(0);
    expect(closed).toHaveLength(0);
    const rejections = toIntruder.filter(
      (m) => m.performative === "reject-proposal",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0].content).toMatchObject({ reason: "not invited" });
    expect(rejections[0].inReplyTo).toBe("intruder-bid");
  });
});
