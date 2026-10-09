/**
 * Queries read, requests compute.
 *
 * An inventory agent answers two kinds of question:
 *
 * - `query-if` / `query-ref` name a proposition or expression: a quick read of
 *   what the agent already knows, answered at once, outside the goal queue.
 * - A quote takes real work, so it is a plan the asker invokes with `request`.
 *   The plan returns its answer as `result`, and the final `inform` carries it.
 *
 * Run with `npm run example:queries`.
 */
import { InMemoryMessageBus } from "../bus/index.js";
import type { Message, Performative } from "../bus/index.js";
import {
  Agent,
  ExpressionLibrary,
  PlanLibrary,
  PropositionLibrary,
} from "../core/index.js";

/** The item a message asks about, from its content. */
const itemOf = (msg: Message): string =>
  (msg.content as { item?: string }).item ?? "";

async function main(): Promise<void> {
  const bus = new InMemoryMessageBus();

  // Quick reads: they only look beliefs up.
  const propositions = new PropositionLibrary();
  propositions.register({
    name: "in-stock",
    evaluate: (beliefs, msg) =>
      (beliefs.get<number>(`stock.${itemOf(msg)}`) ?? 0) > 0,
  });
  const expressions = new ExpressionLibrary();
  expressions.register({
    name: "stock",
    evaluate: (beliefs, msg) => beliefs.get<number>(`stock.${itemOf(msg)}`),
  });

  // Real work: a plan, invoked by request, answering with `result`.
  const plans = new PlanLibrary();
  plans.register({
    name: "quote",
    body: [
      {
        name: "price",
        execute: async (intention, beliefs) => {
          const { item, quantity } = intention.goal.data as {
            item: string;
            quantity: number;
          };
          // Stand-in for a pricing service call.
          await new Promise((r) => setTimeout(r, 20));
          const unit = beliefs.get<number>(`price.${item}`) ?? 0;
          const discount = quantity >= 10 ? 0.9 : 1;
          return {
            result: { item, quantity, total: unit * quantity * discount },
          };
        },
      },
    ],
  });

  const inventory = new Agent({
    id: "inventory",
    bus,
    planLibrary: plans,
    propositionLibrary: propositions,
    expressionLibrary: expressions,
  });
  inventory.beliefs.set("stock.widget", 12);
  inventory.beliefs.set("stock.gadget", 0);
  inventory.beliefs.set("price.widget", 2.5);

  bus.registerAgent("buyer", (msg) =>
    console.log(`  [buyer] ${msg.inReplyTo}: ${msg.performative}`, msg.content),
  );
  const ask = (performative: Performative, content: unknown, id: string) =>
    bus.send("inventory", {
      performative,
      sender: "buyer",
      receiver: "inventory",
      content,
      replyWith: id,
      timestamp: Date.now(),
    });

  await inventory.start();
  console.log("=== Queries and requests demo ===\n");

  await ask("query-if", { name: "in-stock", item: "widget" }, "q-widget");
  await ask("query-if", { name: "in-stock", item: "gadget" }, "q-gadget");
  await ask("query-ref", { name: "stock", item: "widget" }, "q-count");
  // A name nobody registered is not understood, not false.
  await ask("query-ref", { name: "price", item: "widget" }, "q-unknown");
  await ask(
    "request",
    { goal: "quote", item: "widget", quantity: 10 },
    "r-quote",
  );

  for (let i = 0; i < 6; i++) {
    await inventory.tick();
    await new Promise((r) => setTimeout(r, 10));
  }

  await inventory.stop();
}

main().catch(console.error);
