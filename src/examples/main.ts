import { InMemoryMessageBus } from "../bus/index.js";
import { Agent, PlanLibrary } from "../core/index.js";
import type { Action, ActionResult, Plan } from "../core/index.js";

async function main(): Promise<void> {
  console.log("=== classic-agents BDI Demo ===\n");

  const bus = new InMemoryMessageBus();

  // --- Sender Agent: sends a temperature reading to the monitor ---
  const senderLib = new PlanLibrary();
  senderLib.register({
    name: "sendReading",
    body: [
      {
        name: "inform-monitor",
        execute: async (): Promise<ActionResult> => ({
          messages: [
            {
              receiver: "monitor",
              performative: "inform",
              content: { temperature: 37.5, location: "server-room" },
            },
          ],
        }),
      },
    ],
  });

  // --- Monitor Agent: receives readings, alerts if temperature is high ---
  const monitorLib = new PlanLibrary();
  monitorLib.register({
    name: "watch-temperature",
    // The reading has to be in hand before the agent is asked: a request is an
    // RPC and runs on the next cycle, so asking first would log an alert with
    // no temperature to report.
    body: [
      {
        name: "log-alert",
        execute: async (_intention, beliefs): Promise<ActionResult> => {
          const temp = beliefs.get<number>("msg.temperature");
          const location = beliefs.get<string>("msg.location");
          console.log(`ALERT: High temperature ${temp}°C at ${location}`);
          return {
            beliefUpdates: [
              { key: "alertSent", value: true },
              { key: "lastTemperature", value: temp },
            ],
          };
        },
      },
    ],
  });

  const sender = new Agent({
    id: "sender",
    bus,
    planLibrary: senderLib,
  });
  const monitor = new Agent({
    id: "monitor",
    bus,
    planLibrary: monitorLib,
  });

  sender.start();
  monitor.start();

  // Kick off the sender with a goal
  sender.goals.add({
    id: "g-send",
    name: "sendReading",
    priority: 10,
    status: "pending",
  });

  // Let the reading travel before asking the monitor to judge it: a request
  // runs on the next cycle, so the temperature has to be in hand first.
  for (let i = 0; i < 2; i++) {
    await sender.tick();
    await monitor.tick();
  }

  // Ask the monitor to watch. A directive is what obliges it; the plan serves
  // that goal by name, and by now the reading is in its belief base.
  await bus.send("monitor", {
    performative: "request",
    sender: "sender",
    content: { goal: "watch-temperature" },
    timestamp: Date.now(),
  });

  // Run the cycle for a few ticks
  for (let i = 0; i < 10; i++) {
    await sender.tick();
    await monitor.tick();
    await new Promise((r) => setTimeout(r, 10));
  }

  console.log("\n--- Final State ---");
  console.log("Sender beliefs:", sender.beliefs.all());
  console.log("Monitor beliefs:", monitor.beliefs.all());

  sender.stop();
  monitor.stop();
}

main().catch(console.error);
