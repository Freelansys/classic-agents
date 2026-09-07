/**
 * Bisection-method root finder as a BDI agent, extended to receive its
 * task over the message bus instead of having beliefs poked in directly.
 * https://github.com/raminb-dls/classic-agents
 *
 * Flow:
 *   1. A "coordinator" (just plain code here, not a second Agent) sends
 *      the bisector agent a request message: { goal: "find-root", functionName, a, b }.
 *   2. On its next tick(), the agent's Perceive step drains the mailbox
 *      and turns that message into beliefs (msg.goal, msg.functionName,
 *      msg.a, msg.b) — this is the same "msg.*" convention the README's
 *      belief-triggered example uses.
 *   3. A "start-root-search" plan reacts to msg.type === "find-root":
 *      it registers an explicit Goal (the agent's Desire, now made
 *      concrete instead of just implicit) and seeds a/b/iterations/done.
 *   4. The existing belief-triggered "bisect-step" plan takes it from
 *      there exactly as before, one step per tick, until done.
 *
 * NOTE ON UNCONFIRMED APIs: I couldn't pull the compiled .d.ts for this
 * package, so a few calls below are my best inference from the README
 * rather than confirmed signatures — flagged inline with NOTE comments.
 * If TypeScript complains, check node_modules/classic-agents/dist/*.d.ts
 * for the exact shape.
 */

import { Agent, InMemoryMessageBus, PlanLibrary } from "classic-agents";

// --- A small registry of functions, so the message can reference one
//     by name (a real function value wouldn't survive a non-in-memory
//     bus like Redis/NATS, so this keeps the message JSON-serializable).
const FUNCTIONS: Record<string, (x: number) => number> = {
  cubic: (x) => x ** 3 - x - 2, // root near x ≈ 1.5214
  quadratic: (x) => x ** 2 - 2, // root near x ≈ 1.4142
};

const TOLERANCE = 1e-7;
const MAX_ITERATIONS = 100;

// --- Wire up the BDI machinery ------------------------------------------
const bus = new InMemoryMessageBus();
const lib = new PlanLibrary();

// Plan 1: react to an inbound "find-root" request message.
lib.register({
  name: "start-root-search",
  trigger: (_, goal) => goal.name === "find-root",
  body: [
    {
      name: "accept-request",
      execute: async (intention, _beliefs) => {
        const goalData = intention.goal.data as Record<string, unknown>;
        const functionName = goalData.functionName as string;
        const a = goalData.a as number;
        const b = goalData.b as number;

        console.log(
          `[perceive] got request: find-root(${functionName}, [${a}, ${b}])`
        );

        return {
          beliefUpdates: [
            { key: "functionName", value: functionName },
            { key: "a", value: a },
            { key: "b", value: b },
            { key: "iterations", value: 0 },
            { key: "done", value: false },
            { key: "started", value: true },
          ],
        };
      },
    },
  ],
});

// Plan 2: one bisection step per cycle
lib.register({
  name: "bisect-step",
  trigger: (beliefs) => {
    const started = beliefs.get<boolean>("started");
    const done = beliefs.get<boolean>("done");
    return started === true && !done;
  },
  body: [
    {
      name: "evaluate-midpoint",
      execute: async (intention, beliefs) => {
        const functionName = beliefs.get<string>("functionName")!;
        const f = FUNCTIONS[functionName]!;

        const a = beliefs.get<number>("a")!;
        const b = beliefs.get<number>("b")!;
        const iterations = beliefs.get<number>("iterations") ?? 0;

        const mid = (a + b) / 2;
        const fa = f(a);
        const fm = f(mid);

        const bracketWidth = b - a;
        const converged = bracketWidth < TOLERANCE || Math.abs(fm) < TOLERANCE;
        const exhausted = iterations + 1 >= MAX_ITERATIONS;

        console.log(
          `iter ${iterations}: a=${a.toFixed(7)} b=${b.toFixed(7)} ` +
            `mid=${mid.toFixed(7)} f(mid)=${fm.toFixed(7)}`
        );

        if (converged || exhausted) {
          return {
            beliefUpdates: [
              { key: "root", value: mid },
              { key: "done", value: true },
              { key: "iterations", value: iterations + 1 },
            ],
          };
        }

        const sameSignAsA = Math.sign(fa) === Math.sign(fm);
        const [newA, newB] = sameSignAsA ? [mid, b] : [a, mid];

        return {
          beliefUpdates: [
            { key: "a", value: newA },
            { key: "b", value: newB },
            { key: "iterations", value: iterations + 1 },
          ],
        };
      },
    },
  ],
});

// --- Run it --------------------------------------------------------------
async function main() {
  const agent = new Agent({ id: "bisector-1", bus, planLibrary: lib });
  agent.start();

  bus.send("bisector-1", {
    performative: "request",
    sender: "coordinator",
    content: {
      goal: "find-root",
      functionName: "cubic",
      a: 1,
      b: 2
    },
    timestamp: Date.now(),
  });

  // Drive the reasoning cycle. The first tick() perceives the message
  // and runs "start-root-search"; subsequent ticks run "bisect-step".
  while (!agent.beliefs.get<boolean>("done")) {
    await agent.tick();
  }

  console.log("\nRoot found:", agent.beliefs.get<number>("root"));
  agent.stop();
}

main();
