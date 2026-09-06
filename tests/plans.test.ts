import { describe, it, expect } from "vitest";
import { PlanLibrary } from "../src/core/plans.js";
import { BeliefBase } from "../src/core/beliefs.js";
import type { Goal } from "../src/core/goals.js";
import type { Action, ActionResult, Plan } from "../src/core/plans.js";

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
  it("finds an applicable plan", () => {
    const lib = new PlanLibrary();
    const plan: Plan = {
      name: "always",
      trigger: () => true,
      body: [],
    };
    lib.register(plan);

    const found = lib.findApplicable(new BeliefBase(), makeGoal());
    expect(found?.name).toBe("always");
  });

  it("returns undefined when no plan matches", () => {
    const lib = new PlanLibrary();
    lib.register({
      name: "never",
      trigger: () => false,
      body: [],
    });

    expect(lib.findApplicable(new BeliefBase(), makeGoal())).toBeUndefined();
  });

  it("returns all matching plans", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "plan-a", trigger: () => true, body: [] });
    lib.register({ name: "plan-b", trigger: () => true, body: [] });
    lib.register({ name: "plan-c", trigger: () => false, body: [] });

    const found = lib.findAll(new BeliefBase(), makeGoal());
    expect(found).toHaveLength(2);
  });

  it("plans trigger based on beliefs", () => {
    const lib = new PlanLibrary();
    lib.register({
      name: "belief-plan",
      trigger: (beliefs) => beliefs.has("ready"),
      body: [],
    });

    const bb = new BeliefBase();
    expect(lib.findApplicable(bb, makeGoal())).toBeUndefined();

    bb.set("ready", true);
    expect(lib.findApplicable(bb, makeGoal())?.name).toBe("belief-plan");
  });
});
