import { EventEmitter } from "node:events";

export type GoalStatus =
  "pending" | "active" | "achieved" | "failed" | "dropped";

export interface Goal<T = unknown> {
  id: string;
  name: string;
  priority: number;
  status: GoalStatus;
  data?: T;
}

export type GoalSelectionFunction = (
  pending: Goal[],
  active: Goal[],
) => Goal | undefined;

export function defaultGoalSelection(
  pending: Goal[],
  active: Goal[],
): Goal | undefined {
  const activeNames = new Set(active.map((g) => g.name));
  const candidates = pending
    .filter((g) => !activeNames.has(g.name))
    .sort((a, b) => b.priority - a.priority);

  return candidates[0];
}

export class GoalQueue {
  private readonly goals = new Map<string, Goal>();
  private readonly emitter = new EventEmitter();
  private selectFn: GoalSelectionFunction;

  constructor(selectFn: GoalSelectionFunction = defaultGoalSelection) {
    this.selectFn = selectFn;
    this.emitter.setMaxListeners(0);
  }

  add<T = unknown>(goal: Goal<T>): void {
    this.goals.set(goal.id, { ...goal, status: goal.status ?? "pending" });
    this.emitter.emit("goalAdded", goal);
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  setStatus(id: string, status: GoalStatus): void {
    const goal = this.goals.get(id);
    if (goal) {
      goal.status = status;
      this.emitter.emit("goalStatusChanged", goal);
    }
  }

  getByStatus(status: GoalStatus): Goal[] {
    return Array.from(this.goals.values()).filter((g) => g.status === status);
  }

  all(): Goal[] {
    return Array.from(this.goals.values());
  }

  selectNext(): Goal | undefined {
    const pending = this.getByStatus("pending");
    const active = this.getByStatus("active");
    return this.selectFn(pending, active);
  }

  remove(id: string): boolean {
    return this.goals.delete(id);
  }

  on(event: string, handler: (...args: unknown[]) => void): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }
}
