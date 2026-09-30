import type { BeliefBase } from "./beliefs.js";
import type { Performative } from "../bus/performatives.js";
import type { Goal } from "./goals.js";
import type { Intention } from "./intentions.js";

export interface ActionResult {
  beliefUpdates?: Array<{ key: string; value: unknown }>;
  newGoals?: Array<{ name: string; priority: number; data?: unknown }>;
  messages?: Array<{
    receiver?: string;
    topic?: string;
    /**
     * The speech act the message performs. Typed rather than free-form so a
     * plan cannot send a performative no receiver will recognise: an
     * unrecognised one is perceived and produces nothing, which is a bug that
     * otherwise only shows up as a plan that seems to do nothing.
     */
    performative: Performative;
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

/**
 * What an intention does when one of the sub-goals it is waiting for fails.
 *
 * - `"fail"` (default): the waiting intention fails too, with the sub-goal's
 *   reason, and the failure keeps cascading to its own waiting parents.
 * - `"continue"`: the plan can recover — the failed sub-goal is forgotten and
 *   the intention resumes with its next action, with the failure recorded in
 *   `intention.childFailures` for that action to inspect.
 */
export type ChildFailurePolicy = "fail" | "continue";

export interface Plan {
  name: string;
  trigger: TriggerFunction;
  body: Action[];
  /** Defaults to `"fail"` when omitted. */
  onChildFailure?: ChildFailurePolicy;
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
