import { describe, it, expect } from "vitest";
import { PlanLibrary } from "../src/core/plans.js";
import { InMemoryBeliefBase } from "../src/core/beliefs.js";
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
      can: "test",
      trigger: () => true,
      body: [],
    };
    lib.register(plan);

    const found = lib.findApplicable(new InMemoryBeliefBase(), makeGoal());
    expect(found?.name).toBe("always");
  });

  it("returns undefined when no plan matches", () => {
    const lib = new PlanLibrary();
    lib.register({
      name: "never",
      can: "test",
      trigger: () => false,
      body: [],
    });

    expect(
      lib.findApplicable(new InMemoryBeliefBase(), makeGoal()),
    ).toBeUndefined();
  });

  it("returns all matching plans", () => {
    const lib = new PlanLibrary();
    lib.register({
      name: "plan-a",
      can: "test",
      trigger: () => true,
      body: [],
    });
    lib.register({
      name: "plan-b",
      can: "test",
      trigger: () => true,
      body: [],
    });
    lib.register({
      name: "plan-c",
      can: "test",
      trigger: () => false,
      body: [],
    });

    const found = lib.findAll(new InMemoryBeliefBase(), makeGoal());
    expect(found).toHaveLength(2);
  });

  it("plans trigger based on beliefs", () => {
    const lib = new PlanLibrary();
    lib.register({
      name: "belief-plan",
      can: "test",
      trigger: (beliefs) => beliefs.has("ready"),
      body: [],
    });

    const bb = new InMemoryBeliefBase();
    expect(lib.findApplicable(bb, makeGoal())).toBeUndefined();

    bb.set("ready", true);
    expect(lib.findApplicable(bb, makeGoal())?.name).toBe("belief-plan");
  });

  it("defaults respondTo to the plan's own name", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "deploy", trigger: () => true, body: [] });

    expect(lib.declares("deploy")).toBe(true);
    expect(lib.declares("ship")).toBe(false);
    expect(
      lib.findApplicable(new InMemoryBeliefBase(), makeGoal({ name: "deploy" }))
        ?.name,
    ).toBe("deploy");
  });

  it("declares statically, without running any trigger", () => {
    const lib = new PlanLibrary();
    let calls = 0;
    lib.register({
      name: "ship",
      can: "ship",
      trigger: () => {
        calls++;
        return false;
      },
      body: [],
    });

    // The distinction that makes declining honest: "no plan could ever do this"
    // is knowable without asking a trigger that may be waiting on a belief.
    expect(lib.declares("ship")).toBe(true);
    expect(lib.declares("deploy")).toBe(false);
    expect(calls).toBe(0);
  });

  it("ignores plans that do not declare the goal", () => {
    const lib = new PlanLibrary();
    lib.register({ name: "always", trigger: () => true, body: [] });

    // A plan that fires for a goal it never claimed to serve is not evidence
    // that this agent can do the work.
    expect(lib.declares("other")).toBe(false);
    expect(
      lib.findApplicable(new InMemoryBeliefBase(), makeGoal()),
    ).toBeUndefined();
  });
});
