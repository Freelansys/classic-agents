import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  DeferredDirective,
  DirectiveMiddleware,
  ProposalAccepted,
  ProposalExpired,
  ProposalRejected,
} from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { Action, ActionResult, Plan } from "../src/core/plans.js";
import type { Goal } from "../src/core/goals.js";
import type { Intention, SentProposal } from "../src/core/intentions.js";

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

/** An action that returns `result`. */
function step(name: string, result: ActionResult = {}): Action {
  return { name, execute: async () => result };
}

/** A plan deciding on proposals for `goal`, whose one action returns `result`. */
function deciding(goal: string, result: ActionResult, name?: string): Plan {
  return {
    ...(name ? { name } : {}),
    goal,
    on: "propose",
    body: [step("decide", result)],
  };
}

/** A plain bus client at `ui` that proposes to `coordinator`. */
function proposer(bus: InMemoryMessageBus) {
  const inbox: Message[] = [];
  bus.registerAgent("ui", (m) => inbox.push(m));
  return {
    inbox,
    propose(
      goal: string,
      terms: unknown,
      extra: Partial<Message> = {},
    ): Promise<void> {
      return bus.send("coordinator", {
        performative: "propose",
        sender: "ui",
        receiver: "coordinator",
        content: { goal, terms },
        conversationId: "conv-demo",
        replyWith: "prop-1",
        timestamp: Date.now(),
        ...extra,
      });
    },
    cancel(): Promise<void> {
      return bus.send("coordinator", {
        performative: "cancel",
        sender: "ui",
        receiver: "coordinator",
        content: { goal: "give-demo" },
        conversationId: "conv-demo",
        inReplyTo: "prop-1",
        replyWith: "cancel-1",
        timestamp: Date.now(),
      });
    },
    performatives(): string[] {
      return inbox.map((m) => m.performative);
    },
  };
}

/** Ticks every agent, in turn, `cycles` times. */
async function run(agents: Agent[], cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FIPA Propose: deciding on a proposal nobody called for", () => {
  it("answers accept-proposal, with the result, when the decision is achieved", async () => {
    const bus = new InMemoryMessageBus();
    let seen: Goal | undefined;
    const coordinator = agent(bus, "coordinator", [
      {
        goal: "give-demo",
        on: "propose",
        body: [
          {
            name: "decide",
            execute: async (i) => {
              seen = { ...i.goal };
              return { result: { approver: "dana" } };
            },
          },
        ],
      },
    ]);
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", { date: "2026-11-12" });
    await run([coordinator]);

    // The decision is the only answer: no `agree` before it.
    expect(ui.performatives()).toEqual(["accept-proposal"]);
    expect(ui.inbox[0]).toMatchObject({
      inReplyTo: "prop-1",
      conversationId: "conv-demo",
      protocol: "fipa-propose",
      content: { goal: "give-demo", result: { approver: "dana" } },
    });
    expect(seen?.data).toEqual({
      goal: "give-demo",
      terms: { date: "2026-11-12" },
    });
    expect(seen?.source).toMatchObject({
      sender: "ui",
      inReplyTo: "prop-1",
      performative: "propose",
    });
  });

  it("answers reject-proposal, with reason and details, when the decision fails", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = agent(bus, "coordinator", [
      deciding("give-demo", {
        failure: { reason: "not approved", details: { by: "dana" } },
      }),
    ]);
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", {});
    await run([coordinator]);

    expect(ui.performatives()).toEqual(["reject-proposal"]);
    expect(ui.inbox[0]).toMatchObject({
      inReplyTo: "prop-1",
      content: {
        goal: "give-demo",
        reason: "not approved",
        details: { by: "dana" },
      },
    });
  });

  it("still rejects a propose for a goal no marked plan serves (D5)", async () => {
    const bus = new InMemoryMessageBus();
    // Serves the goal, but only as a request.
    const coordinator = agent(bus, "coordinator", [
      { goal: "give-demo", body: [step("do")] },
    ]);
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", {});
    await run([coordinator]);

    expect(ui.performatives()).toEqual(["reject-proposal"]);
    expect(ui.inbox[0].content).toMatchObject({ reason: "no call open" });
    expect(coordinator.goals.all()).toHaveLength(0);
  });

  it("keeps marked plans for proposals and unmarked plans for requests", async () => {
    const bus = new InMemoryMessageBus();
    const ran: string[] = [];
    const tracking = (name: string): Action => ({
      name,
      execute: async () => {
        ran.push(name);
        return {};
      },
    });
    const coordinator = agent(bus, "coordinator", [
      { name: "do-demo", goal: "give-demo", body: [tracking("do")] },
      {
        name: "decide-demo",
        goal: "give-demo",
        on: "propose",
        body: [tracking("decide")],
      },
      { goal: "approve", on: "propose", body: [tracking("approve")] },
    ]);
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", {});
    await run([coordinator]);
    await bus.send("coordinator", {
      performative: "request",
      sender: "ui",
      receiver: "coordinator",
      content: { goal: "give-demo" },
      replyWith: "req-1",
      timestamp: Date.now(),
    });
    await run([coordinator]);
    // Served only by a marked plan, so a request for it has no plan.
    await bus.send("coordinator", {
      performative: "request",
      sender: "ui",
      receiver: "coordinator",
      content: { goal: "approve" },
      replyWith: "req-2",
      timestamp: Date.now(),
    });
    await run([coordinator]);

    expect(ran).toEqual(["decide", "do"]);
    const refusal = ui.inbox.find((m) => m.inReplyTo === "req-2");
    expect(refusal).toMatchObject({
      performative: "refuse",
      content: { goal: "approve", verdict: "no-plan" },
    });
  });

  it("serves the deciding plan's sub-goals with ordinary plans", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = agent(bus, "coordinator", [
      {
        goal: "give-demo",
        on: "propose",
        body: [
          step("arrange", { delegations: [{ goal: "book-room" }] }),
          {
            name: "decide",
            execute: async (i) => ({ result: i.delegations[0].result }),
          },
        ],
      },
      { goal: "book-room", body: [step("book", { result: "room 4" })] },
    ]);
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", {});
    await run([coordinator]);

    expect(ui.performatives()).toEqual(["accept-proposal"]);
    expect(ui.inbox[0].content).toMatchObject({ result: "room 4" });
  });

  it("runs the directive chain: a refusal is a reject-proposal", async () => {
    const bus = new InMemoryMessageBus();
    const seen: string[] = [];
    const policy: DirectiveMiddleware = (req, res, next) => {
      seen.push(req.performative);
      if (req.sender === "ui") {
        res.refuse("middleware", "not from ui");
        return;
      }
      return next();
    };
    const coordinator = agent(bus, "coordinator", [deciding("give-demo", {})], {
      directiveMiddleware: [policy],
    });
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", {});
    await run([coordinator]);

    expect(seen).toEqual(["propose"]);
    expect(ui.performatives()).toEqual(["reject-proposal"]);
    expect(ui.inbox[0]).toMatchObject({
      inReplyTo: "prop-1",
      content: {
        goal: "give-demo",
        verdict: "middleware",
        reason: "not from ui",
      },
    });
  });

  it("can be deferred to a person, then decided", async () => {
    const bus = new InMemoryMessageBus();
    const ask: DirectiveMiddleware = (_req, res) => {
      res.defer();
    };
    const coordinator = agent(
      bus,
      "coordinator",
      [deciding("give-demo", { result: "yes" })],
      { directiveMiddleware: [ask] },
    );
    const deferred: DeferredDirective[] = [];
    coordinator.on("directive:deferred", (d) => deferred.push(d));
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", {});
    await run([coordinator]);
    expect(deferred).toHaveLength(1);
    expect(ui.inbox).toHaveLength(0);

    await coordinator.admit(deferred[0].id);
    await run([coordinator]);

    expect(ui.performatives()).toEqual(["accept-proposal"]);
  });

  it("answers a declined deferral with reject-proposal", async () => {
    const bus = new InMemoryMessageBus();
    const ask: DirectiveMiddleware = (_req, res) => {
      res.defer();
    };
    const coordinator = agent(bus, "coordinator", [deciding("give-demo", {})], {
      directiveMiddleware: [ask],
    });
    const deferred: DeferredDirective[] = [];
    coordinator.on("directive:deferred", (d) => deferred.push(d));
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", {});
    await run([coordinator]);
    coordinator.decline(deferred[0].id, "fully booked");
    await run([coordinator]);

    expect(ui.performatives()).toEqual(["reject-proposal"]);
    expect(ui.inbox[0].content).toMatchObject({ reason: "fully booked" });
  });

  it("is withdrawn by the proposer's cancel, with no decision sent", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = agent(bus, "coordinator", [
      {
        goal: "give-demo",
        on: "propose",
        cancellable: true,
        body: [
          step("wait", {
            delegations: [{ goal: "approval", when: "approved" }],
          }),
          step("decide"),
        ],
      },
      { goal: "approval", body: [step("record")] },
    ]);
    coordinator.propositionLibrary.register({
      name: "approved",
      evaluate: () => false,
    });
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", {});
    await run([coordinator]);
    await ui.cancel();
    await run([coordinator]);

    expect(ui.performatives()).toEqual(["inform"]);
    expect(ui.inbox[0]).toMatchObject({
      inReplyTo: "cancel-1",
      content: { cancelled: "propose", goal: "give-demo" },
    });
    expect(coordinator.goals.getUnfinished()).toHaveLength(0);
  });

  it("is withdrawn once the proposer's reply-by passes, with no decision sent", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = agent(bus, "coordinator", [
      {
        goal: "give-demo",
        on: "propose",
        cancellable: true,
        body: [
          step("wait", {
            delegations: [{ goal: "approval", when: "approved" }],
          }),
          step("decide"),
        ],
      },
      { goal: "approval", body: [step("record")] },
    ]);
    coordinator.propositionLibrary.register({
      name: "approved",
      evaluate: () => false,
    });
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose(
      "give-demo",
      {},
      {
        replyBy: new Date(Date.now() + 60).toISOString(),
      },
    );
    await run([coordinator], 3);
    expect(coordinator.goals.getUnfinished().length).toBeGreaterThan(0);

    await sleep(80);
    await run([coordinator]);

    expect(ui.inbox).toHaveLength(0);
    expect(coordinator.goals.getUnfinished()).toHaveLength(0);
  });

  it("rejects a proposal the queue has no room for", async () => {
    const bus = new InMemoryMessageBus();
    const coordinator = agent(bus, "coordinator", [deciding("give-demo", {})], {
      maxGoals: 1,
    });
    const ui = proposer(bus);
    await coordinator.start();

    await ui.propose("give-demo", { n: 1 }, { replyWith: "prop-1" });
    await ui.propose("give-demo", { n: 2 }, { replyWith: "prop-2" });
    await run([coordinator]);

    const second = ui.inbox.find((m) => m.inReplyTo === "prop-2");
    expect(second).toMatchObject({
      performative: "reject-proposal",
      content: { goal: "give-demo", verdict: "capacity" },
    });
    expect(second?.content).not.toHaveProperty("goalId");
  });
});

describe("FIPA Propose: making a proposal from a plan", () => {
  /** A requester plan that proposes `goal` to `receiver`, then reports how it went. */
  function proposing(
    receiver: string,
    timeoutMs?: number | null,
    seen?: SentProposal[],
  ): Plan {
    return {
      goal: "request-demo",
      body: [
        step("propose", {
          proposals: [
            {
              receiver,
              goal: "give-demo",
              terms: { date: "2026-11-12" },
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
          ],
        }),
        {
          name: "outcome",
          execute: async (i: Intention) => {
            const p = i.proposals.at(-1)!;
            seen?.push({ ...p });
            return p.status === "accepted"
              ? { result: p.answer }
              : { failure: { reason: p.reason ?? p.status } };
          },
        },
      ],
    };
  }

  /** A plain bus client at `ui` that asks `requester` to request a demo. */
  function client(bus: InMemoryMessageBus) {
    const inbox: Message[] = [];
    bus.registerAgent("ui", (m) => inbox.push(m));
    return {
      inbox,
      ask(): Promise<void> {
        return bus.send("requester", {
          performative: "request",
          sender: "ui",
          receiver: "requester",
          content: { goal: "request-demo" },
          conversationId: "conv-ui",
          replyWith: "req-ui",
          timestamp: Date.now(),
        });
      },
    };
  }

  it("waits for an accept, and reads the answer", async () => {
    const bus = new InMemoryMessageBus();
    const requester = agent(bus, "requester", [proposing("coordinator")]);
    const coordinator = agent(bus, "coordinator", [
      deciding("give-demo", { result: { approver: "dana" } }),
    ]);
    const accepted: ProposalAccepted[] = [];
    requester.on("proposal:accepted", (e) => accepted.push(e));
    const ui = client(bus);
    await requester.start();
    await coordinator.start();

    await ui.ask();
    await run([requester, coordinator]);

    expect(ui.inbox.map((m) => m.performative)).toEqual(["agree", "inform"]);
    expect(ui.inbox[1].content).toMatchObject({
      done: true,
      result: { approver: "dana" },
    });
    expect(accepted).toEqual([
      expect.objectContaining({
        peer: "coordinator",
        goal: "give-demo",
        answer: { approver: "dana" },
      }),
    ]);
  });

  it("reads a rejection, with its reason", async () => {
    const bus = new InMemoryMessageBus();
    const seen: SentProposal[] = [];
    const requester = agent(bus, "requester", [
      proposing("coordinator", undefined, seen),
    ]);
    const coordinator = agent(bus, "coordinator", [
      deciding("give-demo", { failure: { reason: "not approved" } }),
    ]);
    const rejected: ProposalRejected[] = [];
    requester.on("proposal:rejected", (e) => rejected.push(e));
    const ui = client(bus);
    await requester.start();
    await coordinator.start();

    await ui.ask();
    await run([requester, coordinator]);

    expect(seen).toEqual([
      expect.objectContaining({
        status: "rejected",
        receiver: "coordinator",
        reason: "not approved",
      }),
    ]);
    expect(rejected).toHaveLength(1);
    expect(ui.inbox[1]).toMatchObject({
      performative: "failure",
      content: { reason: "not approved" },
    });
  });

  it("is rejected by an agent that does not decide on proposals", async () => {
    const bus = new InMemoryMessageBus();
    const seen: SentProposal[] = [];
    const requester = agent(bus, "requester", [
      proposing("coordinator", undefined, seen),
    ]);
    const coordinator = agent(bus, "coordinator", []);
    const ui = client(bus);
    await requester.start();
    await coordinator.start();

    await ui.ask();
    await run([requester, coordinator]);

    expect(seen[0]).toMatchObject({
      status: "rejected",
      reason: "no call open",
    });
  });

  it("expires when nobody decides by its deadline", async () => {
    const bus = new InMemoryMessageBus();
    const seen: SentProposal[] = [];
    const requester = agent(bus, "requester", [proposing("silent", 40, seen)]);
    bus.registerAgent("silent", () => {});
    const expired: ProposalExpired[] = [];
    requester.on("proposal:expired", (e) => expired.push(e));
    const ui = client(bus);
    await requester.start();

    await ui.ask();
    await run([requester], 3);
    expect(seen).toHaveLength(0);

    await sleep(60);
    await run([requester], 3);

    expect(seen[0]).toMatchObject({ status: "expired" });
    expect(expired).toHaveLength(1);
  });

  it("sends no reply-by when the timeout is null", async () => {
    const bus = new InMemoryMessageBus();
    const requester = agent(bus, "requester", [proposing("silent", null)]);
    const heard: Message[] = [];
    bus.registerAgent("silent", (m) => heard.push(m));
    const ui = client(bus);
    await requester.start();

    await ui.ask();
    await run([requester], 3);

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      performative: "propose",
      content: { goal: "give-demo", terms: { date: "2026-11-12" } },
      conversationId: "conv-ui",
    });
    expect(heard[0].replyBy).toBeUndefined();
    expect(heard[0].inReplyTo).toBeUndefined();
  });

  it("withdraws an open proposal with a cancel when the request is cancelled", async () => {
    const bus = new InMemoryMessageBus();
    const requester = agent(bus, "requester", [
      { ...proposing("coordinator", null), cancellable: true },
    ]);
    const coordinator = agent(bus, "coordinator", [
      {
        goal: "give-demo",
        on: "propose",
        cancellable: true,
        body: [
          step("wait", {
            delegations: [{ goal: "approval", when: "approved" }],
          }),
          step("decide"),
        ],
      },
      { goal: "approval", body: [step("record")] },
    ]);
    coordinator.propositionLibrary.register({
      name: "approved",
      evaluate: () => false,
    });
    const ui = client(bus);
    await requester.start();
    await coordinator.start();

    await ui.ask();
    await run([requester, coordinator]);
    expect(coordinator.goals.getUnfinished().length).toBeGreaterThan(0);

    await bus.send("requester", {
      performative: "cancel",
      sender: "ui",
      receiver: "requester",
      content: { goal: "request-demo" },
      inReplyTo: "req-ui",
      timestamp: Date.now(),
    });
    await run([requester, coordinator]);

    expect(coordinator.goals.getUnfinished()).toHaveLength(0);
    // The coordinator's answer to the cancel is filed as one, not as loose
    // beliefs.
    expect(requester.beliefs.get("msg.cancelled")).toBeUndefined();
    expect(
      requester.beliefs.queryByPrefix("cancelled.coordinator.give-demo"),
    ).toHaveLength(1);
  });
});
