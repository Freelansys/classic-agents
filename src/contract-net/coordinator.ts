import type { MessageBus } from "../bus/index.js";
import { Agent } from "../core/reasoning.js";
import { PlanLibrary } from "../core/plans.js";
import type { ActionResult } from "../core/plans.js";
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
  /**
   * Seed tasks to publish to the tasks topic once at startup. Optional:
   * tasks can instead be announced by any agent that publishes an
   * `inform` message with a `task.<id>` content key (see `taskKey`) to
   * the tasks topic; the coordinator arbitrates whatever it perceives.
   */
  tasks?: CoordinatorTask<TTask>[];
  /** Topic names used by the protocol. Defaults match the pub/sub worker example. */
  topics?: Partial<CoordinatorTopics>;
  /**
   * How an unassigned task is awarded among the workers that claimed it.
   * Defaults to "first-claim" (the first worker in `workers` order).
   */
  allocationPolicy?: AllocationPolicy;
  /** Belief-content key under which a task is announced. Default `task.${taskId}`. */
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
  /**
   * Invoked every time the coordination becomes quiescent (every
   * announced task has produced a result). New tasks announced over the
   * bus afterwards trigger it again with the full result set.
   */
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

const prefixIds = (beliefs: BeliefBase, prefix: string): string[] =>
  beliefs.queryByPrefix(prefix).map(({ key }) => key.slice(prefix.length));

export function createCoordinator<TTask = unknown, TValue = unknown>(
  options: CoordinatorOptions<TTask, TValue>,
): Coordinator<TValue> {
  const { id, bus, workers, onTaskAssigned, onResult, onAllComplete } = options;
  const seedTasks = options.tasks ?? [];

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
  const allocate = resolveAllocation(options.allocationPolicy);

  const announcedTaskIds = (beliefs: BeliefBase): string[] => {
    const ids = new Set<string>();
    for (const task of seedTasks) ids.add(task.id);
    for (const taskId of prefixIds(beliefs, `msg.${taskKey("")}`)) {
      ids.add(taskId);
    }
    for (const taskId of prefixIds(beliefs, "coordinator.result.")) {
      ids.add(taskId);
    }
    return Array.from(ids);
  };

  const outstandingTaskIds = (beliefs: BeliefBase): string[] =>
    announcedTaskIds(beliefs).filter(
      (taskId) => !beliefs.has(`coordinator.result.${taskId}`),
    );

  const postedResultIds = (beliefs: BeliefBase): string[] =>
    prefixIds(beliefs, `msg.${resultKey("")}`);

  const lib = new PlanLibrary();

  lib.register({
    name: "coordinator-publish-tasks",
    trigger: (beliefs) =>
      seedTasks.length > 0 &&
      !beliefs.get<boolean>("coordinator.tasksPublished"),
    body: [
      {
        name: "publish",
        execute: async (): Promise<ActionResult> => ({
          beliefUpdates: [{ key: "coordinator.tasksPublished", value: true }],
          messages: seedTasks.map((task) => ({
            topic: topics.tasks,
            performative: "inform" as const,
            content: { [taskKey(task.id)]: task.payload },
          })),
        }),
      },
    ],
  });

  const unassignedClaimedTasks = (beliefs: BeliefBase): string[] =>
    announcedTaskIds(beliefs).filter(
      (taskId) =>
        !beliefs.has(`coordinator.owner.${taskId}`) &&
        workers.some((worker) =>
          beliefs.has(`msg.${claimKey(taskId, worker)}`),
        ),
    );

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

          for (const taskId of announcedTaskIds(beliefs)) {
            const existing = beliefs.get<string>(`coordinator.owner.${taskId}`);
            if (existing) {
              owners[taskId] = existing;
              continue;
            }

            const candidates = workers.filter((worker) =>
              beliefs.has(`msg.${claimKey(taskId, worker)}`),
            );
            if (candidates.length === 0) continue;

            const worker = allocate(candidates, owners);
            if (!worker) continue;

            owners[taskId] = worker;
            beliefUpdates.push({
              key: `coordinator.owner.${taskId}`,
              value: worker,
            });
            beliefUpdates.push({
              key: `coordinator.claims.${taskId}`,
              value: candidates.length,
            });
            messages.push({
              topic: topics.grants,
              performative: "inform",
              content: { [grantKey(taskId)]: { taskId, worker } },
            });
            onTaskAssigned?.(taskId, worker);
          }

          return { beliefUpdates, messages };
        },
      },
    ],
  });

  lib.register({
    name: "coordinator-record-results",
    trigger: (beliefs) =>
      postedResultIds(beliefs).some(
        (taskId) => !beliefs.has(`coordinator.result.${taskId}`),
      ),
    body: [
      {
        name: "record",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const beliefUpdates: Array<{ key: string; value: unknown }> = [];
          for (const taskId of postedResultIds(beliefs)) {
            if (beliefs.has(`coordinator.result.${taskId}`)) continue;
            const value = beliefs.get<TValue>(`msg.${resultKey(taskId)}`);
            if (value === undefined) continue;
            const worker = beliefs.get<string>(`coordinator.owner.${taskId}`);
            beliefUpdates.push({
              key: `coordinator.result.${taskId}`,
              value,
            });
            beliefUpdates.push({
              key: `coordinator.resultWorker.${taskId}`,
              value: worker,
            });
            onResult?.(taskId, value, worker);
          }
          return { beliefUpdates };
        },
      },
    ],
  });

  lib.register({
    name: "coordinator-reopen",
    trigger: (beliefs) =>
      beliefs.get<boolean>("coordinator.done") === true &&
      outstandingTaskIds(beliefs).length > 0,
    body: [
      {
        name: "reopen",
        execute: async (): Promise<ActionResult> => ({
          beliefRemovals: ["coordinator.done"],
        }),
      },
    ],
  });

  lib.register({
    name: "coordinator-complete",
    trigger: (beliefs) =>
      outstandingTaskIds(beliefs).length === 0 &&
      announcedTaskIds(beliefs).length > 0 &&
      !beliefs.get<boolean>("coordinator.done"),
    body: [
      {
        name: "finish",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const list: CoordinatorResult<TValue>[] = announcedTaskIds(beliefs)
            .filter((taskId) => beliefs.has(`coordinator.result.${taskId}`))
            .map((taskId) => ({
              taskId,
              worker: beliefs.get<string>(`coordinator.resultWorker.${taskId}`),
              value: beliefs.get<TValue>(`coordinator.result.${taskId}`)!,
            }));
          onAllComplete?.(list);
          return { beliefUpdates: [{ key: "coordinator.done", value: true }] };
        },
      },
    ],
  });

  const agent = new Agent({ id, bus, planLibrary: lib });
  agent.subscribe(topics.claims);
  agent.subscribe(topics.tasks);
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
        worker: agent.beliefs.get<string>(`coordinator.resultWorker.${taskId}`),
        value,
      };
    },
    owners: () => {
      const owners: Record<string, string> = {};
      for (const taskId of announcedTaskIds(agent.beliefs)) {
        const worker = agent.beliefs.get<string>(`coordinator.owner.${taskId}`);
        if (worker) owners[taskId] = worker;
      }
      return owners;
    },
    results: () =>
      announcedTaskIds(agent.beliefs).flatMap((taskId) => {
        const value = agent.beliefs.get<TValue>(`coordinator.result.${taskId}`);
        if (value === undefined) return [];
        return [
          {
            taskId,
            worker: agent.beliefs.get<string>(
              `coordinator.resultWorker.${taskId}`,
            ),
            value,
          },
        ];
      }),
    isComplete: () => agent.beliefs.get<boolean>("coordinator.done") === true,
  };
}
