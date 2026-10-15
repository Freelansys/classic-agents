import { describe, it, expect } from "vitest";
import { GoalQueue } from "../src/core/goals.js";
import type { Goal } from "../src/core/goals.js";
import { Trigger } from "../src/core/trigger.js";

function goal(id: string): Goal {
  return { id, name: "g", priority: 5, status: "pending" };
}

describe("Trigger", () => {
  it("is due on a rising edge, including the first observation", () => {
    const goals = new GoalQueue();
    const t = new Trigger({ mode: "edge" });
    expect(t.observe(true)).toEqual({ rose: true, fell: false });
    expect(t.ready(goals)).toBe(true);
    t.fired(undefined);

    // Still holding: no new edge.
    t.observe(true);
    expect(t.ready(goals)).toBe(false);

    expect(t.observe(false)).toEqual({ rose: false, fell: true });
    t.observe(true);
    expect(t.ready(goals)).toBe(true);
  });

  it("holds an edge it could not fire, even after the condition falls", () => {
    const goals = new GoalQueue(undefined, { maxGoals: 1 });
    goals.add(goal("busy"));
    const t = new Trigger({ mode: "edge" });
    t.observe(true);
    t.observe(false);
    expect(t.ready(goals)).toBe(false);

    goals.setStatus("busy", "achieved");
    expect(t.ready(goals)).toBe(true);
  });

  it("in level mode is due while it holds, one goal at a time", () => {
    const goals = new GoalQueue();
    const t = new Trigger({ mode: "level", oneInFlight: true });
    t.observe(true);
    expect(t.ready(goals)).toBe(true);
    goals.add(goal("g1"));
    t.fired(goals.get("g1"));

    t.observe(true);
    expect(t.ready(goals)).toBe(false);
    expect(t.outstanding()?.id).toBe("g1");

    goals.setStatus("g1", "achieved");
    expect(t.ready(goals)).toBe(true);

    t.observe(false);
    expect(t.ready(goals)).toBe(false);
  });

  it("waits retryAfterMs after a fired goal failed", () => {
    const goals = new GoalQueue();
    const t = new Trigger({
      mode: "level",
      oneInFlight: true,
      retryAfterMs: 100,
    });
    t.observe(true);
    goals.add(goal("g1"));
    t.fired(goals.get("g1"));
    goals.setStatus("g1", "failed");

    expect(t.ready(goals, 1_000)).toBe(false);
    expect(t.ready(goals, 1_099)).toBe(false);
    expect(t.ready(goals, 1_100)).toBe(true);
  });
});
