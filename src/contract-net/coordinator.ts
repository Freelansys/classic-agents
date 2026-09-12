import type { MessageBus } from "../bus/index.js";
import { Agent } from "../core/reasoning.js";
import { PlanLibrary } from "../core/plans.js";
import type { ActionResult, Plan } from "../core/plans.js";
import type { BeliefBase } from "../core/beliefs.js";

export interface CoordinatorTask<TPayload = unknown> {
  id: string;
  payload: TPayload;
}

export interface CoordinatorResult<TValue = unknown> {
  taskId: string;
  worker?: string;
  value: TValue;
}

export type AllocationFn = (
  candidates: string[],
  owners: Record<string, string>,
) => string | undefined;

export type AllocationPolicy =
  "first-claim" | "no-repeat" | "least-loaded" | AllocationFn;

export interface CoordinatorTopics {
  tasks: string;
  claims: string;
  grants: string;
  results: string;
}

export interface CoordinatorOptions<TTask = unknown, TValue = unknown> {
  /** Agent id (also its identity on the message bus). */
  id: string;
  bus: MessageBus;
  /** Known worker agent ids. Order matters for tie-breaking in the allocation policy. */
  workers: string[];
  /** Tasks to distribute among the workers. */
  tasks: CoordinatorTask<TTask>[];
  /** Topic names used by the protocol. Defaults match the pub/sub worker example. */
  topics?: Partial<CoordinatorTopics>;
  /**
   * How an unassigned task is awarded among the workers that claimed it.
   * Defaults to "first-claim" (the first worker in `workers` order).
   */
  allocationPolicy?: AllocationPolicy;
  /** Belief-content key under which the coordinator publishes a task. Default `task.${taskId}`. */
  taskKey?: (taskId: string) => string;
  /** Belief-content key under which a worker publishes a claim. Default `claim.${worker}.${taskId}`. */
  claimKey?: (taskId: string, worker: string) => string;
  /** Belief-content key under which the coordinator grants a task. Default `grant.${taskId}`. */
  grantKey?: (taskId: string) => string;
  /** Belief-content key under which a worker publishes a result. Default `result.${taskId}`. */
  resultKey?: (taskId: string) => string;
  /** Invoked when a task is granted to a worker. */
  onTaskAssigned?: (taskId: string, worker: string) => void;
  /** Invoked once per task when its result arrives on the results topic. */
  onResult?: (taskId: string, value: TValue, worker?: string) => void;
  /** Invoked once when every task has produced a result. */
  onAllComplete?: (results: CoordinatorResult<TValue>[]) => void;
}

export interface Coordinator<TValue = unknown> {
  readonly id: string;
  /** The underlying BDI agent; exposed for inspection/extension. */
  readonly agent: Agent;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  ownerOf(taskId: string): string | undefined;
  resultOf(taskId: string): CoordinatorResult<TValue> | undefined;
  owners(): Record<string, string>;
  results(): CoordinatorResult<TValue>[];
  isComplete(): boolean;
}

const DEFAULT_TOPICS: Required<CoordinatorTopics> = {
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

function resolveAllocation(policy: AllocationPolicy | undefined): AllocationFn {
  if (typeof policy === "function") return policy;

  switch (policy) {
    case "no-repeat":
      return (candidates, owners) => {
        const owned = new Set(Object.values(owners));
        return candidates.find((worker) => !owned.has(worker));
      };
    case "least-loaded":
      return (candidates, owners) => {
        const counts = new Map<string, number>();
        for (const worker of Object.values(owners)) {
          counts.set(worker, (counts.get(worker) ?? 0) + 1);
        }
        return [...candidates].sort(
          (a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0),
        )[0] as string | undefined;
      };
    case "first-claim":
    default:
      return (candidates) => candidates[0];
  }
}

export function createCoordinator<TTask = unknown, TValue = unknown>(
  options: CoordinatorOptions<TTask, TValue>,
): Coordinator<TValue> {
  const {
    id,
    bus,
    workers,
    tasks,
    allocationPolicy,
    onTaskAssigned,
    onResult,
    onAllComplete,
  } = options;

  if (tasks.length === 0) {
    throw new Error("createCoordinator requires at least one task");
  }
  if (workers.length === 0) {
    throw new Error("createCoordinator requires at least one worker");
  }

  const topics: Required<CoordinatorTopics> = {
    ...DEFAULT_TOPICS,
    ...options.topics,
  };
  const taskKey = options.taskKey ?? defaultTaskKey;
  const claimKey = options.claimKey ?? defaultClaimKey;
  const grantKey = options.grantKey ?? defaultGrantKey;
  const resultKey = options.resultKey ?? defaultResultKey;
  const allocate = resolveAllocation(allocationPolicy);

  const lib = new PlanLibrary();

  lib.register({
    name: "coordinator-publish-tasks",
    trigger: (beliefs) => !beliefs.get<boolean>("coordinator.tasksPublished"),
    body: [
      {
        name: "publish",
        execute: async (): Promise<ActionResult> => ({
          beliefUpdates: [{ key: "coordinator.tasksPublished", value: true }],
          messages: tasks.map((task) => ({
            topic: topics.tasks,
            performative: "inform" as const,
            content: { [taskKey(task.id)]: task.payload },
          })),
        }),
      },
    ],
  });

  const unassignedClaimedTasks = (beliefs: BeliefBase): string[] =>
    tasks
      .filter(
        (task) =>
          !beliefs.has(`coordinator.owner.${task.id}`) &&
          workers.some((worker) =>
            beliefs.has(`msg.${claimKey(task.id, worker)}`),
          ),
      )
      .map((task) => task.id);

  lib.register({
    name: "coordinator-arbitrate",
    trigger: (beliefs) => unassignedClaimedTasks(beliefs).length > 0,
    body: [
      {
        name: "grant",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const beliefUpdates: Array<{ key: string; value: unknown }> = [];
          const messages: Array<{
            topic: string;
            performative: "inform";
            content: Record<string, unknown>;
          }> = [];
          const owners: Record<string, string> = {};

          for (const task of tasks) {
            const existing = beliefs.get<string>(
              `coordinator.owner.${task.id}`,
            );
            if (existing) {
              owners[task.id] = existing;
              continue;
            }

            const candidates = workers.filter((worker) =>
              beliefs.has(`msg.${claimKey(task.id, worker)}`),
            );
            if (candidates.length === 0) continue;

            const worker = allocate(candidates, owners);
            if (!worker) continue;

            owners[task.id] = worker;
            beliefUpdates.push({
              key: `coordinator.owner.${task.id}`,
              value: worker,
            });
            beliefUpdates.push({
              key: `coordinator.claims.${task.id}`,
              value: candidates.length,
            });
            messages.push({
              topic: topics.grants,
              performative: "inform",
              content: { [grantKey(task.id)]: { taskId: task.id, worker } },
            });
            onTaskAssigned?.(task.id, worker);
          }

          return { beliefUpdates, messages };
        },
      },
    ],
  });

  lib.register({
    name: "coordinator-record-results",
    trigger: (beliefs) =>
      tasks.some(
        (task) =>
          beliefs.has(`msg.${resultKey(task.id)}`) &&
          !beliefs.has(`coordinator.result.${task.id}`),
      ),
    body: [
      {
        name: "record",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const beliefUpdates: Array<{ key: string; value: unknown }> = [];
          for (const task of tasks) {
            if (beliefs.has(`coordinator.result.${task.id}`)) continue;
            const value = beliefs.get<TValue>(`msg.${resultKey(task.id)}`);
            if (value === undefined) continue;
            const worker = beliefs.get<string>(`coordinator.owner.${task.id}`);
            beliefUpdates.push({
              key: `coordinator.result.${task.id}`,
              value,
            });
            beliefUpdates.push({
              key: `coordinator.result.${task.id}.worker`,
              value: worker,
            });
            onResult?.(task.id, value, worker);
          }
          return { beliefUpdates };
        },
      },
    ],
  });

  lib.register({
    name: "coordinator-complete",
    trigger: (beliefs) =>
      tasks.every((task) => beliefs.has(`coordinator.result.${task.id}`)) &&
      !beliefs.get("coordinator.done"),
    body: [
      {
        name: "finish",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const list: CoordinatorResult<TValue>[] = tasks.map((task) => ({
            taskId: task.id,
            worker: beliefs.get<string>(`coordinator.result.${task.id}.worker`),
            value: beliefs.get<TValue>(`coordinator.result.${task.id}`)!,
          }));
          onAllComplete?.(list);
          return { beliefUpdates: [{ key: "coordinator.done", value: true }] };
        },
      },
    ],
  });

  const agent = new Agent({ id, bus, planLibrary: lib });
  agent.subscribe(topics.claims);
  agent.subscribe(topics.results);

  return {
    id,
    agent,
    start: () => agent.start(),
    stop: () => agent.stop(),
    tick: () => agent.tick(),
    ownerOf: (taskId) =>
      agent.beliefs.get<string>(`coordinator.owner.${taskId}`),
    resultOf: (taskId) => {
      const value = agent.beliefs.get<TValue>(`coordinator.result.${taskId}`);
      if (value === undefined) return undefined;
      return {
        taskId,
        worker: agent.beliefs.get<string>(
          `coordinator.result.${taskId}.worker`,
        ),
        value,
      };
    },
    owners: () => {
      const owners: Record<string, string> = {};
      for (const task of tasks) {
        const worker = agent.beliefs.get<string>(
          `coordinator.owner.${task.id}`,
        );
        if (worker) owners[task.id] = worker;
      }
      return owners;
    },
    results: () =>
      tasks.flatMap((task) => {
        const value = agent.beliefs.get<TValue>(
          `coordinator.result.${task.id}`,
        );
        if (value === undefined) return [];
        return [
          {
            taskId: task.id,
            worker: agent.beliefs.get<string>(
              `coordinator.result.${task.id}.worker`,
            ),
            value,
          },
        ];
      }),
    isComplete: () => agent.beliefs.get<boolean>("coordinator.done") === true,
  };
}
