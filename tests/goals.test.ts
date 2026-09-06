import { describe, it, expect } from "vitest";
import { GoalQueue, defaultGoalSelection } from "../src/core/goals.js";
import type { Goal } from "../src/core/goals.js";

describe("GoalQueue", () => {
  it("adds and retrieves goals", () => {
    const q = new GoalQueue();
    q.add<unknown>({ id: "g1", name: "test", priority: 5, status: "pending" });
    expect(q.get("g1")).toBeDefined();
    expect(q.get("g1")?.name).toBe("test");
  });

  it("selects highest priority pending goal", () => {
    const q = new GoalQueue();
    q.add({ id: "g1", name: "low", priority: 1, status: "pending" });
    q.add({ id: "g2", name: "high", priority: 10, status: "pending" });

    const next = q.selectNext();
    expect(next?.name).toBe("high");
  });

  it("skips goals already pursued by active intentions", () => {
    const q = new GoalQueue();
    q.add({ id: "g1", name: "task", priority: 5, status: "pending" });
    q.add({ id: "g2", name: "task", priority: 10, status: "active" });

    const next = q.selectNext();
    expect(next).toBeUndefined();
  });

  it("updates goal status", () => {
    const q = new GoalQueue();
    q.add({ id: "g1", name: "test", priority: 5, status: "pending" });
    q.setStatus("g1", "achieved");
    expect(q.get("g1")?.status).toBe("achieved");
  });

  it("getByStatus filters correctly", () => {
    const q = new GoalQueue();
    q.add({ id: "g1", name: "a", priority: 1, status: "pending" });
    q.add({ id: "g2", name: "b", priority: 1, status: "active" });
    q.add({ id: "g3", name: "c", priority: 1, status: "pending" });

    expect(q.getByStatus("pending")).toHaveLength(2);
    expect(q.getByStatus("active")).toHaveLength(1);
  });

  it("removes goals", () => {
    const q = new GoalQueue();
    q.add({ id: "g1", name: "test", priority: 5, status: "pending" });
    q.remove("g1");
    expect(q.get("g1")).toBeUndefined();
  });

  it("accepts custom selection function", () => {
    const selectLowest: typeof defaultGoalSelection = (pending) => {
      return pending.sort((a, b) => a.priority - b.priority)[0];
    };

    const q = new GoalQueue(selectLowest);
    q.add({ id: "g1", name: "high", priority: 10, status: "pending" });
    q.add({ id: "g2", name: "low", priority: 1, status: "pending" });

    expect(q.selectNext()?.name).toBe("low");
  });
});
