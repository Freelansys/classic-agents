/**
 * Concurrent root-finding with two worker agents supervised by the
 * built-in coordinator (createCoordinator), all coordinated over a
 * real Redis instance via RedisMessageBus.
 *
 * This is the distributed counterpart of find_root_coordinator.ts —
 * every message flows through Redis Streams (point-to-point mailboxes)
 * and Redis Pub/Sub (topic channels), so the coordinator and workers
 * can run in separate processes on different machines.
 *
 * Flow:
 *   1. createCoordinator publishes one task per function to "tasks".
 *   2. Both workers subscribe to "tasks" and race to claim them:
 *      each worker publishes claims to "claims" as soon as it sees a task.
 *   3. The coordinator grants each task to one worker (never more than
 *      one per worker, via the "no-repeat" policy) on "grants".
 *   4. The granted worker bisects, one step per tick, then publishes its
 *      result to "results".
 *   5. Once every task has a result, onAllComplete prints the summary.
 *
 * Run with:  tsx src/examples/find_root_redis.ts
 * Requires: Redis on localhost:6379 (docker run -p 6379:6379 redis)
 */

import { createClient } from "redis";
import { RedisMessageBus } from "../bus/index.js";
import { createCoordinator, createWorker } from "../contract-net/index.js";
import type { WorkerStepResult } from "../contract-net/index.js";

// --- A small registry of functions, referenced by name so messages stay
//     JSON-serializable (works over an in-memory, Redis, or NATS bus).
const FUNCTIONS: Record<string, (x: number) => number> = {
  cubic: (x) => x ** 3 - x - 2, // root near x ≈ 1.5214
  quadratic: (x) => x ** 2 - 2, // root near x ≈ 1.4142
};

const FUNCTION_NAMES = Object.keys(FUNCTIONS);
const WORKER_IDS = ["worker-alpha", "worker-beta"];
const TOLERANCE = 1e-7;
const MAX_ITERATIONS = 100;

// Connect to Redis — override with REDIS_URL env var or a custom URL.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

interface RootResult {
  functionName: string;
  root: number;
  iterations: number;
  worker: string;
}

// --- Worker agent ---------------------------------------------------------
// createWorker claims any announced task and runs `step` once per tick for
// every task granted to it. The only logic left here is the bisection step:
// it advances the bracket stored in beliefs and reports when converged.
function makeWorker(id: string, bus: RedisMessageBus) {
  return createWorker<{ functionName: string }, RootResult>({
    id,
    bus,
    onClaimed: (taskId) => console.log(`[${id}] claimed ${taskId}`),
    onResult: (taskId) => console.log(`[${id}] published result for ${taskId}`),
    step: (taskId, task, beliefs): WorkerStepResult => {
      const f = FUNCTIONS[task.functionName];

      const aKey = `${taskId}.a`;
      const bKey = `${taskId}.b`;

      if (!beliefs.has(aKey)) {
        beliefs.set(aKey, 1);
        beliefs.set(bKey, 2);
        beliefs.set(`${taskId}.iterations`, 0);
      }

      const a = beliefs.get<number>(aKey)!;
      const b = beliefs.get<number>(bKey)!;
      const iterations = beliefs.get<number>(`${taskId}.iterations`) ?? 0;
      const mid = (a + b) / 2;
      const fa = f(a);
      const fm = f(mid);

      console.log(`[${id}] ${taskId} iter ${iterations}: ${mid.toFixed(7)}`);
      const converged = b - a < TOLERANCE || Math.abs(fm) < TOLERANCE;
      const exhausted = iterations + 1 >= MAX_ITERATIONS;

      if (converged || exhausted) {
        return {
          done: true,
          result: {
            functionName: taskId,
            root: mid,
            iterations: iterations + 1,
            worker: id,
          },
        };
      }

      const sameSignAsA = Math.sign(fa) === Math.sign(fm);
      const [newA, newB] = sameSignAsA ? [mid, b] : [a, mid];
      beliefs.set(aKey, newA);
      beliefs.set(bKey, newB);
      beliefs.set(`${taskId}.iterations`, iterations + 1);
      return { done: false };
    },
  });
}

// --- Run it ---------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`Connecting to Redis at ${REDIS_URL}\n`);

  // Verify Redis is reachable before starting the bus.
  const testClient = createClient({ url: REDIS_URL });
  try {
    await testClient.connect();
    const pong = await testClient.ping();
    console.log("Redis ping:", pong);
    await testClient.quit();
  } catch (err) {
    console.error(
      "Failed to connect to Redis:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  const bus = new RedisMessageBus({ url: REDIS_URL, readTimeoutMs: 500 });

  const coordinator = createCoordinator<{ functionName: string }, RootResult>({
    id: "coordinator",
    bus,
    workers: WORKER_IDS,
    tasks: FUNCTION_NAMES.map((fn) => ({
      id: fn,
      payload: { functionName: fn },
    })),
    allocationPolicy: "no-repeat",
    onTaskAssigned: (taskId, worker) =>
      console.log(`[coordinator] granted ${taskId} -> ${worker}`),
    onAllComplete: (results) => {
      console.log("\n=== Coordinator summary ===");
      for (const result of results) {
        console.log(
          `${result.value.functionName}: root = ${result.value.root.toFixed(7)} ` +
            `(worker ${result.value.worker}, ${result.value.iterations} iterations)`,
        );
      }
    },
  });

  const workers = WORKER_IDS.map((id) => makeWorker(id, bus));

  // Start agents and wait until each is fully connected and every topic
  // subscription is live — start() is async and resolves only after Redis
  // has acknowledged the SUBSCRIBEs. No sleeps needed: once these resolve,
  // the coordinator cannot publish before the workers are subscribed.
  await Promise.all([coordinator.start(), ...workers.map((w) => w.start())]);

  const maxTicks = 10000;
  let ticks = 0;
  while (ticks < maxTicks && !coordinator.isComplete()) {
    await Promise.all([coordinator.tick(), ...workers.map((w) => w.tick())]);
    ticks++;
  }

  if (!coordinator.isComplete()) {
    console.error(`\n(did not complete within ${maxTicks} ticks)`);
  }

  console.log(`\n(completed in ${ticks} shared ticks)`);
  console.log("Coordinator assignments:");
  for (const [fn, worker] of Object.entries(coordinator.owners())) {
    console.log(`  ${fn} -> ${worker}`);
  }

  await Promise.all([coordinator.stop(), ...workers.map((w) => w.stop())]);
  await bus.disconnect();
  console.log("Disconnected from Redis, exiting.");
}

main().catch(console.error);
