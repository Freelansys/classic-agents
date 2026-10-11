/**
 * Contract Net: a builder calls for quotes and awards the job to the cheapest.
 *
 * - The builder's plan opens a call for proposals for "pave", inviting two
 *   pavers, waits until every call has closed, then awards the lowest bid.
 * - Each paver opts in by naming a `bid` expression on its plan, computing a
 *   price from its own beliefs; the result becomes the `propose`'s terms.
 * - The winner is sent `accept-proposal`, does the work, and answers with an
 *   `inform`; the loser is sent `reject-proposal` automatically.
 *
 * Run with `npm run example:contract-net`.
 */
import { InMemoryMessageBus } from "../bus/index.js";
import type { Message } from "../bus/index.js";
import { Agent, ExpressionLibrary, PlanLibrary } from "../core/index.js";
import type { Action, ActionResult, Plan } from "../core/index.js";

function library(...plans: Plan[]): PlanLibrary {
  const lib = new PlanLibrary();
  for (const plan of plans) lib.register(plan);
  return lib;
}

const step = (
  name: string,
  execute: Action["execute"] = async () => ({}),
): Action => ({ name, execute });

/** A paver that bids its own price — or declines with `null` — then works if it wins. */
function paver(
  bus: InMemoryMessageBus,
  id: string,
  price: number | null,
): Agent {
  const expressions = new ExpressionLibrary();
  expressions.register({
    name: "quote",
    evaluate: (_beliefs, cfp) => {
      const { goal } = cfp.content as { goal: string };
      if (price === null) {
        console.log(`  [${id}] declining "${goal}"`);
        return null;
      }
      console.log(`  [${id}] quoting ${price} for "${goal}"`);
      return { price };
    },
  });
  return new Agent({
    id,
    bus,
    expressionLibrary: expressions,
    planLibrary: library({
      name: "pave",
      bid: "quote",
      body: [
        step("lay", async (): Promise<ActionResult> => ({
          result: { pavedBy: id },
        })),
      ],
    }),
  });
}

async function main(): Promise<void> {
  const bus = new InMemoryMessageBus();

  const builder = new Agent({
    id: "builder",
    bus,
    planLibrary: library({
      name: "build",
      body: [
        step("call", async () => ({
          calls: [
            { goal: "pave", receivers: ["paver-a", "paver-b", "paver-c"] },
          ],
        })),
        // Runs once every call has closed.
        step("award", async (intention): Promise<ActionResult> => {
          const bids = intention.calls.flatMap((call) => call.proposals);
          console.log(
            "  [builder] bids:",
            bids
              .map(
                (p) => `${p.sender}=${(p.terms as { price: number }).price}`,
              )
              .join(", "),
          );
          if (bids.length === 0) return { failure: { reason: "no bids" } };
          const cheapest = bids
            .slice()
            .sort(
              (a, b) =>
                (a.terms as { price: number }).price -
                (b.terms as { price: number }).price,
            )[0];
          return { awards: [{ proposal: cheapest.id }] };
        }),
      ],
    }),
  });
  const a = paver(bus, "paver-a", 30);
  const b = paver(bus, "paver-b", 15);
  const c = paver(bus, "paver-c", null);

  builder.on("intention:delegated", ({ delegations }) =>
    console.log(
      "  [builder] awarded:",
      delegations.map((d) => `${d.goal} → ${d.receiver}`).join(", "),
    ),
  );
  builder.on("delegation:settled", ({ delegation }) =>
    console.log(
      `  [builder] ${delegation.goal} ${delegation.status}`,
      delegation.result ?? "",
    ),
  );

  // The customer is a plain inbox: it sees exactly what goes on the wire.
  bus.registerAgent("customer", (msg: Message) =>
    console.log(`  [customer] ${msg.performative}`, msg.content),
  );

  await Promise.all([builder.start(), a.start(), b.start(), c.start()]);

  console.log("=== Contract Net demo ===\n");
  await bus.send("builder", {
    performative: "request",
    sender: "customer",
    receiver: "builder",
    content: { goal: "build" },
    timestamp: Date.now(),
  });

  for (let i = 0; i < 15; i++) {
    await builder.tick();
    await a.tick();
    await b.tick();
    await c.tick();
  }

  await Promise.all([builder.stop(), a.stop(), b.stop(), c.stop()]);
}

main().catch(console.error);
