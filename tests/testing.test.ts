import { describe, it, expect } from "vitest";
import { InMemoryBeliefBase } from "../src/core/beliefs.js";
import { isOpenDelegation } from "../src/core/intentions.js";
import type { Plan, PlanFailure } from "../src/core/plans.js";
import {
  actionOf,
  fixtureIntention,
  runAction,
  runPlan,
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

describe("runPlan", () => {
  /** A plan that delegates "enrich" (to `receiver`, if given), then scores. */
  function enrichThenScore(receiver?: string): Plan {
    return {
      goal: "qualify",
      body: [
        {
          name: "prepare",
          execute: async (intention) => ({
            beliefUpdates: [{ key: "job", value: intention.goal.data }],
          }),
        },
        {
          name: "enrich",
          execute: async (_intention, beliefs) => ({
            delegations: [
              {
                goal: "enrich",
                ...(receiver !== undefined ? { receiver } : {}),
                view: { job: beliefs.get("job") },
              },
            ],
          }),
        },
        {
          name: "score",
          execute: async (intention) => ({
            result: {
              enriched: intention.delegations.find((d) => d.goal === "enrich")
                ?.result,
            },
          }),
        },
      ],
    };
  }

  it("runs every step and reports the goal's answer", async () => {
    const trace = await runPlan(enrichThenScore(), {
      data: 7,
      subGoals: { enrich: { result: { score: 3 } } },
    });
    expect(trace.outcome).toBe("achieved");
    expect(trace.steps.map((s) => s.action)).toEqual([
      "prepare",
      "enrich",
      "score",
    ]);
    expect(trace.result).toEqual({ enriched: { score: 3 } });
    expect(trace.beliefs.get("job")).toBe(7);
    expect(trace.delegations).toMatchObject([
      { goal: "enrich", status: "done", result: { score: 3 } },
    ]);
    expect(trace.goal).toMatchObject({ id: FIXTURE_GOAL_ID, data: 7 });
  });

  it("answers a delegation to another agent from a stub agent", async () => {
    const seen: Array<{ data: unknown; agent: string }> = [];
    const trace = await runPlan(enrichThenScore("enricher"), {
      data: 7,
      subGoals: {
        enrich: (data, { agent }) => {
          seen.push({ data, agent });
          return { result: { score: 4 } };
        },
      },
    });
    expect(trace.outcome).toBe("achieved");
    expect(trace.result).toEqual({ enriched: { score: 4 } });
    expect(seen).toEqual([
      { data: expect.objectContaining({ job: 7 }), agent: "enricher" },
    ]);
    expect(trace.messages).toContainEqual(
      expect.objectContaining({
        performative: "request",
        receiver: "enricher",
      }),
    );
  });

  it("fails the plan when a stubbed sub-goal fails, through onPlanFailure", async () => {
    const plan: Plan = {
      ...enrichThenScore(),
      onPlanFailure: (_intention, _beliefs, failure) => ({
        beliefUpdates: [{ key: "status", value: "failed" }],
        reason: `could not qualify: ${failure.reason}`,
      }),
    };
    const trace = await runPlan(plan, {
      subGoals: { enrich: { failure: { reason: "source down" } } },
    });
    expect(trace.outcome).toBe("failed");
    expect(trace.failure).toMatchObject({
      reason: 'could not qualify: sub-goal "enrich" failed: source down',
      cause: "delegation",
    });
    expect(trace.steps.map((s) => s.action)).toEqual(["prepare", "enrich"]);
    expect(trace.beliefs.get("status")).toBe("failed");
  });

  it("refuses a delegated goal with no stub, as the agent would", async () => {
    const trace = await runPlan(enrichThenScore("enricher"));
    expect(trace.outcome).toBe("failed");
    expect(trace.failure?.cause).toBe("delegation");
    expect(trace.delegations).toMatchObject([
      { goal: "enrich", receiver: "enricher", status: "failed" },
    ]);
  });

  it("reports a step that throws, and a hook that throws", async () => {
    const boom = new Error("boom");
    const trace = await runPlan({
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
    });
    expect(trace.outcome).toBe("failed");
    expect(trace.failure).toEqual({
      reason: "boom",
      cause: "action",
      action: "book",
      error: boom,
      onPlanFailureError: "hook broke",
    });
    expect(trace.steps).toEqual([]);
  });

  it("stops at a continueWith hand-off, with the answer so far", async () => {
    const trace = await runPlan(
      {
        goal: "page",
        body: [
          {
            name: "fetch",
            execute: async (intention) => ({
              result: { page: intention.goal.data },
              continueWith: { goal: "page", data: 2 },
            }),
          },
        ],
      },
      { data: 1 },
    );
    expect(trace.outcome).toBe("continued");
    expect(trace.continueWith).toEqual({ goal: "page", data: 2 });
    expect(trace.result).toEqual({ page: 1 });
    expect(trace.steps).toHaveLength(1);
  });

  it("fails a continueWith from a step that is not the last, as the agent does", async () => {
    const trace = await runPlan({
      goal: "page",
      body: [
        {
          name: "fetch",
          execute: async () => ({ continueWith: { goal: "page" } }),
        },
        { name: "never", execute: async () => ({}) },
      ],
    });
    expect(trace.outcome).toBe("failed");
    expect(trace.failure).toMatchObject({ cause: "action", action: "fetch" });
    expect(trace.failure?.reason).toContain("only valid from the last action");
  });

  it("reports a run that has not ended within maxCycles", async () => {
    const trace = await runPlan(enrichThenScore("enricher"), {
      subGoals: { enrich: { result: 1 } },
      maxCycles: 2,
    });
    expect(trace.outcome).toBe("unfinished");
    expect(trace.delegations.map((d) => [d.goal, isOpenDelegation(d)])).toEqual(
      [["enrich", true]],
    );
  });

  it("refuses to stub the plan's own goal", async () => {
    await expect(
      runPlan(enrichThenScore(), { subGoals: { qualify: {} } }),
    ).rejects.toThrow('subGoals cannot stub "qualify"');
  });
});
