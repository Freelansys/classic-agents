import { describe, it, expect } from "vitest";
import { PlanLibrary } from "../src/core/plans.js";
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
    lib.register({ name: "test", body: [] });
    lib.register({ name: "test", body: [] });

    // Selection is an RPC by name, so ties fall to registration order — the
    // hook a variant uses to take precedence.
    expect(lib.match(makeGoal())).toBe(lib.all()[0]);
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
    // matching name is always a match. Readiness is the body's business.
    expect(lib.match(makeGoal())?.name).toBe("test");
  });

  it("lists every registered plan", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "a", body: [] });
    lib.register({ name: "b", body: [] });

    expect(lib.all().map((p) => p.name)).toEqual(["a", "b"]);
  });
});
