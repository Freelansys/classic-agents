/**
 * Concurrent root-finding with two worker agents supervised by a
 * coordinator, all coordinated over pub/sub topics.
 *
 * Flow:
 *   1. The coordinator publishes two tasks (cubic, quadratic) to "tasks".
 *   2. Both workers subscribe to "tasks" and RACE to claim them: each
 *      worker publishes claims to "claims" as soon as it sees a task.
 *   3. The coordinator records claims and grants each task to one worker
 *      (a worker never receives more than one task) via topic "grants".
 *      Claim arbitration uses belief.compareAndSet/update on the
 *      coordinator's own store — with a shared store, workers could
 *      claim directly the same way.
 *   4. The granted worker bisects, one step per tick, then publishes its
 *      result to "results".
 *   5. The coordinator tracks each function as a Goal and marks it
 *      achieved once its result arrives; when both are in it prints a
 *      summary.
 *
 * Agents keep separate belief stores; coordination happens purely over
 * the bus. Task/result state lives under per-function keys (msg.task.cubic,
 * cubic.a, cubic.done, ...) so the two tasks never clobber each other.
 */

import { InMemoryMessageBus } from "../bus/index.js";
import { Agent, PlanLibrary } from "../core/index.js";
import type { ActionResult, Plan } from "../core/index.js";

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

const bus = new InMemoryMessageBus();

type Claim = { functionName: string; worker: string };

// --- Worker agent ---------------------------------------------------------
// Generic: subscribes to "tasks" + "grants", claims any task it sees, then
// bisects the task it was granted and publishes the result.
function makeWorker(id: string): Agent {
  const lib = new PlanLibrary();

  const claim: Plan = {
    name: "claim-task",
    trigger: (beliefs) =>
      FUNCTION_NAMES.some(
        (fn) => beliefs.has(`msg.task.${fn}`) && !beliefs.has(`claimed.${fn}`),
      ),
    body: [
      {
        name: "publish-claims",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const messages = [];
          const beliefUpdates = [];
          for (const fn of FUNCTION_NAMES) {
            if (
              beliefs.has(`msg.task.${fn}`) &&
              !beliefs.has(`claimed.${fn}`)
            ) {
              messages.push({
                topic: "claims",
                performative: "inform" as const,
                content: {
                  [`claim.${id}.${fn}`]: { functionName: fn, worker: id },
                },
              });
              beliefUpdates.push({ key: `claimed.${fn}`, value: true });
            }
          }
          console.log(`[${id}] claimed ${beliefUpdates.length} task(s)`);
          return { messages, beliefUpdates };
        },
      },
    ],
  };

  const bisect: Plan = {
    name: "bisect-step",
    trigger: (beliefs) =>
      FUNCTION_NAMES.some(
        (fn) =>
          beliefs.get<Claim>(`msg.grant.${fn}`)?.worker === id &&
          !beliefs.get<boolean>(`${fn}.done`),
      ),
    body: [
      {
        name: "advance-bisection",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const fn = FUNCTION_NAMES.find(
            (name) =>
              beliefs.get<Claim>(`msg.grant.${name}`)?.worker === id &&
              !beliefs.get<boolean>(`${name}.done`),
          )!;
          const f = FUNCTIONS[fn]!;

          const aKey = `${fn}.a`;
          const bKey = `${fn}.b`;

          if (!beliefs.has(aKey)) {
            await beliefs.set(aKey, 1);
            await beliefs.set(bKey, 2);
            await beliefs.set(`${fn}.iterations`, 0);
          }

          const a = beliefs.get<number>(aKey)!;
          const b = beliefs.get<number>(bKey)!;
          const iterations = beliefs.get<number>(`${fn}.iterations`) ?? 0;
          const mid = (a + b) / 2;
          const fa = f(a);
          const fm = f(mid);

          console.log(`[${id}] ${fn} iter ${iterations}: ${mid.toFixed(7)}`);
          const converged = b - a < TOLERANCE || Math.abs(fm) < TOLERANCE;
          const exhausted = iterations + 1 >= MAX_ITERATIONS;

          if (converged || exhausted) {
            return {
              beliefUpdates: [
                { key: `${fn}.root`, value: mid },
                { key: `${fn}.done`, value: true },
                { key: `${fn}.iterations`, value: iterations + 1 },
              ],
            };
          }

          const sameSignAsA = Math.sign(fa) === Math.sign(fm);
          const [newA, newB] = sameSignAsA ? [mid, b] : [a, mid];
          return {
            beliefUpdates: [
              { key: aKey, value: newA },
              { key: bKey, value: newB },
              { key: `${fn}.iterations`, value: iterations + 1 },
            ],
          };
        },
      },
    ],
  };

  const report: Plan = {
    name: "publish-result",
    trigger: (beliefs) =>
      FUNCTION_NAMES.some(
        (fn) =>
          beliefs.get<boolean>(`${fn}.done`) && !beliefs.has(`reported.${fn}`),
      ),
    body: [
      {
        name: "publish-result-msg",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const messages = [];
          const beliefUpdates = [];
          for (const fn of FUNCTION_NAMES) {
            if (
              beliefs.get<boolean>(`${fn}.done`) &&
              !beliefs.has(`reported.${fn}`)
            ) {
              messages.push({
                topic: "results",
                performative: "inform" as const,
                content: {
                  [`result.${fn}`]: {
                    functionName: fn,
                    root: beliefs.get<number>(`${fn}.root`),
                    iterations: beliefs.get<number>(`${fn}.iterations`),
                    worker: id,
                  },
                },
              });
              beliefUpdates.push({ key: `reported.${fn}`, value: true });
              console.log(`[${id}] published result for ${fn}`);
            }
          }
          return { messages, beliefUpdates };
        },
      },
    ],
  };

  lib.register(claim);
  lib.register(bisect);
  lib.register(report);

  const agent = new Agent({ id, bus, planLibrary: lib });
  agent.subscribe("tasks");
  agent.subscribe("grants");
  return agent;
}

// --- Coordinator agent -----------------------------------------------------
// Publishes the tasks, arbitrates claims, and tracks the end-to-end goals.
function makeCoordinator(): Agent {
  const lib = new PlanLibrary();

  const publishTasks: Plan = {
    name: "publish-tasks",
    trigger: (beliefs) => !beliefs.get<boolean>("tasksPublished"),
    body: [
      {
        name: "announce",
        execute: async (): Promise<ActionResult> => ({
          beliefUpdates: [{ key: "tasksPublished", value: true }],
          messages: FUNCTION_NAMES.map((fn) => ({
            topic: "tasks",
            performative: "inform" as const,
            content: { [`task.${fn}`]: { functionName: fn } },
          })),
        }),
      },
    ],
  };

  const arbitrate: Plan = {
    name: "record-claim",
    trigger: (beliefs) =>
      FUNCTION_NAMES.some(
        (fn) =>
          !beliefs.has(`owner.${fn}`) &&
          WORKER_IDS.some((worker) => beliefs.has(`msg.claim.${worker}.${fn}`)),
      ),
    body: [
      {
        name: "grant",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const messages = [];
          for (const fn of FUNCTION_NAMES) {
            if (beliefs.has(`owner.${fn}`)) continue;
            for (const worker of WORKER_IDS) {
              if (!beliefs.has(`msg.claim.${worker}.${fn}`)) continue;

              const ownsOther = FUNCTION_NAMES.some(
                (other) =>
                  other !== fn && beliefs.get(`owner.${other}`) === worker,
              );
              if (ownsOther) {
                console.log(`[coordinator] denied ${worker} for ${fn}`);
                continue;
              }

              await beliefs.set(`owner.${fn}`, worker);
              await beliefs.update<number>(`claims.${fn}`, (n) => (n ?? 0) + 1);
              messages.push({
                topic: "grants",
                performative: "inform" as const,
                content: {
                  [`grant.${fn}`]: { functionName: fn, worker },
                },
              });
              console.log(`[coordinator] granted ${fn} -> ${worker}`);
              break;
            }
          }
          return { messages };
        },
      },
    ],
  };

  const recordResult: Plan = {
    name: "record-result",
    trigger: (beliefs) =>
      FUNCTION_NAMES.some(
        (fn) =>
          beliefs.has(`msg.result.${fn}`) && !beliefs.has(`result.${fn}.root`),
      ),
    body: [
      {
        name: "store",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const beliefUpdates = [];
          for (const fn of FUNCTION_NAMES) {
            const result = beliefs.get<{
              functionName: string;
              root: number;
              iterations: number;
              worker: string;
            }>(`msg.result.${fn}`);
            if (result && !beliefs.has(`result.${fn}.root`)) {
              beliefUpdates.push({
                key: `result.${fn}.root`,
                value: result.root,
              });
              beliefUpdates.push({
                key: `result.${fn}.worker`,
                value: result.worker,
              });
              console.log(`[coordinator] recorded result for ${fn}`);
            }
          }
          return { beliefUpdates };
        },
      },
    ],
  };

  // Goal-triggered: mark each function's goal achieved once its result is in.
  for (const fn of FUNCTION_NAMES) {
    lib.register({
      name: `complete-${fn}`,
      trigger: (beliefs, goal) =>
        goal.name === `findRoot-${fn}` && beliefs.has(`result.${fn}.root`),
      body: [
        {
          name: "mark-achieved",
          execute: async (): Promise<ActionResult> => ({}),
        },
      ],
    });
  }

  const summarize: Plan = {
    name: "all-done",
    trigger: (beliefs) =>
      FUNCTION_NAMES.every((fn) => beliefs.has(`result.${fn}.root`)) &&
      !beliefs.get<boolean>("summaryDone"),
    body: [
      {
        name: "print-summary",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          console.log("\n=== Coordinator summary ===");
          for (const fn of FUNCTION_NAMES) {
            console.log(
              `${fn}: root = ${beliefs
                .get<number>(`result.${fn}.root`)
                ?.toFixed(7)} (worker ${beliefs.get(`result.${fn}.worker`)})`,
            );
          }
          return {
            beliefUpdates: [{ key: "summaryDone", value: true }],
          };
        },
      },
    ],
  };

  lib.register(publishTasks);
  lib.register(arbitrate);
  lib.register(recordResult);
  lib.register(summarize);

  const agent = new Agent({ id: "coordinator", bus, planLibrary: lib });
  agent.subscribe("claims");
  agent.subscribe("results");

  for (const fn of FUNCTION_NAMES) {
    agent.goals.add({
      id: `goal-${fn}`,
      name: `findRoot-${fn}`,
      priority: 5,
      status: "pending",
    });
  }
  return agent;
}

// --- Run it --------------------------------------------------------------
async function main(): Promise<void> {
  const coordinator = makeCoordinator();
  const workers = WORKER_IDS.map((id) => makeWorker(id));
  const [alpha, beta] = workers;

  coordinator.start();
  alpha.start();
  beta.start();

  let ticks = 0;
  const maxTicks = 300;
  while (ticks < maxTicks && !coordinator.beliefs.get<boolean>("summaryDone")) {
    await Promise.all([coordinator.tick(), alpha.tick(), beta.tick()]);
    ticks++;
  }

  console.log(`\n(completed in ${ticks} shared ticks)\n`);
  console.log("Coordinator assignments:");
  for (const fn of FUNCTION_NAMES) {
    console.log(`  ${fn} -> ${coordinator.beliefs.get(`owner.${fn}`)}`);
  }
  const tracked = coordinator.goals
    .all()
    .filter((g) => g.name.startsWith("findRoot-"))
    .map((g) => ({ name: g.name, status: g.status }));
  console.log("Coordinator tracked goals:", tracked);

  coordinator.stop();
  alpha.stop();
  beta.stop();
}

main().catch(console.error);
