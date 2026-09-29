import type { Goal } from "./goals.js";
import type { Action, ActionResult, Plan } from "./plans.js";
import type { BeliefBase } from "./beliefs.js";

export type IntentionStatus =
  "pending" | "executing" | "waiting" | "completed" | "failed" | "dropped";

/** A sub-goal an intention was waiting for that failed instead. */
export interface ChildFailure {
  goalId: string;
  goal: string;
  reason: string;
}

export interface Intention {
  id: string;
  goal: Goal;
  plan: Plan;
  actionIndex: number;
  status: IntentionStatus;
  result?: ActionResult;
  failureReason?: string;
  /** Ids of the sub-goals this intention is currently waiting for. */
  children: string[];
  /** Sub-goal failures collected while the plan recovers (`onChildFailure: "continue"`). */
  childFailures: ChildFailure[];
}

let intentionCounter = 0;

export function createIntention(goal: Goal, plan: Plan): Intention {
  return {
    id: `intention-${++intentionCounter}`,
    goal,
    plan,
    actionIndex: 0,
    status: "pending",
    children: [],
    childFailures: [],
  };
}

export function resetIntentionCounter(): void {
  intentionCounter = 0;
}

export class IntentionStack {
  private readonly intentions = new Map<string, Intention>();

  push(intention: Intention): void {
    this.intentions.set(intention.id, intention);
  }

  get(id: string): Intention | undefined {
    return this.intentions.get(id);
  }

  getAll(): Intention[] {
    return Array.from(this.intentions.values());
  }

  getActive(): Intention[] {
    return this.getAll().filter(
      (i) =>
        i.status === "pending" ||
        i.status === "executing" ||
        i.status === "waiting",
    );
  }

  remove(id: string): boolean {
    return this.intentions.delete(id);
  }

  complete(id: string, result: ActionResult): void {
    const intention = this.intentions.get(id);
    if (intention) {
      intention.status = "completed";
      intention.result = result;
    }
  }

  fail(id: string, reason: string): void {
    const intention = this.intentions.get(id);
    if (intention) {
      intention.status = "failed";
      intention.failureReason = reason;
    }
  }

  drop(id: string): void {
    const intention = this.intentions.get(id);
    if (intention) {
      intention.status = "dropped";
    }
  }

  setStatus(id: string, status: IntentionStatus): void {
    const intention = this.intentions.get(id);
    if (intention) {
      intention.status = status;
    }
  }

  advance(id: string): void {
    const intention = this.intentions.get(id);
    if (intention) {
      intention.actionIndex++;
    }
  }
}
