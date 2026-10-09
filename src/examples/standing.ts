/**
 * Standing directives: ask an agent to watch something on your behalf.
 *
 * - `subscribe` names an expression: the agent reports its value now, and
 *   again every time it changes, until cancelled.
 * - `request-when` names a goal and a proposition: the agent agrees now, and
 *   works the goal the first time the proposition holds.
 *
 * The sender names the condition; the receiver owns its implementation.
 *
 * Run with `npm run example:standing`.
 */
import { InMemoryMessageBus } from "../bus/index.js";
import type { Performative } from "../bus/index.js";
import {
  Agent,
  ExpressionLibrary,
  PlanLibrary,
  PropositionLibrary,
} from "../core/index.js";

async function main(): Promise<void> {
  const bus = new InMemoryMessageBus();

  const expressions = new ExpressionLibrary();
  expressions.register({
    name: "temperature",
    evaluate: (beliefs) => beliefs.get<number>("temperature"),
  });
  const propositions = new PropositionLibrary();
  propositions.register({
    name: "too-hot",
    evaluate: (beliefs) => (beliefs.get<number>("temperature") ?? 0) > 25,
  });
  const plans = new PlanLibrary();
  plans.register({
    name: "open-window",
    body: [
      {
        name: "open",
        execute: async () => ({
          beliefUpdates: [{ key: "window", value: "open" }],
        }),
      },
    ],
  });

  const home = new Agent({
    id: "home",
    bus,
    planLibrary: plans,
    expressionLibrary: expressions,
    propositionLibrary: propositions,
  });
  home.beliefs.set("temperature", 21);

  bus.registerAgent("resident", (msg) =>
    console.log(
      `  [resident] ${msg.inReplyTo}: ${msg.performative}`,
      msg.content,
    ),
  );
  const send = (
    performative: Performative,
    content: unknown,
    ids: { replyWith: string; inReplyTo?: string },
  ) =>
    bus.send("home", {
      performative,
      sender: "resident",
      receiver: "home",
      content,
      ...ids,
      timestamp: Date.now(),
    });

  await home.start();
  console.log("=== Standing directives demo ===\n");

  await send("subscribe", { name: "temperature" }, { replyWith: "sub-1" });
  await send(
    "request-when",
    { goal: "open-window", when: "too-hot" },
    { replyWith: "when-1" },
  );
  await home.tick();

  // The world warms up; each change is reported, and the window opens once
  // it is too hot.
  for (const temperature of [23, 26, 28]) {
    console.log(`\n  (temperature is now ${temperature})`);
    home.beliefs.set("temperature", temperature);
    for (let i = 0; i < 3; i++) await home.tick();
  }

  console.log("\n  (resident cancels the subscription)");
  await send("cancel", {}, { replyWith: "cancel-1", inReplyTo: "sub-1" });
  await home.tick();
  home.beliefs.set("temperature", 30);
  for (let i = 0; i < 2; i++) await home.tick();

  console.log("\n  window:", home.beliefs.get("window"));
  await home.stop();
}

main().catch(console.error);
