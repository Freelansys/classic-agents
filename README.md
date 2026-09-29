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

#### Messaging Protocol (FIPA-ACL Style)

Messages use performative speech acts to convey intent:

| Performative | Meaning | Agent Processing |
|-------------|---------|------------------|
| `inform` | Conveys information. Content keys become beliefs under the `msg.` prefix (e.g., `{ temperature: 35 }` → belief `msg.temperature = 35`). | Belief update. |
| `request` | Asks the receiver to achieve a goal. Expects `{ goal: "goalName" }` in content. Creates a pending goal with priority 5, and a `confirm` ack goes back to the sender naming the goal id. | Goal creation. |
| `achieve` | Signals that a goal has been achieved. Creates a pending goal with priority 8 (higher than `request`), acked the same way. | Goal creation. |
| `query` | Asks a question (not yet processed by the agent). | — |
| `confirm` | Confirms something. The goal-request ack uses it. | Emits `goalAcknowledged`; no belief, goal or intention. |
| `failure` | Reports failure. | — |

Message structure:

```typescript
interface Message<T = unknown> {
  id?: string;           // optional sender-stamped correlation id, echoed in replies
  performative: "inform" | "request" | "achieve" | "query" | "confirm" | "failure";
  sender: string;
  receiver?: string;       // point-to-point target agent id
  topic?: string;          // pub/sub topic
  content: T;              // message payload (keys become beliefs for `inform`)
  conversationId?: string; // optional correlation id
  timestamp: number;
}
```

Sending a `request` to an agent:

```typescript
await bus.send("agent-id", {
  performative: "request",
  sender: "user",
  receiver: "agent-id",
  content: { goal: "deploy" },
  timestamp: Date.now(),
});
```

Publishing to a topic (all subscribers receive it):

```typescript
await bus.publish("events", {
  performative: "inform",
  sender: "sensor",
  topic: "events",
  content: { temperature: 42, location: "server-room" },
  timestamp: Date.now(),
});
```

#### Following a Request You Sent

A `request`/`achieve` goal keeps a `source` recording the message it came from, and that `source` is inherited by every sub-goal the plan spawns — so the sender can follow its own job through arbitrary decomposition and all the way to a failure notice, without guessing ids.

```typescript
// The goal the agent creates:
{
  id: "goal-8f3c…",            // assigned by the agent
  name: "deploy",
  status: "pending",
  source: { sender: "ui", conversationId: "chat-42" },
  parentGoalId: undefined,      // sub-goals inherit `source` from their parent
  rootGoalId: undefined,
}
```

Because the sender's id is predictable to it up front, it can also pre-register dependent goals by id (`dependsOn: ["goal-8f3c…"]`) — or pin the id itself.

**Goal ids.** A caller may pin the id with `content.goalId`; the agent honours it only while that id is free, since reusing a taken id would overwrite a live goal. Either way the sender is told which id was actually assigned, so it never has to guess:

```typescript
// Sender registers an inbox (or subscribes to the bus directly):
bus.registerAgent("ui", (msg) => {
  if (msg.performative === "confirm") {
    // { goal: "deploy", goalId: "goal-8f3c…", conversationId: "chat-42" }
    track(msg.content.goalId, msg.content.conversationId);
  }
});
```

When the sender is itself an `Agent`, use the `goalAcknowledged` event instead of a raw inbox. Acks are bookkeeping, not world state, so they deliberately create no belief, goal or intention — folding them into beliefs would let a belief-triggered plan fire off a bookkeeping message:

```typescript
const caller = new Agent({ id: "caller", bus, planLibrary: lib });

const unsubscribe = caller.on("goalAcknowledged", (ack) => {
  // { agentId, goal, goalId, conversationId?, messageId? }
  track(ack.goalId, ack.conversationId);
});
```

That is also how a coordinator notices a lost race on a pinned id: it asked for `goalId: "job-7"`, and `ack.goalId` comes back as something else.

Acks are queued when the request is processed and sent on the agent's next `tick()`, so a `MessageHandler` stays synchronous. A `Message.id` you stamp yourself is echoed back as `messageId` in the ack. Requests the agent sent to itself are not acked.

### `classic-agents/core`

The BDI engine:

- **BeliefBase** — pluggable typed key-value belief store. The `BeliefBase` interface defines the contract (`get`/`set`/`compareAndSet`/`remove`, prefix and predicate queries, `beliefAdded`/`beliefUpdated`/`beliefRemoved` events); the default backend is `InMemoryBeliefBase`. Inject any implementation via `Agent` config (e.g. a `RedisBeliefBase`), just like swapping message-bus transports.

`compareAndSet(key, expected, next)` performs an atomic, compare-and-swap update and resolves to `true`/`false`. `expected: undefined` means "the key is absent". Comparison is deep (structural), so object beliefs round-tripped through the bus compare correctly. In-memory it's a synchronous map check-and-set (atomic within the event loop); Redis implementations can back it with a Lua script so read-compare-write stays atomic across processes.

For convenience, `update(key, reducer)` runs the optimistic read → `reducer(current)` → write loop for you via `casUpdate` (the shared retry helper — `reducer` is re-invoked on contention, and the update counts as failed after 100 attempts). Use `set()` for blind single-writer / newest-fact-wins writes (e.g. applying inbound messages); use `compareAndSet`/`update` whenever the new value depends on the current one.

- **GoalQueue** — priority-based goal queue with pluggable selection strategy. Goals have statuses: `pending → active → achieved | failed | dropped`. Goals can declare dependencies on other goals via `dependsOn: string[]` — a goal is only selected when all its dependencies have achieved. Failed goals cause dependent goals to be dropped. Sub-goals created by an action's `newGoals` record where they came from: `parentGoalId` is the goal whose plan created them, and `rootGoalId` is the top of that chain (the parent's `rootGoalId`, or the parent's own id), so lineage survives the creating intention.

- **PlanLibrary** — registers plans with trigger functions. Plans are matched against beliefs and goals during means-ends reasoning.

- **IntentionStack** — tracks active intentions with states: `pending → executing | waiting → completed | failed | dropped`. Intentions enter `waiting` when their action creates sub-goals (`newGoals`) and more plan actions remain — the parent pauses until all children achieve, then resumes. If sub-goals are created by the last action, the parent completes immediately and new goals become independent next steps. A sub-goal that *fails* also releases the parent, which fails with it (see [Action Failures](#action-failures)).

- **Agent** — orchestrates the full BDI cycle. Configurable for intention reconsideration and max concurrent intentions.

#### Action Failures

An action signals failure by returning `failure: { reason }` in its `ActionResult` (or by throwing). Either way the intention and its goal are marked `failed`, goals that depend on it are `dropped`, and the agent publishes an `inform` on the `__failure__` topic (`FAILURE_TOPIC`):

```typescript
await bus.subscribe("__failure__", (msg) => console.log(msg.content));
// { "failure.worker-1": { agentId: "worker-1", intentionId: "intention-3",
//                         goalId: "g-7", goal: "deploy", plan: "deploy",
//                         action: "upload", reason: "503 from registry" } }
```

The content is namespaced under `failure.<agentId>` so a monitor subscribed to the topic can hold one belief per failing agent (`msg.failure.worker-1`, `msg.failure.worker-2`, …) instead of each agent overwriting the last one's reason.

When the failing goal is a sub-goal, the notice also carries `parentGoalId` and `rootGoalId` — the same lineage fields the goal itself has — so a consumer that only sees the notice still knows which job (`goal: "deploy"`, not just `goal: "upload"`) the failure belongs to:

```typescript
// { "failure.worker-1": { agentId: "worker-1", goal: "upload",
//                         goalId: "goal-1731", parentGoalId: "g-7",
//                         rootGoalId: "g-7", plan: "upload",
//                         action: "put", reason: "503 from registry" } }
```

A notice for a goal that came from a `request`/`achieve` also carries its `source`, so a monitor subscribed to the topic can route the failure back to whoever asked for the work — per chat thread, per conversation:

```typescript
// { "failure.worker-1": { agentId: "worker-1", goal: "upload", goalId: "goal-1731",
//                         reason: "503 from registry",
//                         source: { sender: "ui", conversationId: "chat-42" } } }
```

The `source` is the same on every notice in the chain, whether the failure surfaced on the top-level goal or on a deeply nested sub-goal.

A failure never discards the rest of the action's result. When an action returns `failure` *alongside* `beliefUpdates`, `beliefRemovals`, `newGoals` or `messages`, every one of those is still applied before the intention is failed — partial progress is real progress. An action that reports a failure keeps that reported reason even if applying its other results subsequently throws.

#### Sub-goal Failures

An intention waiting on its sub-goals is released when one of them fails — a parent can never sit in `waiting` forever (which would also keep holding a `maxConcurrentIntentions` slot). By default the waiting parent fails too, with a reason naming the sub-goal, and the failure keeps cascading to *its* waiting parents until the top-level goal fails:

```
sub-goal "build" failed: 503 from registry
```

Every intention that fails this way is published on `__failure__` like any other failure.

Plans that can recover from a failed sub-goal say so:

```typescript
lib.register({
  name: "deploy",
  trigger: (_, goal) => goal.name === "deploy",
  onChildFailure: "continue", // "fail" (default) | "continue"
  body: [
    {
      name: "prepare",
      execute: async () => ({
        newGoals: [
          { name: "build", priority: 10 },
          { name: "test", priority: 9 },
        ],
      }),
    },
    {
      // Resumes once the sub-goals are settled, whatever their outcome. The
      // failures are on the intention if this action wants to react to them.
      name: "release",
      execute: async (intention) => {
        if (intention.childFailures.length > 0) {
          return { failure: { reason: "build/test incomplete, not releasing" } };
        }
        return { beliefUpdates: [{ key: "deployed", value: true }] };
      },
    },
  ],
});
```

With `"continue"` the failed sub-goal leaves the parent's pending set, the reason is recorded in `intention.childFailures`, and the parent resumes with its next action once no sub-goal is left outstanding — remaining sub-goals are still awaited rather than abandoned.

#### Goal Decomposition

Plans can automatically decompose goals into sub-goals:

```typescript
lib.register({
  name: "deploy",
  trigger: (_, goal) => goal.name === "deploy",
  body: [
    {
      // Action 0: decompose into sub-goals, then pause
      name: "prepare",
      execute: async () => ({
        newGoals: [
          { name: "build", priority: 10 },
          { name: "test", priority: 9 },
        ],
      }),
    },
    // Waits for build + test to achieve...
    {
      // Action 1: runs after all sub-goals complete
      name: "release",
      execute: async () => ({ beliefUpdates: [{ key: "deployed", value: true }] }),
    },
  ],
});

// Sequential goals — last action completes immediately, spawning independent next steps:
lib.register({
  name: "onboard",
  trigger: (_, goal) => goal.name === "onboard",
  body: [
    {
      execute: async () => ({
        beliefUpdates: [{ key: "accountCreated", value: true }],
        newGoals: [{ name: "setupProfile", priority: 10 }],
      }),
    },
    // No more actions → parent completes, setupProfile runs next tick independently
  ],
});

// Goal dependencies — user-specified prerequisites:
agent.goals.add({
  id: "g-deploy",
  name: "deploy",
  priority: 10,
  status: "pending",
  dependsOn: ["g-build", "g-test"], // won't be selected until both achieve
});
```

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

The coordinator publishes seed tasks to `tasks`, listens on `tasks`/`claims`/`results`, and grants on `grants` — the `createWorker` defaults match, so workers drop in unchanged, including multiple concurrent tasks per worker (the step runs once per unfinished task each tick, keyed per-task). Under the hood the coordinator is an `Agent` with five plans (publish tasks, arbitrate claims, record results, reopen, complete) exposing `ownerOf`/`owners`/`resultOf`/`results`/`isComplete`, and the worker is an `Agent` with two plans (claim, work) exposing `claimed`/`activeTasks`/`completed`/`resultOf`/`results`.

`tasks` is optional — it only seeds the first announcement. Any agent can feed the coordinator dynamically by publishing an `inform` message with content key `task.<id>` (see `taskKey`) to the tasks topic; the coordinator arbitrates whatever it perceives, so a producer agent can stream work onto the bus rather than configuring tasks ahead of time. The coordinator is quiescent-complete: `onAllComplete` fires whenever every announced task has a result, and fires again each time a later wave of announced tasks finishes.

Sending a task to the coordinator is just a publish on the tasks topic:

```typescript
await bus.publish("tasks", {
  performative: "inform",
  sender: "producer",
  topic: "tasks",
  content: { "task.cubic": { functionName: "cubic" } },
  timestamp: Date.now(),
});
```

The worker claims it, the coordinator grants and collects the result, and `onAllComplete` fires with it — no changes to coordinator or worker.

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
