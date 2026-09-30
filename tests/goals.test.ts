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

  it("keeps the source of a message-origin goal", () => {
    const q = new GoalQueue();
    const source = { sender: "ui", conversationId: "chat-1" };
    q.add<unknown>({
      id: "g1",
      name: "deploy",
      priority: 5,
      status: "pending",
      source,
    });

    expect(q.get("g1")?.source).toEqual(source);
  });

  it("leaves source unset on directly added goals", () => {
    const q = new GoalQueue();
    const goal: Goal = {
      id: "g1",
      name: "deploy",
      priority: 5,
      status: "pending",
    };
    q.add(goal);

    expect(q.get("g1")?.source).toBeUndefined();
    expect(q.get("g1")).not.toHaveProperty("source");
  });
});

describe("GoalQueue events", () => {
  it("reports every goal added, with the status it was stored with", () => {
    const q = new GoalQueue();
    const added: Goal[] = [];
    q.on("goalAdded", (goal) => added.push({ ...goal }));

    q.add({ id: "g1", name: "a", priority: 1, status: "pending" });
    q.add({ id: "g2", name: "b", priority: 2, status: "active" });

    expect(added).toEqual([
      { id: "g1", name: "a", priority: 1, status: "pending" },
      { id: "g2", name: "b", priority: 2, status: "active" },
    ]);
  });

  it("reports sub-goals added by an action's result", () => {
    const q = new GoalQueue();
    const added: Goal[] = [];
    q.on("goalAdded", (goal) => added.push({ ...goal }));

    q.add({
      id: "g-child",
      name: "build",
      priority: 10,
      status: "pending",
      parentGoalId: "g-parent",
      rootGoalId: "g-parent",
    });

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      id: "g-child",
      parentGoalId: "g-parent",
      rootGoalId: "g-parent",
    });
  });

  it("reports the goal a status change happened to", () => {
    const q = new GoalQueue();
    q.add({ id: "g1", name: "deploy", priority: 5, status: "pending" });

    const changed: Goal[] = [];
    q.on("goalStatusChanged", (goal) => changed.push({ ...goal }));
    q.setStatus("g1", "active");
    q.setStatus("g1", "achieved");

    expect(changed).toEqual([
      { id: "g1", name: "deploy", priority: 5, status: "active" },
      { id: "g1", name: "deploy", priority: 5, status: "achieved" },
    ]);
  });

  it("says nothing about a goal that is not in the queue", () => {
    const q = new GoalQueue();
    const changed: Goal[] = [];
    q.on("goalStatusChanged", (goal) => changed.push(goal));

    q.setStatus("missing", "achieved");

    expect(changed).toHaveLength(0);
  });

  it("hands out the queue's live goal, so handlers that store it see later changes", () => {
    const q = new GoalQueue();
    const added: Goal[] = [];
    const changed: Goal[] = [];
    q.on("goalAdded", (goal) => added.push(goal));
    q.on("goalStatusChanged", (goal) => changed.push(goal));

    const callerGoal: Goal = {
      id: "g1",
      name: "deploy",
      priority: 5,
      status: "pending",
    };
    q.add(callerGoal);
    q.setStatus("g1", "achieved");

    // The queue stores its own copy of the goal, not the caller's object...
    expect(added[0]).not.toBe(callerGoal);
    expect(callerGoal.status).toBe("pending");
    // ...but it is the live one, so a handler that keeps it must snapshot it.
    expect(changed[0]).toBe(q.get("g1"));
    expect(added[0].status).toBe("achieved");
  });

  it("stops reporting after unsubscribe", () => {
    const q = new GoalQueue();
    const added: Goal[] = [];
    const unsub = q.on("goalAdded", (goal) => added.push({ ...goal }));

    q.add({ id: "g1", name: "a", priority: 1, status: "pending" });
    unsub();
    q.add({ id: "g2", name: "b", priority: 2, status: "pending" });

    expect(added.map((g) => g.id)).toEqual(["g1"]);
  });

  it("defaults to a bound of 1000 unfinished goals", () => {
    expect(new GoalQueue().atCapacity()).toBe(false);
  });

  it("counts only pending and active goals against the bound", () => {
    const q = new GoalQueue(undefined, { maxGoals: 2 });
    q.add({ id: "g1", name: "a", priority: 1, status: "pending" });
    q.add({ id: "g2", name: "b", priority: 1, status: "active" });

    expect(q.unfinishedCount()).toBe(2);
    expect(q.atCapacity()).toBe(true);

    q.setStatus("g1", "achieved");
    expect(q.unfinishedCount()).toBe(1);
    expect(q.atCapacity()).toBe(false);
  });

  it("refuses a goal past the bound, and says why", () => {
    const q = new GoalQueue(undefined, { maxGoals: 1 });
    const rejected: Goal[] = [];
    q.on("goalRejected", (goal) => rejected.push(goal));
    q.add({ id: "g1", name: "a", priority: 1, status: "pending" });

    q.add({ id: "g2", name: "b", priority: 1, status: "pending" });

    expect(rejected.map((g) => g.id)).toEqual(["g2"]);
    // The refusal is a failure, not a silent drop, so a waiting parent can react.
    expect(q.get("g2")?.status).toBe("failed");
    expect(q.getUnfinished().map((g) => g.id)).toEqual(["g1"]);
  });

  it("treats maxGoals 0 as no bound", () => {
    const q = new GoalQueue(undefined, { maxGoals: 0 });
    for (let i = 0; i < 50; i++) {
      q.add({ id: `g${i}`, name: "a", priority: 1, status: "pending" });
    }
    expect(q.atCapacity()).toBe(false);
    expect(q.unfinishedCount()).toBe(50);
  });

  it("rejects a nonsensical bound", () => {
    expect(() => new GoalQueue(undefined, { maxGoals: -1 })).toThrow();
    expect(() => new GoalQueue(undefined, { maxGoals: 1.5 })).toThrow();
  });

  it("collects finished goals on flush, keeping the rest", () => {
    const q = new GoalQueue();
    const removed: string[] = [];
    q.on("goalRemoved", (g) => removed.push(g.id));
    q.add({ id: "g1", name: "a", priority: 1, status: "pending" });
    q.add({ id: "g2", name: "b", priority: 1, status: "pending" });

    q.setStatus("g1", "achieved");
    // Nothing is collected until the cycle asks for it, so a status handler can
    // still read the goal it was just told about.
    expect(q.all()).toHaveLength(2);

    q.flush();
    expect(removed).toEqual(["g1"]);
    expect(q.all().map((g) => g.id)).toEqual(["g2"]);
  });

  it("keeps the status index in step with the goals map", () => {
    const q = new GoalQueue();
    q.add({ id: "g1", name: "a", priority: 1, status: "pending" });

    q.setStatus("g1", "active");
    expect(q.getByStatus("active").map((g) => g.id)).toEqual(["g1"]);
    expect(q.getByStatus("pending")).toEqual([]);

    // An active goal is unfinished, so a flush leaves it and its index entry.
    q.flush();
    expect(q.getByStatus("active").map((g) => g.id)).toEqual(["g1"]);

    q.setStatus("g1", "achieved");
    expect(q.getByStatus("active")).toEqual([]);
    q.flush();
    expect(q.getByStatus("achieved")).toEqual([]);
    expect(q.get("g1")).toBeUndefined();
    expect(q.all()).toEqual([]);
  });

  it("reports a goal that was still live to a collector that asks", () => {
    const q = new GoalQueue();
    q.add({ id: "g1", name: "a", priority: 1, status: "pending" });

    expect(q.isAchieved("g1")).toBe(false);
    q.setStatus("g1", "achieved");
    expect(q.isAchieved("g1")).toBe(true);
  });
});
