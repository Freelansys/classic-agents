/**
 * Helpers for unit-testing your own plans: look a step up by name, build the
 * intention an action receives, and run one action the way the agent does.
 *
 * Everything here builds the library's own types, so a test written with it
 * keeps working when `Intention`, `Delegation` or `PlanFailure` gain a field.
 *
 * @example
 * ```ts
 * import { actionOf, runAction } from "classic-agents/testing";
 *
 * const { result } = await runAction(assess, "screen", {
 *   data: job,
 *   beliefs: { "status": "idle" },
 * });
 * expect(result?.beliefUpdates).toContainEqual({ key: "screened", value: true });
 * ```
 *
 * @module
 */
import { InMemoryBeliefBase } from "../core/beliefs.js";
import type { BeliefBase } from "../core/beliefs.js";
import type { Goal } from "../core/goals.js";
import type {
  Call,
  ChildFailure,
  Delegation,
  Intention,
  IntentionStatus,
} from "../core/intentions.js";
import { planName } from "../core/plans.js";
import type {
  Action,
  ActionResult,
  Plan,
  PlanFailure,
  PlanFailureResult,
} from "../core/plans.js";

/** The id of the goal a fixture intention works. */
export const FIXTURE_GOAL_ID = "test-goal";
/** The id of a fixture intention. */
export const FIXTURE_INTENTION_ID = "test-intention";
/** The agent a fixture delegation was made to, unless it names its own. */
export const FIXTURE_AGENT_ID = "test-agent";

/**
 * A delegation to seed a fixture intention with. Only `goal` is required: the
 * rest defaults to a self-delegation that is `"done"`.
 */
export type FixtureDelegation = Partial<Delegation> & { goal: string };

/** What to build a fixture intention from. Every field is optional. */
export interface FixtureOptions<T = unknown> {
  /** The goal's `data`. */
  data?: T;
  /** Overrides for the goal, beyond its `data`. */
  goal?: Partial<Goal<T>>;
  /**
   * Which step the intention is at. Defaults to 0; {@link runAction} sets it
   * to the step it runs.
   */
  actionIndex?: number;
  status?: IntentionStatus;
  /**
   * Answers of sub-goals the plan already delegated, by goal name: each
   * becomes a `"done"` delegation holding it as its `result`, as the agent
   * records one. Use {@link FixtureOptions.delegations} when a goal was
   * delegated more than once, or did not end `"done"`.
   */
  results?: Record<string, unknown>;
  /**
   * Delegations the plan already made, settled or not, in the order made.
   * Recorded after those from {@link FixtureOptions.results}.
   */
  delegations?: FixtureDelegation[];
  /** Failures of delegations the plan could do without. */
  childFailures?: ChildFailure[];
  /** Calls for proposals the plan opened. */
  calls?: Call[];
  /** The `ActionResult` the previous action left, carried on the intention. */
  result?: ActionResult;
}

/**
 * An intention for `plan`, as the agent hands it to an action, with every
 * field the options leave out defaulted: an active goal named for the plan's
 * goal, at the plan's first step, with nothing delegated. Ids are fixed
 * ({@link FIXTURE_GOAL_ID}, {@link FIXTURE_INTENTION_ID}), so snapshots do not
 * depend on the order tests run in.
 */
export function fixtureIntention<T = unknown>(
  plan: Plan,
  options: FixtureOptions<T> = {},
): Intention {
  const goal: Goal<T> = {
    id: FIXTURE_GOAL_ID,
    name: plan.goal,
    priority: 5,
    status: "active",
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...options.goal,
  };
  if (goal.rootGoalId === undefined) {
    goal.rootGoalId = goal.id;
  }
  const delegations: Delegation[] = [
    ...Object.entries(options.results ?? {}).map(
      ([name, result]): FixtureDelegation => ({ goal: name, result }),
    ),
    ...(options.delegations ?? []),
  ].map((delegation, index) => fixtureDelegation(delegation, index));
  return {
    id: FIXTURE_INTENTION_ID,
    goal,
    plan,
    actionIndex: options.actionIndex ?? 0,
    status: options.status ?? "executing",
    ...(options.result !== undefined ? { result: options.result } : {}),
    // Open self-delegations are the sub-goals the intention still waits for.
    children: delegations
      .filter(
        (d) =>
          d.receiver === FIXTURE_AGENT_ID &&
          (d.status === "sent" || d.status === "agreed") &&
          d.goalId !== undefined,
      )
      .map((d) => d.goalId!),
    delegations,
    childFailures: [...(options.childFailures ?? [])],
    calls: [...(options.calls ?? [])],
  };
}

function fixtureDelegation(
  delegation: FixtureDelegation,
  index: number,
): Delegation {
  return {
    receiver: FIXTURE_AGENT_ID,
    status: "done",
    goalId: `${FIXTURE_GOAL_ID}-${index + 1}`,
    ...delegation,
  };
}

/**
 * The step of `plan` named `name`.
 *
 * @throws If the plan has no step of that name, or more than one: looking a
 *   step up by a name two steps share would quietly pick one by position.
 */
export function actionOf(plan: Plan, name: string): Action {
  const matches = plan.body.filter((action) => action.name === name);
  if (matches.length === 0) {
    const names = plan.body.map((action) => `"${action.name}"`).join(", ");
    throw new Error(
      `plan "${planName(plan)}" has no step named "${name}"; its steps are ${names || "none"}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `plan "${planName(plan)}" has ${matches.length} steps named "${name}"; give each step its own name`,
    );
  }
  return matches[0]!;
}

/** What to run an action against. */
export interface RunActionOptions<T = unknown> extends FixtureOptions<T> {
  /**
   * The agent's beliefs: a belief base, which the run then writes to, or
   * initial values for a fresh one.
   */
  beliefs?: BeliefBase | Record<string, unknown>;
}

/** How a plan failed in {@link runAction}, after its `onPlanFailure` hook. */
export interface RunActionFailure extends PlanFailure {
  /**
   * The reason the failure is reported with: the hook's, when it gave one,
   * otherwise the action's.
   */
  reason: string;
  /** The action's own reason, before the hook replaced it. */
  originalReason: string;
  /** What the plan's `onPlanFailure` hook returned, when it ran and returned. */
  hookResult?: PlanFailureResult;
  /** The error text, when the hook threw. */
  hookError?: string;
}

/** What {@link runAction} observed. */
export interface RunActionOutcome {
  /** What the action returned; absent when it threw. */
  result?: ActionResult;
  /**
   * Present when the action returned a `failure` or threw, as the agent would
   * report it once the plan's `onPlanFailure` hook ran.
   */
  failure?: RunActionFailure;
  /**
   * The beliefs after the run, with the action's updates and removals applied
   * and then the hook's, in the order the agent applies them.
   */
  beliefs: BeliefBase;
  /** The intention the action ran against. */
  intention: Intention;
}

/**
 * Runs the step of `plan` named `name` against a {@link fixtureIntention},
 * the way the agent runs it: the action's belief updates and removals are
 * applied, and if it returns a `failure` or throws, the plan's
 * `onPlanFailure` hook runs and its belief updates are applied too.
 *
 * Only that one step runs. What the result would start — delegations, calls,
 * spawned goals, messages, `continueWith` — is returned for the test to
 * assert on, not carried out; nor is it checked that the agent would accept
 * it (a `continueWith` from a step that is not the last, say).
 */
export async function runAction<T = unknown>(
  plan: Plan,
  name: string,
  options: RunActionOptions<T> = {},
): Promise<RunActionOutcome> {
  const action = actionOf(plan, name);
  const { beliefs: given, ...fixture } = options;
  const beliefs = toBeliefBase(given);
  const intention = fixtureIntention(plan, {
    ...fixture,
    actionIndex: fixture.actionIndex ?? plan.body.indexOf(action),
  });

  let result: ActionResult | undefined;
  let failure: PlanFailure | undefined;
  try {
    result = await action.execute(intention, beliefs);
    applyBeliefs(result, beliefs);
    if (result.failure) {
      failure = {
        reason: result.failure.reason,
        cause: "action",
        action: action.name,
      };
    }
  } catch (error) {
    failure = {
      reason:
        result?.failure?.reason ??
        (error instanceof Error ? error.message : String(error)),
      cause: "action",
      action: action.name,
      error,
    };
  }

  return {
    ...(result !== undefined ? { result } : {}),
    ...(failure !== undefined
      ? { failure: await runHook(intention, beliefs, failure) }
      : {}),
    beliefs,
    intention,
  };
}

async function runHook(
  intention: Intention,
  beliefs: BeliefBase,
  failure: PlanFailure,
): Promise<RunActionFailure> {
  const outcome: RunActionFailure = {
    ...failure,
    originalReason: failure.reason,
  };
  const hook = intention.plan.onPlanFailure;
  if (!hook) {
    return outcome;
  }
  try {
    const hookResult = (await hook(intention, beliefs, failure)) ?? {};
    applyBeliefs(hookResult, beliefs);
    return {
      ...outcome,
      reason: hookResult.reason ?? failure.reason,
      hookResult,
    };
  } catch (error) {
    return {
      ...outcome,
      hookError: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyBeliefs(
  result: Pick<ActionResult, "beliefUpdates" | "beliefRemovals">,
  beliefs: BeliefBase,
): void {
  for (const { key, value } of result.beliefUpdates ?? []) {
    beliefs.set(key, value);
  }
  for (const key of result.beliefRemovals ?? []) {
    beliefs.remove(key);
  }
}

function toBeliefBase(
  beliefs: BeliefBase | Record<string, unknown> | undefined,
): BeliefBase {
  if (isBeliefBase(beliefs)) {
    return beliefs;
  }
  const base = new InMemoryBeliefBase();
  for (const [key, value] of Object.entries(beliefs ?? {})) {
    base.set(key, value);
  }
  return base;
}

function isBeliefBase(value: unknown): value is BeliefBase {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BeliefBase).get === "function" &&
    typeof (value as BeliefBase).set === "function" &&
    typeof (value as BeliefBase).remove === "function"
  );
}
