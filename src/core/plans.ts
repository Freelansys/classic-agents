import type { BeliefBase } from "./beliefs.js";
import type { Goal } from "./goals.js";
import type { Intention } from "./intentions.js";

export interface ActionResult {
  beliefUpdates?: Array<{ key: string; value: unknown }>;
  newGoals?: Array<{ name: string; priority: number; data?: unknown }>;
  messages?: Array<{
    receiver: string;
    performative: string;
    content: unknown;
  }>;
  failure?: { reason: string };
  beliefRemovals?: string[];
}

export interface Action {
  name: string;
  execute(intention: Intention, beliefs: BeliefBase): Promise<ActionResult>;
}

export type TriggerFunction = (beliefs: BeliefBase, goal: Goal) => boolean;

export interface Plan {
  name: string;
  trigger: TriggerFunction;
  body: Action[];
}

export class PlanLibrary {
  private readonly plans: Plan[] = [];

  register(plan: Plan): void {
    this.plans.push(plan);
  }

  findApplicable(beliefs: BeliefBase, goal: Goal): Plan | undefined {
    return this.plans.find((p) => p.trigger(beliefs, goal));
  }

  findAll(beliefs: BeliefBase, goal: Goal): Plan[] {
    return this.plans.filter((p) => p.trigger(beliefs, goal));
  }

  all(): Plan[] {
    return [...this.plans];
  }
}
