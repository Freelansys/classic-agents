/**
 * Delegation: a shop takes an order and hands its parts off.
 *
 * - "pack" is a sub-goal the shop serves itself (a self-delegation).
 * - "pick" is delegated to the warehouse, whose plan answers with a `result`.
 * - "deliver" is delegated to the courier, which sends progress notes.
 * - "audit" is spawned: independent work the order never waits for.
 *
 * The shop's plan resumes once all three delegations are done, reads their
 * results, and answers the customer with a `result` of its own.
 *
 * Run with `npm run example:delegation`.
 */
import { InMemoryMessageBus } from "../bus/index.js";
import type { Message } from "../bus/index.js";
import { Agent, PlanLibrary } from "../core/index.js";
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

async function main(): Promise<void> {
  const bus = new InMemoryMessageBus();

  // --- The shop: splits an order into delegations, then answers it. ---
  const shop = new Agent({
    id: "shop",
    bus,
    planLibrary: library(
      {
        name: "order",
        body: [
          step("split", async (intention) => {
            const { orderId } = intention.goal.data as { orderId: string };
            return {
              delegations: [
                { goal: "pack", view: { orderId } },
                { receiver: "warehouse", goal: "pick", view: { orderId } },
                { receiver: "courier", goal: "deliver", view: { orderId } },
              ],
              spawn: [{ name: "audit", priority: 1, data: { orderId } }],
            };
          }),
          // Runs once every delegation is done.
          step("confirm", async (intention): Promise<ActionResult> => {
            const bin = intention.delegations.find((d) => d.goal === "pick")
              ?.result as { bin: string };
            return { result: { shipped: true, from: bin.bin } };
          }),
        ],
      },
      { name: "pack", body: [step("box"), step("tape")] },
      {
        name: "audit",
        body: [
          step("log", async (intention) => {
            console.log("  [shop] audit logged for", intention.goal.data);
            return {};
          }),
        ],
      },
    ),
  });

  // --- The warehouse: finds the item and answers where it was. ---
  const warehouse = new Agent({
    id: "warehouse",
    bus,
    planLibrary: library({
      name: "pick",
      body: [
        step("walk"),
        step("found", async () => ({ result: { bin: "A3" } })),
      ],
    }),
  });

  // --- The courier: reports each leg back to whoever asked. ---
  const leg = (km: number): Action =>
    step(`leg-${km}`, async (intention) => ({
      messages: [
        {
          receiver: intention.goal.source!.sender,
          performative: "inform",
          content: { goal: "deliver", km },
        },
      ],
    }));
  const courier = new Agent({
    id: "courier",
    bus,
    planLibrary: library({
      name: "deliver",
      body: [leg(5), leg(10), leg(15)],
    }),
  });

  // Watch the shop's side of it.
  shop.on("intention:delegated", ({ delegations }) =>
    console.log(
      "  [shop] delegated:",
      delegations.map((d) => `${d.goal} → ${d.receiver}`).join(", "),
    ),
  );
  shop.on("delegation:progress", ({ delegation }) =>
    console.log(`  [shop] ${delegation.goal} progress:`, delegation.progress),
  );
  shop.on("delegation:settled", ({ delegation }) =>
    console.log(
      `  [shop] ${delegation.goal} ${delegation.status}`,
      delegation.result ?? "",
    ),
  );

  // The customer is a plain inbox: it sees exactly what goes on the wire.
  bus.registerAgent("customer", (msg: Message) =>
    console.log(`  [customer] ${msg.performative}`, msg.content),
  );

  await Promise.all([shop.start(), warehouse.start(), courier.start()]);

  console.log("=== Delegation demo ===\n");
  await bus.send("shop", {
    performative: "request",
    sender: "customer",
    receiver: "shop",
    content: { goal: "order", orderId: "o-1" },
    timestamp: Date.now(),
  });

  for (let i = 0; i < 12; i++) {
    await shop.tick();
    await warehouse.tick();
    await courier.tick();
  }

  await Promise.all([shop.stop(), warehouse.stop(), courier.stop()]);
}

main().catch(console.error);
