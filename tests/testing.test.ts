import { describe, it, expect } from "vitest";
import { InMemoryBeliefBase } from "../src/core/beliefs.js";
import type { Plan, PlanFailure } from "../src/core/plans.js";
import {
  actionOf,
  fixtureIntention,
  runAction,
  FIXTURE_AGENT_ID,
  FIXTURE_GOAL_ID,
  FIXTURE_INTENTION_ID,
} from "../src/testing/index.js";

const review: Plan = {
  name: "review-by-hand",
  goal: "review",
  body: [
    {
      name: "fetch",
      execute: async (intention) => ({
        beliefUpdates: [{ key: "fetched", value: intention.goal.data }],
      }),
    },
    {
      name: "score",
      execute: async (intention, beliefs) => ({
        result: {
          step: intention.actionIndex,
          enriched: intention.delegations.find((d) => d.goal === "enrich")
            ?.result,
          threshold: beliefs.get("threshold"),
        },
        beliefRemovals: ["fetched"],
      }),
    },
  ],
};

describe("fixtureIntention", () => {
  it("defaults every field, with fixed ids", () => {
    const intention = fixtureIntention(review, { data: { id: 7 } });
    expect(intention).toEqual({
      id: FIXTURE_INTENTION_ID,
      goal: {
        id: FIXTURE_GOAL_ID,
        name: "review",
        priority: 5,
        status: "active",
        data: { id: 7 },
        rootGoalId: FIXTURE_GOAL_ID,
      },
      plan: review,
      actionIndex: 0,
      status: "executing",
      children: [],
      delegations: [],
      childFailures: [],
      calls: [],
    });
  });

  it("records sub-goal results as done self-delegations", () => {
    const intention = fixtureIntention(review, {
      results: { enrich: { score: 3 } },
      delegations: [
        { goal: "enrich", status: "failed", reason: "down" },
        { goal: "audit", status: "agreed" },
      ],
    });
    expect(intention.delegations).toEqual([
      {
        receiver: FIXTURE_AGENT_ID,
        goal: "enrich",
        status: "done",
        goalId: `${FIXTURE_GOAL_ID}-1`,
        result: { score: 3 },
      },
      {
        receiver: FIXTURE_AGENT_ID,
        goal: "enrich",
        status: "failed",
        goalId: `${FIXTURE_GOAL_ID}-2`,
        reason: "down",
      },
      {
        receiver: FIXTURE_AGENT_ID,
        goal: "audit",
        status: "agreed",
        goalId: `${FIXTURE_GOAL_ID}-3`,
      },
    ]);
    // Only the open self-delegation is still waited for.
    expect(intention.children).toEqual([`${FIXTURE_GOAL_ID}-3`]);
  });

  it("lets the goal be overridden", () => {
    const intention = fixtureIntention(review, {
      goal: { id: "g1", parentGoalId: "g0", rootGoalId: "g0", priority: 9 },
    });
    expect(intention.goal).toMatchObject({
      id: "g1",
      name: "review",
      parentGoalId: "g0",
      rootGoalId: "g0",
      priority: 9,
    });
  });
});

describe("actionOf", () => {
  it("finds a step by name", () => {
    expect(actionOf(review, "score")).toBe(review.body[1]);
  });

  it("throws on a missing name, listing the steps", () => {
    expect(() => actionOf(review, "rank")).toThrow(
      'plan "review-by-hand" has no step named "rank"; its steps are "fetch", "score"',
    );
  });

  it("throws on a name two steps share", () => {
    const step = review.body[0]!;
    expect(() =>
      actionOf({ goal: "twice", body: [step, step] }, "fetch"),
    ).toThrow('plan "twice" has 2 steps named "fetch"');
  });
});

describe("runAction", () => {
  it("runs the named step at its index, with results and beliefs", async () => {
    const { result, failure, beliefs } = await runAction(review, "score", {
      beliefs: { threshold: 0.5, fetched: true },
      results: { enrich: { score: 3 } },
    });
    expect(failure).toBeUndefined();
    expect(result?.result).toEqual({
      step: 1,
      enriched: { score: 3 },
      threshold: 0.5,
    });
    // The action's removals are applied, as the agent applies them.
    expect(beliefs.has("fetched")).toBe(false);
  });

  it("writes to a belief base it is given", async () => {
    const beliefs = new InMemoryBeliefBase();
    const outcome = await runAction(review, "fetch", { data: 42, beliefs });
    expect(outcome.beliefs).toBe(beliefs);
    expect(beliefs.get("fetched")).toBe(42);
  });

  it("runs onPlanFailure on a reported failure and applies its effects", async () => {
    const seen: Array<{ failure: PlanFailure; status: unknown }> = [];
    const plan: Plan = {
      goal: "ship",
      body: [
        {
          name: "book",
          execute: async () => ({
            beliefUpdates: [{ key: "status", value: "booking" }],
            failure: { reason: "no courier" },
          }),
        },
      ],
      onPlanFailure: (_intention, beliefs, failure) => {
        seen.push({ failure, status: beliefs.get("status") });
        return {
          beliefUpdates: [{ key: "status", value: "failed" }],
          messages: [{ receiver: "ops", performative: "inform", content: {} }],
          reason: "shipping unavailable",
        };
      },
    };
    const { result, failure, beliefs } = await runAction(plan, "book");

    expect(result?.failure).toEqual({ reason: "no courier" });
    // The hook sees the action's belief updates, as it does in the agent.
    expect(seen).toEqual([
      {
        failure: { reason: "no courier", cause: "action", action: "book" },
        status: "booking",
      },
    ]);
    expect(failure).toMatchObject({
      reason: "shipping unavailable",
      originalReason: "no courier",
      cause: "action",
      action: "book",
      hookResult: {
        messages: [{ receiver: "ops", performative: "inform", content: {} }],
      },
    });
    expect(beliefs.get("status")).toBe("failed");
  });

  it("turns a throw into a failure, and reports a hook that throws", async () => {
    const boom = new Error("boom");
    const plan: Plan = {
      goal: "ship",
      body: [
        {
          name: "book",
          execute: async () => {
            throw boom;
          },
        },
      ],
      onPlanFailure: () => {
        throw new Error("hook broke");
      },
    };
    const { result, failure } = await runAction(plan, "book");
    expect(result).toBeUndefined();
    expect(failure).toMatchObject({
      reason: "boom",
      originalReason: "boom",
      cause: "action",
      action: "book",
      error: boom,
      hookError: "hook broke",
    });
    expect(failure?.hookResult).toBeUndefined();
  });

  it("reports a failure with no hook as the action's", async () => {
    const plan: Plan = {
      goal: "ship",
      body: [
        {
          name: "book",
          execute: async () => ({ failure: { reason: "no courier" } }),
        },
      ],
    };
    const { failure } = await runAction(plan, "book");
    expect(failure).toEqual({
      reason: "no courier",
      originalReason: "no courier",
      cause: "action",
      action: "book",
    });
  });
});
