/**
 * The getting-started walkthrough, as a runnable demo.
 *
 * A pricing agent answers a request for a quote:
 *
 * 1. A `request` becomes a goal, a plan serves it, and the requester is
 *    answered `inform { done: true, result }`.
 * 2. The quote is published on a topic, and a second agent, subscribed to that
 *    topic, hears it.
 * 3. Work that cannot be done fails, and the requester is told `failure`.
 * 4. Work is split two ways: `delegations` waits for the work, `continueWith`
 *    hands the goal on instead — here, paging through a catalogue.
 * 5. Everything that happens is observable on the event stream.
 *
 * The guide that walks through this file is GETTING-STARTED.md.
 *
 * Run with `npm run example:getting-started`.
 */
import { InMemoryMessageBus } from "../bus/index.js";
import type { Message } from "../bus/index.js";
import { Agent, PlanLibrary } from "../core/index.js";
import type { Action, ActionResult, Plan } from "../core/index.js";

/** The unit prices the pricing agent knows. */
const PRICES: Record<string, number> = { widget: 12.5, gadget: 40 };

/** The catalogue the pagination loop walks through, one page at a time. */
const CATALOGUE: Record<number, string[]> = {
  1: ["widget", "gadget"],
  2: ["gizmo"],
};

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

  // --- The pricing agent: quotes, and pages through the catalogue. ---
  const pricing = new Agent({
    id: "pricing",
    bus,
    planLibrary: library(
      {
        goal: "quote",
        body: [
          // Delegated work: the plan waits for the VAT rate to come back.
          step("ask-tax", async () => ({
            delegations: [
              { receiver: "tax", goal: "vat", view: { country: "DE" } },
            ],
          })),
          // The result is the goal's answer: it goes back to the requester in
          // the terminal `inform`.
          step("total", async (intention, beliefs): Promise<ActionResult> => {
            const { item, quantity } = intention.goal.data as {
              item: string;
              quantity: number;
            };
            const unit = beliefs.get<number>(`price.${item}`);
            if (unit === undefined) {
              // A failure: the requester is told `failure { goal, reason }`.
              return { failure: { reason: `no price for ${item}` } };
            }
            const vat = intention.delegations.find((d) => d.goal === "vat")
              ?.result as { rate: number };
            const quote = {
              item,
              quantity,
              total: Number((unit * quantity * (1 + vat.rate)).toFixed(2)),
            };
            return {
              // A belief is how one step of a plan hands state to the next.
              beliefUpdates: [{ key: "lastQuote", value: quote }],
              result: quote,
            };
          }),
          // Published, so anyone subscribed to the topic hears the quote.
          step("announce", async (_intention, beliefs) => ({
            messages: [
              {
                topic: "quotes",
                performative: "inform",
                content: beliefs.get("lastQuote"),
              },
            ],
          })),
        ],
      },
      {
        goal: "list-prices",
        body: [
          // The last action hands the goal on, so the loop does not nest.
          step("fetch-page", async (intention) => {
            const { page = 1 } = intention.goal.data as { page?: number };
            if (!CATALOGUE[page]) {
              return { result: { pages: page - 1 } };
            }
            return {
              continueWith: { goal: "list-prices", data: { page: page + 1 } },
            };
          }),
        ],
      },
    ),
  });
  pricing.beliefs.set("price.widget", PRICES.widget!);
  pricing.beliefs.set("price.gadget", PRICES.gadget!);

  // --- The tax agent: answers the delegated question. ---
  const tax = new Agent({
    id: "tax",
    bus,
    planLibrary: library({
      goal: "vat",
      body: [
        step("rate", async (intention): Promise<ActionResult> => {
          const { country } = intention.goal.data as { country: string };
          return { result: { country, rate: country === "DE" ? 0.19 : 0 } };
        }),
      ],
    }),
  });

  // --- The dashboard: subscribes to the topic, and believes what it hears. ---
  const dashboard = new Agent({
    id: "dashboard",
    bus,
    planLibrary: library(),
  });
  await dashboard.subscribe("quotes");

  // The requester is a plain inbox: it sees exactly what goes on the wire.
  const customer: Message[] = [];
  bus.registerAgent("customer", (msg) => customer.push(msg));

  // A monitor, built on nothing but events.
  pricing.on("goal:added", (goal) =>
    console.log(`  [pricing] queued ${goal.name}`),
  );
  pricing.on("intention:advanced", ({ action }) =>
    console.log(`  [pricing] ran ${action.name}`),
  );
  pricing.on("goal:continued", ({ goal, from }) =>
    console.log(`  [pricing] ${from.name} handed on to ${goal.name}`),
  );
  pricing.on("goal:failed", ({ goal, reason }) =>
    console.log(`  [pricing] ${goal.name} failed: ${reason}`),
  );

  await Promise.all([pricing.start(), tax.start(), dashboard.start()]);

  console.log("=== Getting started demo ===\n");

  const request = (content: Record<string, unknown>): Promise<void> =>
    bus.send("pricing", {
      performative: "request",
      sender: "customer",
      receiver: "pricing",
      content,
      timestamp: Date.now(),
    });

  // 1. A request starts a goal.
  console.log("(1) asking for a quote");
  await request({ goal: "quote", item: "widget", quantity: 10 });

  // 3. Work that cannot be done fails.
  console.log("\n(3) asking for a quote nobody can price");
  await request({ goal: "quote", item: "spaceship", quantity: 1 });

  // 4. A goal handed on, page by page.
  console.log("\n(4) listing the catalogue");
  await request({ goal: "list-prices", page: 1 });

  for (let i = 0; i < 12; i++) {
    await pricing.tick();
    await tax.tick();
    await dashboard.tick();
  }

  console.log("\n(2) what the dashboard heard:");
  console.log("   ", dashboard.beliefs.all());

  console.log("\n(what the customer saw)");
  for (const msg of customer) {
    console.log(`   ${msg.performative}`, msg.content);
  }

  await Promise.all([pricing.stop(), tax.stop(), dashboard.stop()]);
}

main().catch(console.error);
