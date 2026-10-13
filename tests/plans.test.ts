import { describe, it, expect } from "vitest";
import { PlanLibrary, planName, planServes } from "../src/core/plans.js";
import type { Goal } from "../src/core/goals.js";
import type { Plan } from "../src/core/plans.js";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    name: "test",
    priority: 5,
    status: "pending",
    ...overrides,
  };
}

describe("PlanLibrary", () => {
  it("finds the plan that serves a goal by name", () => {
    const lib = new PlanLibrary();
    const plan: Plan = { goal: "test", body: [] };
    lib.register(plan);

    expect(planName(lib.match(makeGoal())!)).toBe("test");
  });

  it("returns undefined when no plan serves the goal", () => {
    const lib = new PlanLibrary();
    lib.register({ goal: "other", body: [] });

    expect(lib.match(makeGoal())).toBeUndefined();
  });

  it("returns the first plan when several serve the same goal", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "first", goal: "test", body: [] });
    lib.register({ name: "second", goal: "test", body: [] });

    // `match` ignores context, so ties fall to registration order — the
    // order `applicable` also prefers plans in.
    expect(lib.match(makeGoal())).toBe(lib.all()[0]);
  });

  it("serves the goal a plan names, apart from its own name", () => {
    const lib = new PlanLibrary();
    const plan: Plan = { name: "ship-by-post", goal: "ship", body: [] };
    lib.register(plan);

    expect(planServes(plan, "ship")).toBe(true);
    expect(planServes(plan, "ship-by-post")).toBe(false);
    expect(lib.declares("ship")).toBe(true);
    expect(lib.declares("ship-by-post")).toBe(false);
    expect(lib.match(makeGoal({ name: "ship" }))).toBe(plan);
    expect(lib.match(makeGoal({ name: "ship-by-post" }))).toBeUndefined();
  });

  it("lists every plan serving a goal, in registration order", () => {
    const lib = new PlanLibrary();
    const a: Plan = { name: "a", goal: "ship", body: [] };
    const b: Plan = { goal: "ship", body: [] };
    const other: Plan = { goal: "other", body: [] };
    for (const p of [a, other, b]) lib.register(p);

    expect(lib.serving("ship")).toEqual([a, b]);
    expect(lib.serving("nothing")).toEqual([]);
  });

  it("refuses a second plan of the same name, even for another goal", () => {
    const lib = new PlanLibrary();
    lib.register({ goal: "ship", body: [] });

    expect(() => lib.register({ goal: "ship", body: [] })).toThrow(
      /already registered/,
    );
    expect(() =>
      lib.register({ name: "ship", goal: "deliver", body: [] }),
    ).toThrow(/already registered/);
    expect(lib.all()).toHaveLength(1);
  });

  it("names a plan after its goal when it has no name of its own", () => {
    expect(planName({ goal: "ship", body: [] })).toBe("ship");
    expect(planName({ name: "by-post", goal: "ship", body: [] })).toBe(
      "by-post",
    );
  });

  it("refuses a second unnamed plan for the same goal", () => {
    const lib = new PlanLibrary();
    lib.register({ goal: "ship", body: [] });

    // Both would be called "ship": a goal's plans after the first need names.
    expect(() => lib.register({ goal: "ship", body: [] })).toThrow(
      /a plan named "ship" is already registered/,
    );
    // A named alternative alongside the unnamed plan is fine.
    lib.register({ name: "ship-by-post", goal: "ship", body: [] });
    expect(lib.serving("ship").map(planName)).toEqual(["ship", "ship-by-post"]);
  });

  it("declares a goal only when a plan is named for it", () => {
    const lib = new PlanLibrary();
    lib.register({ goal: "deploy", body: [] });

    expect(lib.declares("deploy")).toBe(true);
    expect(lib.declares("ship")).toBe(false);
  });

  it("serves a goal by name alone, with no other condition", () => {
    const lib = new PlanLibrary();
    lib.register({ goal: "test", body: [] });

    // There is no trigger to consult: a plan is the agent's capability, so a
    // matching name is always a match. Readiness is the body's business, and
    // a context only chooses among plans (see plan-context.test.ts).
    expect(planName(lib.match(makeGoal())!)).toBe("test");
  });

  it("lists every registered plan", () => {
    const lib = new PlanLibrary();
    lib.register({ goal: "a", body: [] });
    lib.register({ goal: "b", body: [] });

    expect(lib.all().map(planName)).toEqual(["a", "b"]);
  });
});
