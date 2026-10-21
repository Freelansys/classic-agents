import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import type { Message } from "../src/bus/index.js";
import { Agent, PlanLibrary } from "../src/core/index.js";
import type { Action, ActionResult, Plan } from "../src/core/index.js";
import { runAction, runPlan } from "../src/testing/index.js";

/**
 * The walkthrough of GETTING-STARTED.md, as a test: the same agents, the same
 * plan, the same expectations the guide states.
 */

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

/** The pricing agent's quote plan: delegate, total, announce. */
const quotePlan: Plan = {
  goal: "quote",
  body: [
    step("ask-tax", async () => ({
      delegations: [{ receiver: "tax", goal: "vat", view: { country: "DE" } }],
    })),
    step("total", async (intention, beliefs): Promise<ActionResult> => {
      const { item, quantity } = intention.goal.data as {
        item: string;
        quantity: number;
      };
      const unit = beliefs.get<number>(`price.${item}`);
      if (unit === undefined) {
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
        beliefUpdates: [{ key: "lastQuote", value: quote }],
        result: quote,
      };
    }),
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
};

/** The pricing agent's paging plan: the goal is handed on, page by page. */
const listPlan: Plan = {
  goal: "list-prices",
  body: [
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
};

async function main(): Promise<{ customer: Message[]; dashboard: Agent }> {
  const bus = new InMemoryMessageBus();

  const pricing = new Agent({
    id: "pricing",
    bus,
    planLibrary: library(quotePlan, listPlan),
  });
  pricing.beliefs.set("price.widget", 12.5);

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

  const dashboard = new Agent({
    id: "dashboard",
    bus,
    planLibrary: library(),
  });
  await dashboard.subscribe("quotes");

  const customer: Message[] = [];
  bus.registerAgent("customer", (msg) => customer.push(msg));

  await Promise.all([pricing.start(), tax.start(), dashboard.start()]);

  const request = (content: Record<string, unknown>): Promise<void> =>
    bus.send("pricing", {
      performative: "request",
      sender: "customer",
      receiver: "pricing",
      content,
      timestamp: Date.now(),
    });

  await request({ goal: "quote", item: "widget", quantity: 10 });
  await request({ goal: "quote", item: "spaceship", quantity: 1 });
  await request({ goal: "list-prices", page: 1 });

  for (let i = 0; i < 12; i++) {
    await pricing.tick();
    await tax.tick();
    await dashboard.tick();
  }

  await Promise.all([pricing.stop(), tax.stop(), dashboard.stop()]);

  return { customer, dashboard };
}

describe("The getting-started walkthrough", () => {
  it("answers a request with the goal's result", async () => {
    const { customer } = await main();

    const agree = customer.find((m) => m.performative === "agree");
    expect(agree?.content).toMatchObject({ goal: "quote" });

    const done = customer.find(
      (m) =>
        m.performative === "inform" && (m.content as { done?: boolean }).done,
    );
    expect(done?.content).toMatchObject({
      goal: "quote",
      done: true,
      result: { item: "widget", quantity: 10, total: 148.75 },
    });
  });

  it("tells the requester a failure when the work cannot be done", async () => {
    const { customer } = await main();

    const failure = customer.find((m) => m.performative === "failure");
    expect(failure?.content).toMatchObject({
      goal: "quote",
      reason: "no price for spaceship",
    });
    // A refused request is never sent after an agreement.
    const agrees = customer.filter((m) => m.performative === "agree");
    expect(agrees).toHaveLength(3); // two quotes and the catalogue
  });

  it("publishes the quote, and the subscriber believes it", async () => {
    const { dashboard } = await main();

    expect(dashboard.beliefs.all()).toMatchObject({
      "msg.item": "widget",
      "msg.quantity": 10,
      "msg.total": 148.75,
    });
  });

  it("hands the goal on, page by page, and answers once", async () => {
    const { customer } = await main();

    const done = customer.find(
      (m) =>
        m.performative === "inform" &&
        (m.content as { goal?: string }).goal === "list-prices",
    );
    expect(done?.content).toMatchObject({
      done: true,
      result: { pages: 2 },
    });
  });

  it("runs one step of a plan without an agent", async () => {
    const { result, failure, beliefs } = await runAction(quotePlan, "total", {
      data: { item: "widget", quantity: 10 },
      beliefs: { "price.widget": 12.5 },
      results: { vat: { rate: 0.19 } },
    });

    expect(failure).toBeUndefined();
    expect(result?.result).toEqual({
      item: "widget",
      quantity: 10,
      total: 148.75,
    });
    expect(beliefs.get("lastQuote")).toMatchObject({ total: 148.75 });
  });

  it("runs a whole plan, with its sub-goals answered", async () => {
    const trace = await runPlan(quotePlan, {
      data: { item: "widget", quantity: 10 },
      beliefs: { "price.widget": 12.5 },
      subGoals: { vat: { result: { rate: 0.19 } } },
    });

    expect(trace.outcome).toBe("achieved");
    expect(trace.steps.map((s) => s.action)).toEqual([
      "ask-tax",
      "total",
      "announce",
    ]);
    expect(trace.result).toMatchObject({ total: 148.75 });
  });
});
