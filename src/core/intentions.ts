import type { Goal } from "./goals.js";
import type { Action, ActionResult, Plan } from "./plans.js";
import type { BeliefBase } from "./beliefs.js";

export type IntentionStatus =
  "pending" | "executing" | "waiting" | "completed" | "failed" | "dropped";

export interface Intention {
  id: string;
  goal: Goal;
  plan: Plan;
  actionIndex: number;
  status: IntentionStatus;
  result?: ActionResult;
  failureReason?: string;
}

let intentionCounter = 0;

export function createIntention(goal: Goal, plan: Plan): Intention {
  return {
    id: `intention-${++intentionCounter}`,
    goal,
    plan,
    actionIndex: 0,
    status: "pending",
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

  advance(id: string): void {
    const intention = this.intentions.get(id);
    if (intention) {
      intention.actionIndex++;
    }
  }
}
