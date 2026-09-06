import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import { Agent, PlanLibrary } from "../src/core/index.js";
import type { ActionResult } from "../src/core/index.js";

describe("Two-agent integration", () => {
  it("sender sends a reading, monitor reacts to the belief", async () => {
    const bus = new InMemoryMessageBus();

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

    const monitorLib = new PlanLibrary();
    monitorLib.register({
      name: "alert-on-high-temp",
      trigger: (beliefs) => {
        const temp = beliefs.get<number>("msg.temperature");
        return temp !== undefined && temp > 30;
      },
      body: [
        {
          name: "record-alert",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [
              { key: "alertSent", value: true },
              {
                key: "lastTemperature",
                value: beliefs.get<number>("msg.temperature"),
              },
            ],
          }),
        },
      ],
    });

    const sender = new Agent({
      id: "sender",
      bus,
      planLibrary: senderLib,
      tickIntervalMs: 10,
    });
    const monitor = new Agent({
      id: "monitor",
      bus,
      planLibrary: monitorLib,
      tickIntervalMs: 10,
    });

    sender.start();
    monitor.start();

    sender.goals.add({
      id: "g1",
      name: "sendReading",
      priority: 10,
      status: "pending",
    });

    for (let i = 0; i < 10; i++) {
      await sender.tick();
      await monitor.tick();
    }

    expect(monitor.beliefs.get("alertSent")).toBe(true);
    expect(monitor.beliefs.get("lastTemperature")).toBe(37.5);

    sender.stop();
    monitor.stop();
  });
});
