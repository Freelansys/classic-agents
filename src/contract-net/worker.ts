import type { MessageBus } from "../bus/index.js";
import { Agent } from "../core/reasoning.js";
import { PlanLibrary } from "../core/plans.js";
import type { ActionResult } from "../core/plans.js";
import type { BeliefBase } from "../core/beliefs.js";

export interface WorkerTaskResult<TResult = unknown> {
  taskId: string;
  result: TResult;
}

/** Return `{ done: true, result }` to finish a task; `{ done: false }` to keep working next tick. */
export type WorkerStepResult =
  { done: true; result: unknown } | { done: false };

export interface WorkerTopics {
  tasks: string;
  claims: string;
  grants: string;
  results: string;
}

export interface WorkerOptions<TTask = unknown, TResult = unknown> {
  /** Agent id (also its identity on the message bus). */
  id: string;
  bus: MessageBus;
  /** Topic names used by the protocol. Must match the coordinator. Defaults match the example. */
  topics?: Partial<WorkerTopics>;
  /** Decide whether to claim an announced task. Default: claim everything. */
  canClaim?: (taskId: string, payload: TTask) => boolean;
  /**
   * One tick of work per granted task. Invoked every tick while a granted
   * task is unfinished. Return `{ done: true, result }` to finish the task
   * and publish its result on the results topic.
   */
  step: (
    taskId: string,
    payload: TTask,
    beliefs: BeliefBase,
  ) => WorkerStepResult;
  /** Belief-content key under which tasks arrive. Default `task.${taskId}`. */
  taskKey?: (taskId: string) => string;
  /** Belief-content key under which a claim is published. Default `claim.${worker}.${taskId}`. */
  claimKey?: (taskId: string, worker: string) => string;
  /** Belief-content key under which a grant arrives. Default `grant.${taskId}`. */
  grantKey?: (taskId: string) => string;
  /** Belief-content key under which the result is published. Default `result.${taskId}`. */
  resultKey?: (taskId: string) => string;
  /** Invoked when a task has been claimed. */
  onClaimed?: (taskId: string) => void;
  /** Invoked when a task has been completed and its result published. */
  onResult?: (taskId: string, result: TResult) => void;
}

export interface Worker<TResult = unknown> {
  readonly id: string;
  /** The underlying BDI agent; exposed for inspection/extension. */
  readonly agent: Agent;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  /** Task ids this worker has claimed. */
  claimed(): string[];
  /** Task ids granted to this worker but not yet completed. */
  activeTasks(): string[];
  /** Task ids this worker has completed and reported. */
  completed(): string[];
  resultOf(taskId: string): TResult | undefined;
  results(): WorkerTaskResult<TResult>[];
}

const DEFAULT_TOPICS: Required<WorkerTopics> = {
  tasks: "tasks",
  claims: "claims",
  grants: "grants",
  results: "results",
};

const defaultTaskKey = (taskId: string): string => `task.${taskId}`;
const defaultClaimKey = (taskId: string, worker: string): string =>
  `claim.${worker}.${taskId}`;
const defaultGrantKey = (taskId: string): string => `grant.${taskId}`;
const defaultResultKey = (taskId: string): string => `result.${taskId}`;

export function createWorker<TTask = unknown, TResult = unknown>(
  options: WorkerOptions<TTask, TResult>,
): Worker<TResult> {
  const { id, bus, canClaim, step, onClaimed, onResult } = options;

  const topics: Required<WorkerTopics> = {
    ...DEFAULT_TOPICS,
    ...options.topics,
  };
  const taskKey = options.taskKey ?? defaultTaskKey;
  const claimKey = options.claimKey ?? defaultClaimKey;
  const grantKey = options.grantKey ?? defaultGrantKey;
  const resultKey = options.resultKey ?? defaultResultKey;
  const shouldClaim = canClaim ?? (() => true);

  const announcedTasks = (beliefs: BeliefBase): Array<{ taskId: string }> => {
    const prefix = `msg.${taskKey("")}`;
    return beliefs
      .queryByPrefix(prefix)
      .map(({ key }) => ({ taskId: key.slice(prefix.length) }));
  };

  const grantedTasks = (beliefs: BeliefBase): Array<{ taskId: string }> => {
    const prefix = `msg.${grantKey("")}`;
    return beliefs
      .queryByPrefix(prefix)
      .filter(({ value }) => {
        const grant = value as { taskId?: string; worker?: string } | undefined;
        return grant?.worker === id;
      })
      .map(({ key }) => ({ taskId: key.slice(prefix.length) }));
  };

  const isProcessed = (beliefs: BeliefBase, taskId: string): boolean =>
    beliefs.has(`worker.claimed.${taskId}`) ||
    beliefs.has(`worker.skipped.${taskId}`);

  const lib = new PlanLibrary();

  lib.register({
    name: "worker-claim",
    trigger: (beliefs) =>
      announcedTasks(beliefs).some(
        (task) => !isProcessed(beliefs, task.taskId),
      ),
    body: [
      {
        name: "claim",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const beliefUpdates: Array<{ key: string; value: unknown }> = [];
          const messages: Array<{
            topic: string;
            performative: "inform";
            content: Record<string, unknown>;
          }> = [];

          for (const task of announcedTasks(beliefs)) {
            if (isProcessed(beliefs, task.taskId)) continue;

            const payload = beliefs.get<TTask>(`msg.${taskKey(task.taskId)}`);
            if (shouldClaim(task.taskId, payload!)) {
              beliefUpdates.push({
                key: `worker.claimed.${task.taskId}`,
                value: true,
              });
              messages.push({
                topic: topics.claims,
                performative: "inform",
                content: {
                  [claimKey(task.taskId, id)]: {
                    taskId: task.taskId,
                    worker: id,
                  },
                },
              });
              onClaimed?.(task.taskId);
            } else {
              beliefUpdates.push({
                key: `worker.skipped.${task.taskId}`,
                value: true,
              });
            }
          }

          return { beliefUpdates, messages };
        },
      },
    ],
  });

  lib.register({
    name: "worker-work",
    trigger: (beliefs) =>
      grantedTasks(beliefs).some(
        (task) => !beliefs.has(`worker.done.${task.taskId}`),
      ),
    body: [
      {
        name: "advance",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const beliefUpdates: Array<{ key: string; value: unknown }> = [];
          const messages: Array<{
            topic: string;
            performative: "inform";
            content: Record<string, unknown>;
          }> = [];

          for (const task of grantedTasks(beliefs)) {
            if (beliefs.has(`worker.done.${task.taskId}`)) continue;

            const payload = beliefs.get<TTask>(`msg.${taskKey(task.taskId)}`);
            const outcome = step(task.taskId, payload!, beliefs);

            if (outcome.done) {
              beliefUpdates.push({
                key: `worker.done.${task.taskId}`,
                value: true,
              });
              beliefUpdates.push({
                key: `worker.result.${task.taskId}`,
                value: outcome.result,
              });
              messages.push({
                topic: topics.results,
                performative: "inform",
                content: {
                  [resultKey(task.taskId)]: outcome.result,
                },
              });
              onResult?.(task.taskId, outcome.result as TResult);
            }
          }

          return { beliefUpdates, messages };
        },
      },
    ],
  });

  const agent = new Agent({ id, bus, planLibrary: lib });
  agent.subscribe(topics.tasks);
  agent.subscribe(topics.grants);

  const workerState = (prefix: string): string[] =>
    agent.beliefs
      .queryByPrefix(prefix)
      .map(({ key }) => key.slice(prefix.length));

  return {
    id,
    agent,
    start: () => agent.start(),
    stop: () => agent.stop(),
    tick: () => agent.tick(),
    claimed: () => workerState("worker.claimed."),
    activeTasks: () =>
      agent.beliefs
        .queryByPrefix("msg.")
        .filter(({ key, value }) => {
          if (!key.startsWith(`msg.${grantKey("")}`)) return false;
          const grant = value as
            { taskId?: string; worker?: string } | undefined;
          if (grant?.worker !== id) return false;
          const taskId = key.slice(`msg.${grantKey("")}`.length);
          return !agent.beliefs.has(`worker.done.${taskId}`);
        })
        .map(({ key }) => key.slice(`msg.${grantKey("")}`.length)),
    completed: () => workerState("worker.done."),
    resultOf: (taskId) => agent.beliefs.get<TResult>(`worker.result.${taskId}`),
    results: () =>
      workerState("worker.done.").map((taskId) => ({
        taskId,
        result: agent.beliefs.get<TResult>(`worker.result.${taskId}`)!,
      })),
  };
}
