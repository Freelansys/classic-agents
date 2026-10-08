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
  it("accepts expressions of any return type in one library", () => {
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

    expect(lib.evaluate("risky", beliefs, msg({ threshold: 90 }))).toBe(true);
    expect(lib.evaluate("risky", beliefs, msg({ threshold: 99 }))).toBe(false);
    expect(lib.evaluate("name-of", beliefs, msg({ key: "ada" }))).toBe("ada");
    expect(lib.evaluate("profile", beliefs, msg({}))).toEqual({
      temp: 22.5,
    });
  });

  it("sees the whole naming message, not just its content", () => {
    const lib = new ExpressionLibrary();
    lib.register({
      name: "hailing",
      evaluate: (_b, message): string => message.sender ?? "unknown",
    });
    const beliefs = new InMemoryBeliefBase();
    expect(lib.evaluate("hailing", beliefs, msg({}))).toBe("sender-1");
  });

  it("returns undefined for an unregistered name", () => {
    const lib = new ExpressionLibrary();
    expect(
      lib.evaluate("nope", new InMemoryBeliefBase(), msg({})),
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

  it("lets a later registration replace an earlier one", () => {
    const lib = new ExpressionLibrary();
    lib.register({ name: "v", evaluate: () => "one" });
    lib.register({ name: "v", evaluate: () => "two" });
    expect(lib.evaluate("v", new InMemoryBeliefBase(), msg({}))).toBe("two");
  });

  it("is type-parameterised so evaluate stays typed", () => {
    const lib = new ExpressionLibrary<string>();
    lib.register({ name: "v", evaluate: () => "s" });
    expect(lib.evaluate("v", new InMemoryBeliefBase(), msg({}))).toBe("s");
  });
});

describe("PropositionLibrary", () => {
  it("evaluates boolean conditions against the belief base and message", () => {
    const lib = new PropositionLibrary();
    lib.register({
      name: "raining",
      evaluate: (b, message) =>
        b.get("weather.rain") === true &&
        (message.content as { above?: number }).above === undefined,
    });
    const beliefs = new InMemoryBeliefBase();
    beliefs.set("weather.rain", true);
    expect(lib.evaluate("raining", beliefs, msg({}))).toBe(true);
    expect(lib.evaluate("raining", beliefs, msg({ above: 12 }))).toBe(false);
    expect(lib.has("raining")).toBe(true);
  });

  it("accepts a Proposition, which is an Expression<boolean>", () => {
    const prop: Proposition = { name: "p", evaluate: () => true };
    const lib = new PropositionLibrary();
    lib.register(prop);
    expect(lib.evaluate("p", new InMemoryBeliefBase(), msg({}))).toBe(true);
  });

  it("returns undefined when no proposition of that name is registered", () => {
    const lib = new PropositionLibrary();
    expect(
      lib.evaluate("raining", new InMemoryBeliefBase(), msg({})),
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
