import { describe, it, expect } from "vitest";
import {
  InMemoryMessageBus,
  MessageSchema,
  isUserDefinedParameter,
  userDefinedParameters,
} from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { envelopeViolationReason } from "../src/bus/schemas.js";
import { Agent } from "../src/core/reasoning/index.js";
import { PlanLibrary } from "../src/core/plans.js";
import type { ActionResult, Plan } from "../src/core/plans.js";
import type { GoalSource } from "../src/core/goals.js";

// FIPA ACL's user-defined (`X-`) message parameters are carried on the
// envelope, set from a plan, and never inherited by a reply (#91).

function agent(bus: InMemoryMessageBus, id: string, plans: Plan[]): Agent {
  const library = new PlanLibrary();
  for (const plan of plans) library.register(plan);
  return new Agent({ id, bus, planLibrary: library });
}

/** A plan of one action per result, in order. */
function plan(goal: string, ...results: ActionResult[]): Plan {
  return {
    goal,
    body: results.map((result, i) => ({
      name: `${goal}-${i}`,
      execute: async (): Promise<ActionResult> => result,
    })),
  };
}

async function run(agents: Agent[], cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    for (const a of agents) await a.tick();
  }
}

/** A peer that records what it receives and answers nothing. */
function silentPeer(bus: InMemoryMessageBus, id: string): Message[] {
  const received: Message[] = [];
  bus.registerAgent(id, (msg) => received.push(msg));
  return received;
}

/** Records every message `a` sends. */
function sentBy(a: Agent): Message[] {
  const sent: Message[] = [];
  a.on("message:sent", (m: Message) => sent.push(m));
  return sent;
}

const CC = { "X-cc": ["dana"] };

describe("The envelope", () => {
  it("types user-defined parameters on Message", () => {
    const message: Message = {
      performative: "inform",
      sender: "a",
      content: {},
      "X-cc": ["dana"],
    };
    expect(message["X-cc"]).toEqual(["dana"]);
  });

  it("keeps X- parameters when parsed, and still drops other unknown keys", () => {
    const parsed = MessageSchema.parse({
      performative: "inform",
      sender: "a",
      content: { n: 1 },
      "X-cc": ["dana"],
      "X-priority": 3,
      unknown: true,
    });
    expect(parsed).toEqual({
      performative: "inform",
      sender: "a",
      content: { n: 1 },
      "X-cc": ["dana"],
      "X-priority": 3,
    });
  });

  it("accepts a message carrying them", () => {
    expect(
      envelopeViolationReason({
        performative: "inform",
        sender: "a",
        content: {},
        "X-cc": { anything: "goes" },
      }),
    ).toBeUndefined();
  });

  it("names them", () => {
    expect(isUserDefinedParameter("X-cc")).toBe(true);
    expect(isUserDefinedParameter("X-")).toBe(false);
    expect(isUserDefinedParameter("x-cc")).toBe(false);
    expect(isUserDefinedParameter("cc")).toBe(false);
    expect(
      userDefinedParameters({ sender: "a", "X-cc": ["b"], "X-n": 1 }),
    ).toEqual({ "X-cc": ["b"], "X-n": 1 });
    expect(userDefinedParameters({ sender: "a" })).toBeUndefined();
    expect(userDefinedParameters(null)).toBeUndefined();
  });
});

describe("A plan message with params", () => {
  it("carries them on every copy of a fan-out", async () => {
    const bus = new InMemoryMessageBus();
    const toB = silentPeer(bus, "b");
    const toC = silentPeer(bus, "c");
    const a = agent(bus, "a", [
      plan("tell", {
        messages: [
          {
            performative: "inform",
            receiver: ["b", "c"],
            content: { n: 1 },
            params: CC,
          },
        ],
      }),
    ]);
    await a.start();
    a.goals.add({ id: "g", name: "tell", priority: 5, status: "pending" });
    await run([a], 3);

    for (const m of [...toB, ...toC]) {
      expect(m["X-cc"]).toEqual(["dana"]);
      expect(m.receiver).toEqual(["b", "c"]);
    }
    expect(toB).toHaveLength(1);
    expect(toC).toHaveLength(1);
  });

  it("carries them on a topic message", async () => {
    const bus = new InMemoryMessageBus();
    const heard: Message[] = [];
    await bus.subscribe("news", (m) => heard.push(m));
    const a = agent(bus, "a", [
      plan("tell", {
        messages: [
          {
            performative: "inform",
            topic: "news",
            content: { n: 1 },
            params: CC,
          },
        ],
      }),
    ]);
    await a.start();
    a.goals.add({ id: "g", name: "tell", priority: 5, status: "pending" });
    await run([a], 3);

    expect(heard.map((m) => m["X-cc"])).toEqual([["dana"]]);
  });

  it("does not put them on the plan's other messages", async () => {
    const bus = new InMemoryMessageBus();
    const toB = silentPeer(bus, "b");
    const a = agent(bus, "a", [
      plan("tell", {
        messages: [
          { performative: "inform", receiver: "b", content: 1, params: CC },
          { performative: "inform", receiver: "b", content: 2 },
        ],
      }),
    ]);
    await a.start();
    a.goals.add({ id: "g", name: "tell", priority: 5, status: "pending" });
    await run([a], 3);

    expect(toB.map((m) => [m.content, m["X-cc"]])).toEqual([
      [1, ["dana"]],
      [2, undefined],
    ]);
  });

  it("fails the action, sending nothing, for a key that is not X-", async () => {
    const bus = new InMemoryMessageBus();
    const toB = silentPeer(bus, "b");
    const a = agent(bus, "a", [
      plan("tell", {
        messages: [
          {
            performative: "inform",
            receiver: "b",
            content: {},
            params: { sender: "mallory" } as never,
          },
        ],
      }),
    ]);
    const failures: string[] = [];
    a.on("intention:failed", (e) => failures.push(e.reason));
    await a.start();
    a.goals.add({ id: "g", name: "tell", priority: 5, status: "pending" });
    await run([a], 3);

    expect(toB).toEqual([]);
    expect(failures).toEqual([
      'message "inform": params key "sender" is not a user-defined (X-) parameter',
    ]);
  });
});

describe("A delegation with params", () => {
  it("carries them on the request to every receiver, for the receiver's plans to read, and no reply inherits them", async () => {
    const bus = new InMemoryMessageBus();
    const sources: (GoalSource | undefined)[] = [];
    const worker = (id: string): Agent =>
      agent(bus, id, [
        {
          goal: "pick",
          body: [
            {
              name: "read",
              execute: async (intention): Promise<ActionResult> => {
                sources.push(intention.goal.source);
                return {};
              },
            },
          ],
        },
      ]);
    const w1 = worker("w1");
    const w2 = worker("w2");
    const boss = agent(bus, "boss", [
      plan("ship", {
        delegations: [{ receiver: ["w1", "w2"], goal: "pick", params: CC }],
      }),
    ]);
    const fromBoss = sentBy(boss);
    const fromW1 = sentBy(w1);
    const fromW2 = sentBy(w2);
    for (const a of [boss, w1, w2]) await a.start();
    boss.goals.add({ id: "g", name: "ship", priority: 5, status: "pending" });
    await run([boss, w1, w2], 12);

    const requests = fromBoss.filter((m) => m.performative === "request");
    expect(requests).toHaveLength(2);
    for (const r of requests) expect(r["X-cc"]).toEqual(["dana"]);

    expect(sources.map((s) => s?.params)).toEqual([CC, CC]);

    // The workers answered (agree, inform), and neither answer carries them.
    const fromWorkers = [...fromW1, ...fromW2];
    expect(fromWorkers.map((m) => m.performative)).toContain("inform");
    for (const m of fromWorkers) {
      expect(userDefinedParameters(m)).toBeUndefined();
    }
  });

  it("gives a goal from a request with none no params", async () => {
    const bus = new InMemoryMessageBus();
    const sources: (GoalSource | undefined)[] = [];
    const w = agent(bus, "w", [
      {
        goal: "pick",
        body: [
          {
            name: "read",
            execute: async (intention): Promise<ActionResult> => {
              sources.push(intention.goal.source);
              return {};
            },
          },
        ],
      },
    ]);
    await w.start();
    await bus.send("w", {
      performative: "request",
      sender: "ui",
      receiver: "w",
      content: { goal: "pick" },
      timestamp: Date.now(),
    });
    await run([w], 4);

    expect(sources).toHaveLength(1);
    expect(sources[0]).not.toHaveProperty("params");
  });
});

describe("A call for proposals with params", () => {
  it("carries them on every cfp, but not on the award or the rejection", async () => {
    const bus = new InMemoryMessageBus();
    const received: Record<string, Message[]> = { cheap: [], dear: [] };
    for (const [id, price] of [
      ["cheap", 1],
      ["dear", 9],
    ] as const) {
      bus.registerAgent(id, (msg) => {
        received[id].push(msg);
        if (msg.performative !== "cfp") return;
        void bus.send(msg.sender, {
          performative: "propose",
          sender: id,
          receiver: msg.sender,
          content: { goal: "dig", terms: { price } },
          replyWith: `bid-${id}`,
          inReplyTo: msg.replyWith,
          timestamp: Date.now(),
        });
      });
    }
    const boss = agent(bus, "boss", [
      plan(
        "build",
        {
          calls: [
            {
              goal: "dig",
              receivers: ["cheap", "dear"],
              deadlineMs: 1000,
              params: CC,
            },
          ],
        },
        { awards: [{ proposal: "bid-cheap", timeoutMs: null }] },
      ),
    ]);
    await boss.start();
    boss.goals.add({ id: "g", name: "build", priority: 5, status: "pending" });
    await run([boss], 8);

    const all = [...received.cheap, ...received.dear];
    expect(all.map((m) => [m.performative, m["X-cc"]]).sort()).toEqual(
      [
        ["accept-proposal", undefined],
        ["cfp", ["dana"]],
        ["cfp", ["dana"]],
        ["reject-proposal", undefined],
      ].sort(),
    );
  });
});

describe("A proposal with params", () => {
  it("carries them on the propose to every receiver", async () => {
    const bus = new InMemoryMessageBus();
    const toP1 = silentPeer(bus, "p1");
    const toP2 = silentPeer(bus, "p2");
    const boss = agent(bus, "boss", [
      plan("offer", {
        proposals: [
          {
            receiver: ["p1", "p2"],
            goal: "approve",
            terms: {},
            params: CC,
          },
        ],
      }),
    ]);
    await boss.start();
    boss.goals.add({ id: "g", name: "offer", priority: 5, status: "pending" });
    await run([boss], 3);

    for (const m of [...toP1, ...toP2]) {
      expect(m.performative).toBe("propose");
      expect(m["X-cc"]).toEqual(["dana"]);
    }
    expect(toP1).toHaveLength(1);
    expect(toP2).toHaveLength(1);
  });
});

describe("A received message with params", () => {
  it("reaches the agent's listeners as it was sent", async () => {
    const bus = new InMemoryMessageBus();
    const a = agent(bus, "a", []);
    const heard: Message[] = [];
    a.on("message:received", (m: Message) => heard.push(m));
    await a.start();
    await bus.send("a", {
      performative: "inform",
      sender: "b",
      receiver: "a",
      content: {},
      "X-cc": ["dana"],
      timestamp: Date.now(),
    });
    await run([a], 2);

    expect(heard.map((m) => m["X-cc"])).toEqual([["dana"]]);
  });
});
