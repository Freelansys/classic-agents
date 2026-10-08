import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import {
  Agent,
  PlanLibrary,
  ExpressionLibrary,
  PropositionLibrary,
} from "../src/core/index.js";
import type { Proposition } from "../src/core/index.js";
import { InMemoryBeliefBase } from "../src/core/beliefs.js";

function msg(content: unknown): Message {
  return {
    performative: "request",
    sender: "sender-1",
    receiver: "a1",
    content,
    timestamp: Date.now(),
  };
}

describe("ExpressionLibrary", () => {
  it("accepts expressions of any return type in one library", async () => {
    const lib = new ExpressionLibrary();
    lib.register({
      name: "risky",
      evaluate: (b, message) => {
        const threshold =
          (message.content as { threshold?: number }).threshold ?? 80;
        return (b.get<number>("risk.score") ?? 0) > threshold;
      },
    });
    lib.register({
      name: "name-of",
      evaluate: (_b, message) =>
        String((message.content as { key?: string }).key),
    });
    lib.register({
      name: "profile",
      evaluate: (b) => ({ temp: b.get("msg.temperature") }),
    });

    const beliefs = new InMemoryBeliefBase();
    beliefs.set("risk.score", 95);
    beliefs.set("msg.temperature", 22.5);

    expect(await lib.evaluate("risky", beliefs, msg({ threshold: 90 }))).toBe(
      true,
    );
    expect(await lib.evaluate("risky", beliefs, msg({ threshold: 99 }))).toBe(
      false,
    );
    expect(await lib.evaluate("name-of", beliefs, msg({ key: "ada" }))).toBe(
      "ada",
    );
    expect(await lib.evaluate("profile", beliefs, msg({}))).toEqual({
      temp: 22.5,
    });
  });

  it("sees the whole naming message, not just its content", async () => {
    const lib = new ExpressionLibrary();
    lib.register({
      name: "hailing",
      evaluate: (_b, message): string => message.sender ?? "unknown",
    });
    const beliefs = new InMemoryBeliefBase();
    expect(await lib.evaluate("hailing", beliefs, msg({}))).toBe("sender-1");
  });

  it("awaits an async expression, as when judging by a model", async () => {
    const lib = new ExpressionLibrary();
    lib.register({
      name: "judged-by-model",
      evaluate: async (_b, message): Promise<boolean> => {
        const { judgement } = message.content as { judgement?: boolean };
        await new Promise((resolve) => setTimeout(resolve, 1));
        return judgement === true;
      },
    });
    const beliefs = new InMemoryBeliefBase();
    expect(
      await lib.evaluate("judged-by-model", beliefs, msg({ judgement: true })),
    ).toBe(true);
    expect(
      await lib.evaluate("judged-by-model", beliefs, msg({ judgement: false })),
    ).toBe(false);
  });

  it("returns undefined for an unregistered name", async () => {
    const lib = new ExpressionLibrary();
    expect(
      await lib.evaluate("nope", new InMemoryBeliefBase(), msg({})),
    ).toBeUndefined();
  });

  it("reports whether a name is registered", () => {
    const lib = new ExpressionLibrary();
    lib.register({ name: "a", evaluate: () => 1 });
    expect(lib.has("a")).toBe(true);
    expect(lib.has("b")).toBe(false);
  });

  it("lists registered expressions in registration order", () => {
    const lib = new ExpressionLibrary();
    lib.register({ name: "a", evaluate: () => 1 });
    lib.register({ name: "b", evaluate: () => 2 });
    expect(lib.all().map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("lets a later registration replace an earlier one", async () => {
    const lib = new ExpressionLibrary();
    lib.register({ name: "v", evaluate: () => "one" });
    lib.register({ name: "v", evaluate: () => "two" });
    expect(await lib.evaluate("v", new InMemoryBeliefBase(), msg({}))).toBe(
      "two",
    );
  });

  it("is type-parameterised so evaluate stays typed", async () => {
    const lib = new ExpressionLibrary<string>();
    lib.register({ name: "v", evaluate: () => "s" });
    const result = await lib.evaluate("v", new InMemoryBeliefBase(), msg({}));
    expect(result).toBe("s");
  });
});

describe("PropositionLibrary", () => {
  it("evaluates boolean conditions against the belief base and message", async () => {
    const lib = new PropositionLibrary();
    lib.register({
      name: "raining",
      evaluate: (b, message) =>
        b.get("weather.rain") === true &&
        (message.content as { above?: number }).above === undefined,
    });
    const beliefs = new InMemoryBeliefBase();
    beliefs.set("weather.rain", true);
    expect(await lib.evaluate("raining", beliefs, msg({}))).toBe(true);
    expect(await lib.evaluate("raining", beliefs, msg({ above: 12 }))).toBe(
      false,
    );
    expect(lib.has("raining")).toBe(true);
  });

  it("accepts a Proposition, which is an Expression<boolean>", async () => {
    const prop: Proposition = { name: "p", evaluate: () => true };
    const lib = new PropositionLibrary();
    lib.register(prop);
    expect(await lib.evaluate("p", new InMemoryBeliefBase(), msg({}))).toBe(
      true,
    );
  });

  it("returns undefined when no proposition of that name is registered", async () => {
    const lib = new PropositionLibrary();
    expect(
      await lib.evaluate("raining", new InMemoryBeliefBase(), msg({})),
    ).toBeUndefined();
  });
});

describe("Wiring into an Agent", () => {
  it("exposes the configured libraries", () => {
    const bus = new InMemoryMessageBus();
    const expressions = new ExpressionLibrary();
    const propositions = new PropositionLibrary();
    const agent = new Agent({
      id: "a1",
      bus,
      planLibrary: new PlanLibrary(),
      expressionLibrary: expressions,
      propositionLibrary: propositions,
    });
    expect(agent.expressionLibrary).toBe(expressions);
    expect(agent.propositionLibrary).toBe(propositions);
  });

  it("gives the agent empty libraries by default", () => {
    const bus = new InMemoryMessageBus();
    const agent = new Agent({ id: "a1", bus, planLibrary: new PlanLibrary() });
    expect(agent.expressionLibrary.all()).toEqual([]);
    expect(agent.propositionLibrary.all()).toEqual([]);
  });
});
