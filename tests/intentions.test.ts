import { describe, it, expect, beforeEach } from "vitest";
import {
  IntentionStack,
  createIntention,
  resetIntentionCounter,
} from "../src/core/intentions.js";
import type { Goal } from "../src/core/goals.js";
import type { Plan } from "../src/core/plans.js";

function makeGoal(): Goal {
  return { id: "g1", name: "test", priority: 5, status: "active" };
}

function makePlan(bodyLength = 3): Plan {
  return {
    name: "test-plan",
    trigger: () => true,
    body: Array.from({ length: bodyLength }, (_, i) => ({
      name: `action-${i}`,
      execute: async () => ({}),
    })),
  };
}

describe("IntentionStack", () => {
  beforeEach(() => {
    resetIntentionCounter();
  });

  it("pushes and retrieves intentions", () => {
    const stack = new IntentionStack();
    const intention = createIntention(makeGoal(), makePlan());
    stack.push(intention);
    expect(stack.get(intention.id)).toBe(intention);
  });

  it("getActive returns only active intentions", () => {
    const stack = new IntentionStack();
    const i1 = createIntention(makeGoal(), makePlan());
    i1.status = "executing";
    const i2 = createIntention(makeGoal(), makePlan());
    i2.status = "completed";

    stack.push(i1);
    stack.push(i2);

    expect(stack.getActive()).toHaveLength(1);
    expect(stack.getActive()[0].id).toBe(i1.id);
  });

  it("advances action index", () => {
    const stack = new IntentionStack();
    const intention = createIntention(makeGoal(), makePlan());
    stack.push(intention);

    expect(intention.actionIndex).toBe(0);
    stack.advance(intention.id);
    expect(intention.actionIndex).toBe(1);
  });

  it("completes an intention", () => {
    const stack = new IntentionStack();
    const intention = createIntention(makeGoal(), makePlan());
    stack.push(intention);

    stack.complete(intention.id, {
      beliefUpdates: [{ key: "done", value: true }],
    });
    expect(intention.status).toBe("completed");
    expect(intention.result?.beliefUpdates).toHaveLength(1);
  });

  it("fails an intention", () => {
    const stack = new IntentionStack();
    const intention = createIntention(makeGoal(), makePlan());
    stack.push(intention);

    stack.fail(intention.id, "something broke");
    expect(intention.status).toBe("failed");
    expect(intention.failureReason).toBe("something broke");
  });

  it("removes an intention", () => {
    const stack = new IntentionStack();
    const intention = createIntention(makeGoal(), makePlan());
    stack.push(intention);
    stack.remove(intention.id);
    expect(stack.get(intention.id)).toBeUndefined();
  });

  it("indexes intentions by status and by goal", () => {
    const stack = new IntentionStack();
    const goalA = { ...makeGoal(), id: "gA" };
    const goalB = { ...makeGoal(), id: "gB" };
    const running = createIntention(goalA, makePlan());
    const alsoRunning = createIntention(goalA, makePlan());
    const waiting = createIntention(goalB, makePlan());

    stack.push(running);
    stack.push(alsoRunning);
    stack.push(waiting);
    stack.setStatus(waiting.id, "waiting");
    stack.setStatus(alsoRunning.id, "executing");

    expect(stack.getByStatus("pending")).toEqual([running]);
    expect(stack.getByStatus("executing")).toEqual([alsoRunning]);
    expect(stack.getByStatus("waiting")).toEqual([waiting]);
    expect(stack.getByGoal("gA")).toEqual([running, alsoRunning]);
    // A waiting intention is held, not runnable: it is waiting on a sub-goal.
    expect(stack.getRunnable()).toEqual([running, alsoRunning]);
  });

  it("keeps the status index in step with the intentions", () => {
    const stack = new IntentionStack();
    const intention = createIntention(makeGoal(), makePlan());
    stack.push(intention);

    stack.setStatus(intention.id, "executing");
    expect(stack.getByStatus("executing")).toEqual([intention]);
    expect(stack.getByStatus("pending")).toEqual([]);

    stack.remove(intention.id);
    expect(stack.getByStatus("executing")).toEqual([]);
    expect(stack.getByGoal(intention.goal.id)).toEqual([]);
  });

  it("collects finished intentions on flush, keeping the rest", () => {
    const stack = new IntentionStack();
    const removed: string[] = [];
    stack.on("intentionRemoved", (i) => removed.push(i.id));
    const done = createIntention(makeGoal(), makePlan());
    const live = createIntention(makeGoal(), makePlan());
    stack.push(done);
    stack.push(live);

    stack.complete(done.id, {});
    expect(stack.getAll()).toHaveLength(2);

    stack.flush();
    expect(removed).toEqual([done.id]);
    expect(stack.getAll()).toEqual([live]);
  });
});
