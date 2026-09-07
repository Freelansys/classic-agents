# classic-agents

A classical Belief-Desire-Intention (BDI) agent framework for TypeScript.

classic-agents enables agent-oriented programming where agents maintain an explicit belief base, select among desires/goals, and execute intentions via a plan library. The reasoning cycle is deterministic and inspectable.

## Install

```bash
npm install classic-agents
```

## Architecture

### The BDI Reasoning Cycle

Each agent runs an asynchronous reasoning loop with these steps:

1. **Perceive** — drain the agent's mailbox (messages from the bus) and convert to belief updates.
2. **Revise Beliefs** — apply belief updates, emit belief-change events.
3. **Deliberate** — select/update goals based on current beliefs. For belief-triggered plans without explicit goals, implicit goals are created automatically.
4. **Means-Ends Reasoning** — for goals not already covered by an active intention, find an applicable plan from the plan library and instantiate an intention.
5. **Execute** — advance each active intention by one action step. Concurrent intentions execute in parallel via `Promise.allSettled`.
6. **Repeat** — the cycle runs as a free-running timer or can be driven manually via `tick()`.

### Package Layout

The code is organized into namespaced modules, exposed as subpath exports:

```
src/
├── index.ts      classic-agents         — main entry: core + bus
├── bus/          classic-agents/bus     — MessageBus interface + InMemoryMessageBus
├── core/         classic-agents/core    — Belief base, goals, plans, intentions, reasoning cycle
└── examples/     (not exported) — runnable demo agents
tests/                                   — all unit + integration tests
```

Import styles:

```typescript
import { Agent, InMemoryMessageBus } from "classic-agents"; // main entry (core + bus)
import { GoalQueue } from "classic-agents/core"; // core only
import { InMemoryMessageBus } from "classic-agents/bus"; // transport layer
```

### `classic-agents/bus`

Transport-agnostic message bus interface. Supports both point-to-point (`send`/`registerAgent`) and pub/sub (`publish`/`subscribe`) patterns. Ships with `InMemoryMessageBus` — swap in Redis Streams, NATS, etc. by implementing the `MessageBus` interface.

An agent can subscribe to topics with `agent.subscribe(topic)`. Published messages are drained into the agent's mailbox on the next `tick()` and processed identically to point-to-point messages. The returned function unsubscribes; subscriptions survive `stop()`/`start()` restarts.

### `classic-agents/core`

The BDI engine:

- **BeliefBase** — typed key-value store with `beliefAdded`/`beliefUpdated`/`beliefRemoved` events. Supports prefix queries and predicate-based queries.
- **GoalQueue** — priority-based goal queue with pluggable selection strategy. Goals have statuses: `pending → active → achieved | failed | dropped`.
- **PlanLibrary** — registers plans with trigger functions. Plans are matched against beliefs and goals during means-ends reasoning.
- **IntentionStack** — tracks active intentions. Multiple intentions execute concurrently per agent (configurable limit).
- **Agent** — orchestrates the full BDI cycle. Configurable for intention reconsideration and max concurrent intentions.

## Quick Start

```bash
npm install
npm test
npm run example   # run the two-agent demo
```

### Creating an Agent

```typescript
import { Agent, InMemoryMessageBus, PlanLibrary } from "classic-agents";

const bus = new InMemoryMessageBus();
const lib = new PlanLibrary();

lib.register({
  name: "greet",
  trigger: (_, goal) => goal.name === "greet",
  body: [
    {
      name: "say-hello",
      execute: async () => {
        console.log("Hello!");
        return {};
      },
    },
  ],
});

const agent = new Agent({ id: "bot", bus, planLibrary: lib });
agent.start();

// Add a goal
agent.goals.add({ id: "g1", name: "greet", priority: 10, status: "pending" });

// Let the reasoning cycle run
await agent.tick();
agent.stop();
```

### Belief-Triggered Plans

Plans can react to belief changes without explicit goals:

```typescript
lib.register({
  name: "react-to-temp",
  trigger: (beliefs) => {
    const temp = beliefs.get<number>("msg.temperature");
    return temp !== undefined && temp > 30;
  },
  body: [
    {
      name: "alert",
      execute: async (_intention, beliefs) => ({
        beliefUpdates: [{ key: "alertSent", value: true }],
      }),
    },
  ],
});
```

## Testing

```bash
npm test                  # run all tests
npm run test:watch        # watch mode
```

Tests cover: belief base CRUD and events, goal queue selection, plan matching, intention lifecycle, multi-step plans, in-memory bus delivery, and a full two-agent integration test.

## License

MIT
