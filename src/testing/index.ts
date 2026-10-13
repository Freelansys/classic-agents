/**
 * Helpers for unit-testing your own plans: look a step up by name, build the
 * intention an action receives, run one action the way the agent does, and
 * run a whole plan on a real agent with its sub-goals answered by stubs.
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
import { InMemoryMessageBus } from "../bus/index.js";
import type { Message, MessageBus, MessageHandler } from "../bus/types.js";
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
import { PlanLibrary, planName } from "../core/plans.js";
import { Agent } from "../core/reasoning/agent.js";
import type { AgentConfig } from "../core/reasoning/types.js";
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

/**
 * How a stubbed sub-goal is answered: the `ActionResult` its one-step plan
 * returns — a `result` to hand back, a `failure`, belief updates — or a
 * function of the sub-goal's data that returns one.
 */
export type SubGoalStub =
  | ActionResult
  | ((
      data: unknown,
      context: { agent: string },
    ) => ActionResult | Promise<ActionResult>);

/** What to run a plan with. */
export interface RunPlanOptions<T = unknown> {
  /** The goal's `data`. */
  data?: T;
  /** The goal's priority. Defaults to 5. */
  priority?: number;
  /**
   * The agent's beliefs: a belief base, which the run then writes to, or
   * initial values for a fresh one.
   */
  beliefs?: BeliefBase | Record<string, unknown>;
  /**
   * How each goal the plan delegates is answered, by goal name. A
   * self-delegation is served by a stub plan on the agent running the plan; a
   * delegation to another agent, by a stub agent of that id, started the
   * first time a message is sent to it. A goal with no stub has no plan, and
   * is refused like any goal no plan serves.
   */
  subGoals?: Record<string, SubGoalStub>;
  /** The id of the agent running the plan. Defaults to {@link FIXTURE_AGENT_ID}. */
  agentId?: string;
  /**
   * The most reasoning cycles to run before giving up with
   * `outcome: "unfinished"`. Defaults to 100.
   */
  maxCycles?: number;
  /** Further configuration for the agent running the plan. */
  config?: Omit<Partial<AgentConfig>, "id" | "bus" | "planLibrary" | "beliefs">;
}

/** One step of the plan that ran and was advanced past. */
export interface PlanStep {
  /** The step's name. */
  action: string;
  /** What it returned. */
  result: ActionResult;
}

/** How the plan failed, from {@link RunPlanTrace.failure}. */
export interface RunPlanFailure {
  /**
   * The reason the goal failed with, as the requester would be told: after
   * the plan's `onPlanFailure` hook and the agent's `onGoalFailure`.
   */
  reason: string;
  /** What failed, when the plan ran: one of its steps, or a delegation it needed. */
  cause?: PlanFailure["cause"];
  /** The step that failed, when `cause` is `"action"`. */
  action?: string;
  /** What the step threw, when it threw. */
  error?: unknown;
  /** The error text, when the plan's `onPlanFailure` hook threw. */
  onPlanFailureError?: string;
}

/** What {@link runPlan} observed. */
export interface RunPlanTrace {
  /**
   * How the run ended: the goal was `"achieved"`, it `"failed"`, the plan
   * handed it on with `continueWith` (`"continued"`), or it had not ended
   * within `maxCycles` (`"unfinished"`).
   */
  outcome: "achieved" | "failed" | "continued" | "unfinished";
  /**
   * The steps that ran and were advanced past, in order. A step that failed
   * is not among them: `failure.action` names it.
   */
  steps: PlanStep[];
  /** The goal's answer (`ActionResult.result`), when one was set. */
  result?: unknown;
  /** The goal the plan handed on to, when `outcome` is `"continued"`. */
  continueWith?: NonNullable<ActionResult["continueWith"]>;
  /** Why the goal failed, when `outcome` is `"failed"`. */
  failure?: RunPlanFailure;
  /** The delegations the plan made, as they stood when the run ended. */
  delegations: Delegation[];
  /** Every message the agent sent, delegation requests included. */
  messages: Message[];
  /** The agent's beliefs when the run ended. */
  beliefs: BeliefBase;
  /** The goal the plan ran for. */
  goal: Goal;
}

/**
 * Runs `plan` to the end on a real {@link Agent}, over an in-memory bus, and
 * reports what happened. Because the agent itself runs it, the plan is
 * stepped, waits for its delegations and fails exactly as it would in
 * production: belief updates land between steps, `waitFor` and `onFailure`
 * apply, a misplaced `continueWith` fails the plan, and `onPlanFailure` runs.
 *
 * The goals the plan delegates are answered from `subGoals`. The run stops
 * when the goal is achieved, fails or is handed on with `continueWith`; the
 * goal it is handed on to is not run.
 *
 * Calls for proposals are not answered: a plan that opens one waits until its
 * deadline.
 *
 * @throws If `subGoals` stubs the goal the plan itself serves.
 */
export async function runPlan<T = unknown>(
  plan: Plan,
  options: RunPlanOptions<T> = {},
): Promise<RunPlanTrace> {
  const subGoals = options.subGoals ?? {};
  if (Object.hasOwn(subGoals, plan.goal)) {
    throw new Error(
      `subGoals cannot stub "${plan.goal}": it is the goal plan "${planName(plan)}" serves`,
    );
  }
  const agentId = options.agentId ?? FIXTURE_AGENT_ID;
  const beliefs = toBeliefBase(options.beliefs);
  const bus: StubbingBus = new StubbingBus((id) =>
    stubAgent(id, bus, subGoals),
  );
  const library = new PlanLibrary();
  library.register(plan);
  for (const stub of stubPlans(agentId, subGoals)) {
    library.register(stub);
  }
  const agent = new Agent({
    ...options.config,
    id: agentId,
    bus,
    planLibrary: library,
    beliefs,
  });

  const goal: Goal<T> = {
    id: FIXTURE_GOAL_ID,
    name: plan.goal,
    priority: options.priority ?? 5,
    status: "pending",
    ...(options.data !== undefined ? { data: options.data } : {}),
  };

  const steps: PlanStep[] = [];
  const messages: Message[] = [];
  let outcome: RunPlanTrace["outcome"] = "unfinished";
  let result: unknown;
  let continueWith: RunPlanTrace["continueWith"];
  let failure: RunPlanFailure | undefined;
  let onPlanFailureError: string | undefined;
  let last: Intention | undefined;

  const ours = (intention: Intention) =>
    intention.goal.id === goal.id && intention.plan === plan;
  agent.on("message:sent", (message) => messages.push(message));
  agent.on("intention:started", (intention) => {
    if (ours(intention)) last = intention;
  });
  agent.on("intention:advanced", ({ intention, action, result }) => {
    if (ours(intention)) steps.push({ action: action.name, result });
  });
  agent.on("intention:failed", ({ intention, onPlanFailureError: error }) => {
    if (!ours(intention) || error === undefined) return;
    // Reported after `goal:failed` when the goal fails with the plan.
    onPlanFailureError = error;
    if (failure) failure.onPlanFailureError = error;
  });
  // Before `intention:completed`, which a hand-off also emits.
  agent.on("goal:continued", (event) => {
    if (event.goal.id !== goal.id || outcome !== "unfinished") return;
    outcome = "continued";
    result = agent.goalResults.get(goal.id);
    continueWith = event.intention.result?.continueWith;
  });
  agent.on("intention:completed", (intention) => {
    if (!ours(intention) || outcome !== "unfinished") return;
    outcome = "achieved";
    result = agent.goalResults.get(goal.id);
  });
  agent.on("goal:failed", (event) => {
    if (event.goal.id !== goal.id || outcome !== "unfinished") return;
    outcome = "failed";
    const attempt = event.attempts.at(-1);
    failure = {
      reason: event.reason,
      ...(attempt ? { cause: attempt.cause } : {}),
      ...(attempt?.action !== undefined ? { action: attempt.action } : {}),
      ...(attempt && "error" in attempt ? { error: attempt.error } : {}),
      ...(onPlanFailureError !== undefined ? { onPlanFailureError } : {}),
    };
  });

  await agent.start();
  agent.goals.add(goal);
  try {
    const maxCycles = options.maxCycles ?? 100;
    for (
      let cycle = 0;
      cycle < maxCycles && outcome === "unfinished";
      cycle++
    ) {
      await agent.tick();
      for (const stub of bus.stubs) {
        await stub.tick();
      }
    }
  } finally {
    await agent.stop();
    for (const stub of bus.stubs) {
      await stub.stop();
    }
  }

  return {
    outcome,
    steps,
    ...(result !== undefined ? { result } : {}),
    ...(continueWith !== undefined ? { continueWith } : {}),
    ...(failure !== undefined ? { failure } : {}),
    delegations: (last?.delegations ?? []).map((d) => ({ ...d })),
    messages,
    beliefs,
    goal,
  };
}

/** A one-step plan for each stubbed goal, answering as its stub says. */
function stubPlans(
  agentId: string,
  subGoals: Record<string, SubGoalStub>,
): Plan[] {
  return Object.entries(subGoals).map(([goal, stub]) => ({
    name: `stub:${goal}`,
    goal,
    body: [
      {
        name: `stub:${goal}`,
        execute: async (intention) =>
          typeof stub === "function"
            ? stub(intention.goal.data, { agent: agentId })
            : stub,
      },
    ],
  }));
}

async function stubAgent(
  id: string,
  bus: MessageBus,
  subGoals: Record<string, SubGoalStub>,
): Promise<Agent> {
  const library = new PlanLibrary();
  for (const stub of stubPlans(id, subGoals)) {
    library.register(stub);
  }
  const agent = new Agent({ id, bus, planLibrary: library });
  await agent.start();
  return agent;
}

/**
 * An in-memory bus that starts a stub agent the first time a message is sent
 * to an id nobody has registered, so a plan can delegate to agents the test
 * never named.
 */
class StubbingBus implements MessageBus {
  readonly stubs: Agent[] = [];
  private readonly inner = new InMemoryMessageBus();
  private readonly registered = new Set<string>();

  constructor(private readonly startStub: (id: string) => Promise<Agent>) {}

  publish(topic: string, message: Message): Promise<void> {
    return this.inner.publish(topic, message);
  }

  subscribe(topic: string, handler: MessageHandler): Promise<() => void> {
    return this.inner.subscribe(topic, handler);
  }

  async send(agentId: string, message: Message): Promise<void> {
    if (!this.registered.has(agentId)) {
      this.stubs.push(await this.startStub(agentId));
    }
    return this.inner.send(agentId, message);
  }

  registerAgent(agentId: string, inbox: MessageHandler): void {
    this.registered.add(agentId);
    this.inner.registerAgent(agentId, inbox);
  }
}
