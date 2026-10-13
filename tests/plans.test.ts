import { describe, it, expect } from "vitest";
import { PlanLibrary, planGoal, planServes } from "../src/core/plans.js";
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
    const plan: Plan = { name: "test", body: [] };
    lib.register(plan);

    expect(lib.match(makeGoal())?.name).toBe("test");
  });

  it("returns undefined when no plan serves the goal", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "other", body: [] });

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

    expect(planGoal(plan)).toBe("ship");
    expect(lib.declares("ship")).toBe(true);
    expect(lib.declares("ship-by-post")).toBe(false);
    expect(lib.match(makeGoal({ name: "ship" }))).toBe(plan);
    expect(lib.match(makeGoal({ name: "ship-by-post" }))).toBeUndefined();
  });

  it("serves its own name when a plan names no goal", () => {
    const plan: Plan = { name: "ship", body: [] };

    expect(planGoal(plan)).toBe("ship");
    expect(planServes(plan, "ship")).toBe(true);
  });

  it("lists every plan serving a goal, in registration order", () => {
    const lib = new PlanLibrary();
    const a: Plan = { name: "a", goal: "ship", body: [] };
    const b: Plan = { name: "ship", body: [] };
    const other: Plan = { name: "other", body: [] };
    for (const p of [a, other, b]) lib.register(p);

    expect(lib.serving("ship")).toEqual([a, b]);
    expect(lib.serving("nothing")).toEqual([]);
  });

  it("refuses a second plan of the same name, even for another goal", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "ship", body: [] });

    expect(() => lib.register({ name: "ship", body: [] })).toThrow(
      /already registered/,
    );
    expect(() =>
      lib.register({ name: "ship", goal: "deliver", body: [] }),
    ).toThrow(/already registered/);
    expect(lib.all()).toHaveLength(1);
  });

  it("declares a goal only when a plan is named for it", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "deploy", body: [] });

    expect(lib.declares("deploy")).toBe(true);
    expect(lib.declares("ship")).toBe(false);
  });

  it("serves a goal by name alone, with no other condition", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "test", body: [] });

    // There is no trigger to consult: a plan is the agent's capability, so a
    // matching name is always a match. Readiness is the body's business, and
    // a context only chooses among plans (see plan-context.test.ts).
    expect(lib.match(makeGoal())?.name).toBe("test");
  });

  it("lists every registered plan", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "a", body: [] });
    lib.register({ name: "b", body: [] });

    expect(lib.all().map((p) => p.name)).toEqual(["a", "b"]);
  });
});
