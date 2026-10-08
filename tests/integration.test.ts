import { describe, it, expect } from "vitest";
import { InMemoryMessageBus } from "../src/bus/index.js";
import { Agent, PlanLibrary } from "../src/core/index.js";
import type { ActionResult } from "../src/core/index.js";

describe("Two-agent integration", () => {
  it("publishes action-result messages to a topic", async () => {
    const bus = new InMemoryMessageBus();

    const producerLib = new PlanLibrary();
    producerLib.register({
      name: "emit",
      trigger: (_, goal) => goal.name === "emit",
      body: [
        {
          name: "publish",
          execute: async (): Promise<ActionResult> => ({
            messages: [
              {
                topic: "announcements",
                performative: "inform",
                content: { text: "hi" },
              },
            ],
          }),
        },
      ],
    });

    const consumerLib = new PlanLibrary();
    consumerLib.register({
      name: "react",
      trigger: (beliefs) => beliefs.has("msg.text"),
      body: [
        {
          name: "record",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [
              { key: "received", value: beliefs.get("msg.text") },
            ],
          }),
        },
      ],
    });

    const producer = new Agent({
      id: "producer",
      bus,
      planLibrary: producerLib,
    });
    const consumer = new Agent({
      id: "consumer",
      bus,
      planLibrary: consumerLib,
    });

    producer.start(10);
    consumer.start(10);
    await consumer.subscribe("announcements");

    producer.goals.add({
      id: "g-emit",
      name: "emit",
      priority: 5,
      status: "pending",
    });

    for (let i = 0; i < 5; i++) {
      await producer.tick();
      await consumer.tick();
    }

    expect(consumer.beliefs.get("received")).toBe("hi");

    producer.stop();
    consumer.stop();
  });

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
    });
    const monitor = new Agent({
      id: "monitor",
      bus,
      planLibrary: monitorLib,
    });

    sender.start(10);
    monitor.start(10);

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

  it("decomposes a goal into sub-goals and waits for them", async () => {
    const bus = new InMemoryMessageBus();

    const orderLib = new PlanLibrary();
    orderLib.register({
      name: "processOrder",
      trigger: (_, goal) => goal.name === "processOrder",
      body: [
        {
          name: "decompose",
          execute: async (): Promise<ActionResult> => ({
            newGoals: [
              { name: "verifyPayment", priority: 10 },
              { name: "checkInventory", priority: 9 },
            ],
          }),
        },
        {
          name: "fulfill",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "orderFulfilled", value: true }],
          }),
        },
      ],
    });

    orderLib.register({
      name: "verifyPayment",
      trigger: (_, goal) => goal.name === "verifyPayment",
      body: [
        {
          name: "confirm",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "paymentVerified", value: true }],
          }),
        },
      ],
    });

    orderLib.register({
      name: "checkInventory",
      trigger: (_, goal) => goal.name === "checkInventory",
      body: [
        {
          name: "confirm",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "inventoryChecked", value: true }],
          }),
        },
      ],
    });

    const agent = new Agent({ id: "order", bus, planLibrary: orderLib });
    agent.start(10);

    agent.goals.add({
      id: "g-order",
      name: "processOrder",
      priority: 10,
      status: "pending",
    });

    for (let i = 0; i < 10; i++) {
      await agent.tick();
    }

    expect(agent.beliefs.get("paymentVerified")).toBe(true);
    expect(agent.beliefs.get("inventoryChecked")).toBe(true);
    expect(agent.beliefs.get("orderFulfilled")).toBe(true);

    agent.stop();
  });

  it("sequential goals — last action creates independent next-step goals", async () => {
    const bus = new InMemoryMessageBus();

    const planLib = new PlanLibrary();
    planLib.register({
      name: "onboard",
      trigger: (_, goal) => goal.name === "onboard",
      body: [
        {
          name: "createAccount",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "accountCreated", value: true }],
            newGoals: [{ name: "setupProfile", priority: 10 }],
          }),
        },
      ],
    });

    planLib.register({
      name: "setupProfile",
      trigger: (_, goal) => goal.name === "setupProfile",
      body: [
        {
          name: "collectInfo",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "profileSetup", value: true }],
            newGoals: [{ name: "grantAccess", priority: 10 }],
          }),
        },
      ],
    });

    planLib.register({
      name: "grantAccess",
      trigger: (_, goal) => goal.name === "grantAccess",
      body: [
        {
          name: "assignRoles",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "accessGranted", value: true }],
          }),
        },
      ],
    });

    const agent = new Agent({ id: "onboarder", bus, planLibrary: planLib });
    agent.start(10);

    agent.goals.add({
      id: "g-onboard",
      name: "onboard",
      priority: 10,
      status: "pending",
    });

    for (let i = 0; i < 15; i++) {
      await agent.tick();
    }

    expect(agent.beliefs.get("accountCreated")).toBe(true);
    expect(agent.beliefs.get("profileSetup")).toBe(true);
    expect(agent.beliefs.get("accessGranted")).toBe(true);

    agent.stop();
  });

  it("handles nested decomposition — action 1 also creates sub-goals", async () => {
    const bus = new InMemoryMessageBus();

    const planLib = new PlanLibrary();
    planLib.register({
      name: "deploy",
      trigger: (_, goal) => goal.name === "deploy",
      body: [
        {
          name: "prepare",
          execute: async (): Promise<ActionResult> => ({
            newGoals: [
              { name: "build", priority: 10 },
              { name: "test", priority: 9 },
            ],
          }),
        },
        {
          name: "release",
          execute: async (): Promise<ActionResult> => ({
            newGoals: [
              { name: "notifyUsers", priority: 8 },
              { name: "updateDocs", priority: 7 },
            ],
          }),
        },
        {
          name: "finalize",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "fullyDeployed", value: true }],
          }),
        },
      ],
    });

    planLib.register({
      name: "build",
      trigger: (_, goal) => goal.name === "build",
      body: [
        {
          name: "run",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "built", value: true }],
          }),
        },
      ],
    });

    planLib.register({
      name: "test",
      trigger: (_, goal) => goal.name === "test",
      body: [
        {
          name: "run",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "tested", value: true }],
          }),
        },
      ],
    });

    planLib.register({
      name: "notifyUsers",
      trigger: (_, goal) => goal.name === "notifyUsers",
      body: [
        {
          name: "send",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "notified", value: true }],
          }),
        },
      ],
    });

    planLib.register({
      name: "updateDocs",
      trigger: (_, goal) => goal.name === "updateDocs",
      body: [
        {
          name: "write",
          execute: async (_intention, beliefs): Promise<ActionResult> => ({
            beliefUpdates: [{ key: "docsUpdated", value: true }],
          }),
        },
      ],
    });

    const agent = new Agent({ id: "deployer", bus, planLibrary: planLib });
    agent.start(10);

    agent.goals.add({
      id: "g-deploy",
      name: "deploy",
      priority: 10,
      status: "pending",
    });

    for (let i = 0; i < 20; i++) {
      await agent.tick();
    }

    expect(agent.beliefs.get("built")).toBe(true);
    expect(agent.beliefs.get("tested")).toBe(true);
    expect(agent.beliefs.get("notified")).toBe(true);
    expect(agent.beliefs.get("docsUpdated")).toBe(true);
    expect(agent.beliefs.get("fullyDeployed")).toBe(true);

    agent.stop();
  });
});
