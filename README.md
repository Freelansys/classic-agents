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
├── index.ts         classic-agents              — main entry: core + bus
├── bus/             classic-agents/bus          — MessageBus interface + InMemoryMessageBus
├── core/            classic-agents/core         — Belief base, goals, plans, intentions, reasoning cycle
├── contract-net/    classic-agents/contract-net — coordinator/worker task distribution (claim → grant → result)
└── examples/        (not exported) — runnable demo agents
tests/                                         — all unit + integration tests
```

Import styles:

```typescript
import { Agent, InMemoryMessageBus } from "classic-agents"; // main entry (core + bus)
import { GoalQueue } from "classic-agents/core"; // core only
import { InMemoryMessageBus } from "classic-agents/bus"; // transport layer
import { createCoordinator, createWorker } from "classic-agents/contract-net"; // task distribution
```

### `classic-agents/bus`

Transport-agnostic message bus interface. Supports both point-to-point (`send`/`registerAgent`) and pub/sub (`publish`/`subscribe`) patterns. Ships with `InMemoryMessageBus` — swap in Redis Streams, NATS, etc. by implementing the `MessageBus` interface.

An agent can subscribe to topics with `agent.subscribe(topic)`. Published messages are drained into the agent's mailbox on the next `tick()` and processed identically to point-to-point messages. The returned function unsubscribes; subscriptions survive `stop()`/`start()` restarts.

Actions publish by setting `topic` on an entry in their result's `messages` (routed via `bus.publish`); point-to-point delivery uses `receiver` (routed via `bus.send`). See `src/examples/find_root_coordinator.ts` for a race-to-claim demo with two worker agents and a supervising coordinator built from the `contract-net` module (`createCoordinator`/`createWorker`); `src/examples/find_root_concurrent.ts` shows the same scenario with the coordinator's plans written out by hand.

### `classic-agents/core`

The BDI engine:

- **BeliefBase** — pluggable typed key-value belief store. The `BeliefBase` interface defines the contract (`get`/`set`/`compareAndSet`/`remove`, prefix and predicate queries, `beliefAdded`/`beliefUpdated`/`beliefRemoved` events); the default backend is `InMemoryBeliefBase`. Inject any implementation via `Agent` config (e.g. a `RedisBeliefBase`), just like swapping message-bus transports.

`compareAndSet(key, expected, next)` performs an atomic, compare-and-swap update and resolves to `true`/`false`. `expected: undefined` means "the key is absent". Comparison is deep (structural), so object beliefs round-tripped through the bus compare correctly. In-memory it's a synchronous map check-and-set (atomic within the event loop); Redis implementations can back it with a Lua script so read-compare-write stays atomic across processes.

For convenience, `update(key, reducer)` runs the optimistic read → `reducer(current)` → write loop for you via `casUpdate` (the shared retry helper — `reducer` is re-invoked on contention, and the update counts as failed after 100 attempts). Use `set()` for blind single-writer / newest-fact-wins writes (e.g. applying inbound messages); use `compareAndSet`/`update` whenever the new value depends on the current one.
- **GoalQueue** — priority-based goal queue with pluggable selection strategy. Goals have statuses: `pending → active → achieved | failed | dropped`.
- **PlanLibrary** — registers plans with trigger functions. Plans are matched against beliefs and goals during means-ends reasoning.
- **IntentionStack** — tracks active intentions. Multiple intentions execute concurrently per agent (configurable limit).
- **Agent** — orchestrates the full BDI cycle. Configurable for intention reconsideration and max concurrent intentions.

### `classic-agents/contract-net`

Coordinator/worker task distribution over the message bus — the Contract Net Protocol in simplified form: a manager *announces* tasks (publish), workers *bid* by claiming (claim), the manager *awards* each task to one worker (grant), and workers *perform* and report (result). Built on the same `Agent` + `PlanLibrary` machinery as custom plans.

The pub/sub worker example (`src/examples/find_root_coordinator.ts`) ships with both sides of the protocol abstracted. `createCoordinator` publishes tasks, arbitrates worker claims, grants each task, and collects results; `createWorker` handles claiming and reporting, leaving only the actual work as user code:

```typescript
import { InMemoryMessageBus } from "classic-agents";
import { createCoordinator, createWorker } from "classic-agents/contract-net";

const bus = new InMemoryMessageBus();

const coordinator = createCoordinator({
  id: "coordinator",
  bus,
  workers: ["worker-alpha", "worker-beta"],
  tasks: [
    { id: "cubic", payload: { functionName: "cubic" } },
    { id: "quadratic", payload: { functionName: "quadratic" } },
  ],
  allocationPolicy: "no-repeat", // first-claim | no-repeat | least-loaded | custom fn
  onTaskAssigned: (taskId, worker) => console.log(`${taskId} -> ${worker}`),
  onAllComplete: (results) => console.log(results),
});

const worker = createWorker<{ functionName: string }, RootResult>({
  id: "worker-alpha",
  bus,
  canClaim: (taskId, task) => true,       // optional capability filter, default: all
  step: (taskId, task, beliefs) => {
    // one tick of work (e.g. a bisection step, tracked in beliefs)
    if (converged) return { done: true, result: { root: mid } };
    return { done: false };
  },
});

coordinator.start();
worker.start();
```

The coordinator publishes tasks to `tasks`, listens on `claims`/`results`, and grants on `grants` — the `createWorker` defaults match, so workers drop in unchanged, including multiple concurrent tasks per worker (the step runs once per unfinished task each tick, keyed per-task). Under the hood the coordinator is an `Agent` with four plans (publish tasks, arbitrate claims, record results, complete) exposing `ownerOf`/`owners`/`resultOf`/`results`/`isComplete`, and the worker is an `Agent` with two plans (claim, work) exposing `claimed`/`activeTasks`/`completed`/`resultOf`/`results`.

Workers publish a claim as an `inform` message whose content key is `claim.<worker>.<taskId>` and a result as content key `result.<taskId>`. All protocol key prefixes and topic names are configurable via `taskKey`/`claimKey`/`grantKey`/`resultKey` and `topics`. The coordinator does not enforce unique topics on the bus — when several coordinations share a bus, give each its own `topics` so workers do not cross-talk.

## Quick Start

```bash
npm install
npm test
npm run example   # run the two-agent demo
npm run example:concurrent   # run the pub/sub coordinator + worker demo
npm run example:coordinator  # same demo using createCoordinator + createWorker
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

Tests cover: belief base CRUD and events, goal queue selection, plan matching, intention lifecycle, multi-step plans, in-memory bus delivery, a full two-agent integration test, and the contract-net coordination protocol (allocation policies, claim/result flows, custom-topic isolation).

## License

MIT
