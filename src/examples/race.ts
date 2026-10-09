/**
 * A race, or hedged request: ask three mirrors for the same exchange rate and
 * use whichever answers first.
 *
 * `waitFor: "any"` resumes the plan as soon as one delegation is done and
 * cancels the rest. A mirror that fails on the way does not end the race;
 * only all three failing would.
 *
 * A race suits work like this: interchangeable providers, and a lookup that is
 * harmless to do more than once. Choosing among providers by what they offer,
 * where only the chosen one should act, is the FIPA Contract Net's job
 * (`cfp`, `propose`, `accept-proposal`), not a race.
 *
 * Run with `npm run example:race`.
 */
import { InMemoryMessageBus } from "../bus/index.js";
import { Agent, PlanLibrary } from "../core/index.js";
import type { Action, ActionResult } from "../core/index.js";

/** A mirror that takes `steps` cycles to answer, or fails instead. */
function mirror(
  bus: InMemoryMessageBus,
  id: string,
  steps: number,
  answer: ActionResult,
): Agent {
  const body: Action[] = Array.from({ length: steps }, (_, i) => ({
    name: `lookup-${i}`,
    execute: async () => ({}),
  }));
  body.push({ name: "answer", execute: async () => answer });
  const plans = new PlanLibrary();
  // Cancellable, so a mirror that lost the race stops looking.
  plans.register({ name: "rate", cancellable: true, body });
  const agent = new Agent({ id, bus, planLibrary: plans });
  agent.on("goal:cancelled", () => console.log(`  [${id}] told to stop`));
  return agent;
}

async function main(): Promise<void> {
  const bus = new InMemoryMessageBus();

  const mirrors = [
    mirror(bus, "mirror-down", 0, { failure: { reason: "offline" } }),
    mirror(bus, "mirror-near", 2, { result: { pair: "EUR/USD", rate: 1.08 } }),
    mirror(bus, "mirror-far", 10, { result: { pair: "EUR/USD", rate: 1.08 } }),
  ];

  const plans = new PlanLibrary();
  plans.register({
    name: "convert",
    body: [
      {
        name: "ask",
        execute: async () => ({
          delegations: mirrors.map((m) => ({
            receiver: m.id,
            goal: "rate",
            view: { pair: "EUR/USD" },
          })),
          waitFor: "any",
        }),
      },
      {
        name: "convert",
        execute: async (intention) => {
          for (const d of intention.delegations) {
            console.log(
              `  [converter] ${d.receiver}: ${d.status}`,
              d.result ?? d.reason ?? "",
            );
          }
          const answer = intention.delegations.find((d) => d.status === "done");
          const { rate } = answer!.result as { rate: number };
          return {
            result: { eur: 100, usd: 100 * rate, via: answer!.receiver },
          };
        },
      },
    ],
  });
  const converter = new Agent({ id: "converter", bus, planLibrary: plans });
  converter.on("intention:completed", (i) =>
    console.log("  [converter] converted:", i.result?.result),
  );

  const all = [converter, ...mirrors];
  for (const a of all) await a.start();

  console.log("=== Race demo ===\n");
  converter.goals.add({
    id: "g",
    name: "convert",
    priority: 5,
    status: "pending",
  });
  for (let i = 0; i < 10; i++) {
    for (const a of all) await a.tick();
  }
  for (const a of all) await a.stop();
}

main().catch(console.error);
