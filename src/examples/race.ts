/**
 * A race: ask three suppliers for a quote and take the first one.
 *
 * `waitFor: "any"` resumes the buyer's plan as soon as one delegation is done
 * and cancels the rest. A supplier that fails on the way does not end the
 * race; only all three failing would.
 *
 * Run with `npm run example:race`.
 */
import { InMemoryMessageBus } from "../bus/index.js";
import { Agent, PlanLibrary } from "../core/index.js";
import type { Action, ActionResult } from "../core/index.js";

/** A supplier that takes `steps` cycles to quote, or fails instead. */
function supplier(
  bus: InMemoryMessageBus,
  id: string,
  steps: number,
  answer: ActionResult,
): Agent {
  const body: Action[] = Array.from({ length: steps }, (_, i) => ({
    name: `work-${i}`,
    execute: async () => ({}),
  }));
  body.push({ name: "answer", execute: async () => answer });
  const plans = new PlanLibrary();
  // Cancellable, so a supplier that lost the race actually stops.
  plans.register({ name: "quote", cancellable: true, body });
  const agent = new Agent({ id, bus, planLibrary: plans });
  agent.on("goal:cancelled", () => console.log(`  [${id}] told to stop`));
  return agent;
}

async function main(): Promise<void> {
  const bus = new InMemoryMessageBus();

  const suppliers = [
    supplier(bus, "closed-shop", 0, { failure: { reason: "closed today" } }),
    supplier(bus, "quick-shop", 2, { result: { price: 12 } }),
    supplier(bus, "slow-shop", 10, { result: { price: 9 } }),
  ];

  const plans = new PlanLibrary();
  plans.register({
    name: "buy",
    body: [
      {
        name: "ask",
        execute: async () => ({
          delegations: suppliers.map((s) => ({
            receiver: s.id,
            goal: "quote",
          })),
          waitFor: "any",
        }),
      },
      {
        name: "choose",
        execute: async (intention) => {
          for (const d of intention.delegations) {
            console.log(
              `  [buyer] ${d.receiver}: ${d.status}`,
              d.result ?? d.reason ?? "",
            );
          }
          const winner = intention.delegations.find((d) => d.status === "done");
          return { result: { from: winner?.receiver, quote: winner?.result } };
        },
      },
    ],
  });
  const buyer = new Agent({ id: "buyer", bus, planLibrary: plans });
  buyer.on("intention:completed", (i) =>
    console.log("  [buyer] bought:", i.result?.result),
  );

  const all = [buyer, ...suppliers];
  for (const a of all) await a.start();

  console.log("=== Race demo ===\n");
  buyer.goals.add({ id: "g", name: "buy", priority: 5, status: "pending" });
  for (let i = 0; i < 10; i++) {
    for (const a of all) await a.tick();
  }
  for (const a of all) await a.stop();
}

main().catch(console.error);
