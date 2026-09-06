import { InMemoryMessageBus } from "../bus/index.js";
import { Agent, PlanLibrary } from "../core/index.js";
import type { Action, ActionResult, Plan } from "../core/index.js";

async function main(): Promise<void> {
  console.log("=== classic-agents BDI Demo ===\n");

  const bus = new InMemoryMessageBus();

  // --- Sender Agent: sends a temperature reading to the monitor ---
  const senderLib = new PlanLibrary();
  senderLib.register({
    name: "send-reading",
    trigger: (_, goal) => goal.name === "sendReading",
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
    name: "alert-on-high-temp",
    trigger: (beliefs) => {
      const temp = beliefs.get<number>("msg.temperature");
      return temp !== undefined && temp > 30;
    },
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
    tickIntervalMs: 50,
  });
  const monitor = new Agent({
    id: "monitor",
    bus,
    planLibrary: monitorLib,
    tickIntervalMs: 50,
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
