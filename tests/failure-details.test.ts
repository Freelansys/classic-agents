import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message, Performative } from "../src/bus/index.js";
import { Agent } from "../src/core/reasoning/index.js";
import type {
  AgentConfig,
  GoalFailed,
  GoalRefusal,
  GoalReplanned,
  IntentionFailed,
} from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type {
  Action,
  ActionResult,
  Plan,
  PlanFailure,
} from "../src/core/plans.js";
import type { ChildFailure, Delegation } from "../src/core/intentions.js";

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

async function run(agents: Agent[], cycles = 20): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

/** A one-action plan for `goal`, named `label` like its action. */
function plan(
  goal: string,
  label: string,
  execute: () => ActionResult,
  extra: Partial<Plan> = {},
): Plan {
  return {
    name: label,
    goal,
    ...extra,
    body: [{ name: label, execute: async () => execute() }],
  };
}

/** A raw inbox at `id` that answers what it receives through `respond`. */
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

/** Asks `to` for `goal` from the raw inbox `from`. */
function request(
  bus: InMemoryMessageBus,
  from: string,
  to: string,
  content: Record<string, unknown>,
): Promise<void> {
  return bus.send(to, {
    performative: "request",
    sender: from,
    receiver: to,
    content,
    conversationId: `conv-${from}`,
    replyWith: `req-${from}`,
    timestamp: Date.now(),
  });
}

/**
 * A plan for `goal` that delegates `work` to `receiver`, may do without it,
 * and records what its delegations and child failures were once it resumes.
 */
function delegatingPlan(
  goal: string,
  receiver: string | undefined,
  work: string,
  seen: { delegations: Delegation[]; childFailures: ChildFailure[] },
): Plan {
  const observe: Action = {
    name: "observe",
    execute: async (intention) => {
      seen.delegations.push(...intention.delegations.map((d) => ({ ...d })));
      seen.childFailures.push(...intention.childFailures);
      return {};
    },
  };
  return {
    goal,
    body: [
      {
        name: "delegate",
        execute: async () => ({
          delegations: [
            {
              ...(receiver !== undefined ? { receiver } : {}),
              goal: work,
              onFailure: "continue",
            },
          ],
        }),
      },
      observe,
    ],
  };
}

const gaps = { edits: ["name the auth provider"], skipped: ["login.ts"] };

describe("failure details — sending", () => {
  it("sends an action's details with the requester's failure, and reports them", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = scriptedPeer(bus, "ui");
    const boss = agent(bus, "boss", [
      plan("generate", "write", () => ({
        failure: { reason: "the spec has gaps", details: gaps },
      })),
    ]);
    const intentionFailed: IntentionFailed[] = [];
    const goalFailed: GoalFailed[] = [];
    boss.on("intention:failed", (e) => intentionFailed.push(e));
    boss.on("goal:failed", (e) => goalFailed.push(e));
    await boss.start();

    await request(bus, "ui", "boss", { goal: "generate" });
    await run([boss]);

    const failure = inbox.find((m) => m.performative === "failure");
    expect(failure?.content).toEqual({
      goal: "generate",
      reason: "the spec has gaps",
      details: gaps,
    });
    expect(intentionFailed[0].details).toEqual(gaps);
    expect(intentionFailed[0].intention.failureDetails).toEqual(gaps);
    expect(goalFailed[0].details).toEqual(gaps);
    expect(goalFailed[0].attempts[0].details).toEqual(gaps);
    await boss.stop();
  });

  it("leaves details off a failure that gave none", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = scriptedPeer(bus, "ui");
    const boss = agent(bus, "boss", [
      plan("generate", "write", () => ({ failure: { reason: "no" } })),
    ]);
    const goalFailed: GoalFailed[] = [];
    boss.on("goal:failed", (e) => goalFailed.push(e));
    await boss.start();

    await request(bus, "ui", "boss", { goal: "generate" });
    await run([boss]);

    const failure = inbox.find((m) => m.performative === "failure");
    expect(failure?.content).toEqual({ goal: "generate", reason: "no" });
    expect("details" in goalFailed[0]).toBe(false);
    await boss.stop();
  });

  it("lets onPlanFailure see, replace and clear the details", async () => {
    const cases: Array<{
      hook: Plan["onPlanFailure"];
      expected: unknown;
    }> = [
      { hook: () => ({ reason: "reworded" }), expected: gaps },
      {
        hook: () => ({ details: { only: "this" } }),
        expected: { only: "this" },
      },
      { hook: () => ({ details: undefined }), expected: undefined },
    ];
    for (const { hook, expected } of cases) {
      const bus = new InMemoryMessageBus();
      const inbox = scriptedPeer(bus, "ui");
      const seen: PlanFailure[] = [];
      const boss = agent(bus, "boss", [
        plan(
          "generate",
          "write",
          () => ({ failure: { reason: "gaps", details: gaps } }),
          {
            onPlanFailure: (intention, beliefs, failure) => {
              seen.push(failure);
              return hook!(intention, beliefs, failure);
            },
          },
        ),
      ]);
      await boss.start();

      await request(bus, "ui", "boss", { goal: "generate" });
      await run([boss]);

      expect(seen[0].details).toEqual(gaps);
      const content = inbox.find((m) => m.performative === "failure")
        ?.content as Record<string, unknown>;
      expect(content.details).toEqual(expected);
      expect("details" in content).toBe(expected !== undefined);
      await boss.stop();
    }
  });

  it("lets onGoalFailure see and replace the details", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = scriptedPeer(bus, "ui");
    const seen: unknown[] = [];
    const boss = agent(
      bus,
      "boss",
      [
        plan("generate", "write", () => ({
          failure: { reason: "gaps", details: gaps },
        })),
      ],
      {
        onGoalFailure: (_goal, _beliefs, failure) => {
          seen.push(failure.details);
          return { details: { summary: 2 } };
        },
      },
    );
    await boss.start();

    await request(bus, "ui", "boss", { goal: "generate" });
    await run([boss]);

    expect(seen).toEqual([gaps]);
    expect(inbox.find((m) => m.performative === "failure")?.content).toEqual({
      goal: "generate",
      reason: "gaps",
      details: { summary: 2 },
    });
    await boss.stop();
  });

  it("answers with the last plan's details, not an earlier one's", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = scriptedPeer(bus, "ui");
    const boss = agent(bus, "boss", [
      plan("generate", "first", () => ({
        failure: { reason: "first", details: gaps },
      })),
      plan("generate", "second", () => ({ failure: { reason: "second" } })),
    ]);
    const replanned: GoalReplanned[] = [];
    const goalFailed: GoalFailed[] = [];
    boss.on("goal:replanned", (e) => replanned.push(e));
    boss.on("goal:failed", (e) => goalFailed.push(e));
    await boss.start();

    await request(bus, "ui", "boss", { goal: "generate" });
    await run([boss]);

    expect(replanned[0].details).toEqual(gaps);
    expect(goalFailed[0].attempts.map((a) => a.details)).toEqual([
      gaps,
      undefined,
    ]);
    expect("details" in goalFailed[0]).toBe(false);
    expect(inbox.find((m) => m.performative === "failure")?.content).toEqual({
      goal: "generate",
      reason: "second",
    });
    await boss.stop();
  });

  it("sends the details res.refuse is given with the refuse", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = scriptedPeer(bus, "ui");
    const refused: GoalRefusal[] = [];
    const boss = agent(bus, "boss", [plan("generate", "write", () => ({}))], {
      directiveMiddleware: [
        (_msg, res) => res.refuse("middleware", "spec missing", gaps),
      ],
    });
    boss.on("goal:refused", (e) => refused.push(e));
    await boss.start();

    await request(bus, "ui", "boss", { goal: "generate" });
    await run([boss], 3);

    expect(inbox.find((m) => m.performative === "refuse")?.content).toEqual({
      goal: "generate",
      verdict: "middleware",
      reason: "spec missing",
      details: gaps,
    });
    expect(refused[0].details).toEqual(gaps);
    await boss.stop();
  });

  it("names the fields that failed their schema in a not-understood", async () => {
    const bus = new InMemoryMessageBus();
    const inbox = scriptedPeer(bus, "ui");
    const boss = agent(bus, "boss", []);
    await boss.start();

    await request(bus, "ui", "boss", { goal: 42 });
    await run([boss], 3);

    const reply = inbox.find((m) => m.performative === "not-understood");
    const content = reply?.content as {
      reason: string;
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(content.reason).toMatch(/schema violation in "request"/);
    expect(content.details.issues).toEqual([
      { path: "goal", message: expect.any(String) },
    ]);
    await boss.stop();
  });
});

describe("failure details — receiving", () => {
  it("keeps a delegate agent's details on the delegation, the child failure and the record", async () => {
    // The case the details are for: a generate agent that stops on gaps in
    // the spec, and an agent that delegated generation and must show them.
    const bus = new InMemoryMessageBus();
    const generator = agent(bus, "generator", [
      plan("generate", "write", () => ({
        failure: { reason: "the spec has gaps", details: gaps },
      })),
    ]);
    const seen = {
      delegations: [] as Delegation[],
      childFailures: [] as ChildFailure[],
    };
    const repl = agent(bus, "repl", [
      delegatingPlan("build", "generator", "generate", seen),
    ]);
    await generator.start();
    await repl.start();
    repl.goals.add({ id: "b", name: "build", priority: 5, status: "pending" });

    await run([repl, generator]);

    const [delegation] = seen.delegations;
    expect(delegation).toMatchObject({
      status: "failed",
      reason: "the spec has gaps",
      details: gaps,
    });
    expect(seen.childFailures).toEqual([
      expect.objectContaining({ reason: "the spec has gaps", details: gaps }),
    ]);
    expect(
      repl.beliefs.get(`failed.generator.generate.${delegation.exchange}`),
    ).toEqual({ reason: "the spec has gaps", details: gaps });
    await generator.stop();
    await repl.stop();
  });

  it("keeps a sub-goal's details on the child failure", async () => {
    const bus = new InMemoryMessageBus();
    const seen = {
      delegations: [] as Delegation[],
      childFailures: [] as ChildFailure[],
    };
    const a = agent(bus, "a", [
      delegatingPlan("build", undefined, "generate", seen),
      plan("generate", "write", () => ({
        failure: { reason: "gaps", details: gaps },
      })),
    ]);
    await a.start();
    a.goals.add({ id: "b", name: "build", priority: 5, status: "pending" });

    await run([a]);

    expect(seen.delegations[0].details).toEqual(gaps);
    expect(seen.childFailures[0]).toMatchObject({
      reason: "gaps",
      details: gaps,
    });
    await a.stop();
  });

  it.each([
    ["failure", { goal: "generate", reason: "gaps", details: gaps }],
    [
      "refuse",
      { goal: "generate", verdict: "no-plan", reason: "gaps", details: gaps },
    ],
    ["not-understood", { event: "request", reason: "gaps", details: gaps }],
  ] as const)(
    "keeps the details of a %s that ends a delegation",
    async (performative, content) => {
      const bus = new InMemoryMessageBus();
      scriptedPeer(bus, "peer", (msg, reply) => {
        if (msg.performative === "request") reply(performative, content);
      });
      const seen = {
        delegations: [] as Delegation[],
        childFailures: [] as ChildFailure[],
      };
      const boss = agent(bus, "boss", [
        delegatingPlan("build", "peer", "generate", seen),
      ]);
      await boss.start();
      boss.goals.add({
        id: "b",
        name: "build",
        priority: 5,
        status: "pending",
      });

      await run([boss], 6);

      expect(seen.delegations[0]).toMatchObject({
        status: "failed",
        details: gaps,
      });
      expect(seen.childFailures[0].details).toEqual(gaps);
      await boss.stop();
    },
  );

  it("keeps a refusal's details on goalRefused and the infeasible record", async () => {
    const bus = new InMemoryMessageBus();
    scriptedPeer(bus, "peer", (msg, reply) => {
      if (msg.performative === "request") {
        reply("refuse", {
          goal: "generate",
          verdict: "no-plan",
          reason: "gaps",
          details: gaps,
        });
      }
    });
    const seen = {
      delegations: [] as Delegation[],
      childFailures: [] as ChildFailure[],
    };
    const boss = agent(bus, "boss", [
      delegatingPlan("build", "peer", "generate", seen),
    ]);
    const refusals: GoalRefusal[] = [];
    boss.on("goalRefused", (e) => refusals.push(e));
    await boss.start();
    boss.goals.add({ id: "b", name: "build", priority: 5, status: "pending" });

    await run([boss], 6);

    expect(refusals[0].details).toEqual(gaps);
    expect(
      boss.beliefs.get(
        `infeasible.peer.generate.${seen.delegations[0].exchange}`,
      ),
    ).toEqual({ verdict: "no-plan", reason: "gaps", details: gaps });
    await boss.stop();
  });

  it("keeps a not-understood's details on its record", async () => {
    const bus = new InMemoryMessageBus();
    const a = agent(bus, "a", []);
    await a.start();

    await bus.send("a", {
      performative: "not-understood",
      sender: "peer",
      receiver: "a",
      content: { event: "inform", reason: "bad", details: { issues: [] } },
      timestamp: Date.now(),
    });
    await run([a], 2);

    expect(a.beliefs.get("not-understood.peer.inform")).toEqual({
      reason: "bad",
      details: { issues: [] },
    });
    await a.stop();
  });
});
