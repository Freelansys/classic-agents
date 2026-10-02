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

1. **Perceive** — take everything the bus has delivered since the last cycle out of the inbox (`agent.inbox`), oldest first. Nothing is decided yet: a message is an *event*, and being told something is not the same as having taken it in.
2. **Revise Beliefs** — decide what the perceived messages mean. An assertion about the world becomes a belief if — and only if — the agent's `informs` policy accepts it; a directive becomes a goal. This is where an agent chooses to believe, rather than having it happen as a side effect of delivery.
3. **Deliberate** — promote the highest-priority eligible goal to active. Work only ever starts because a goal says it should: a plan is never selected by a belief alone, so every action can name the request it was for and be correlated with it.
4. **Means-Ends Reasoning** — for goals not already covered by an active intention, find an applicable plan from the plan library and instantiate an intention.
5. **Execute** — advance each active intention by one action step. Concurrent intentions execute in parallel via `Promise.allSettled`.
6. **Repeat** — the cycle runs as a free-running timer or can be driven manually via `tick()`.

Because perception is a step of the cycle and not of delivery, a message that arrives between two ticks changes nothing until the next one. That is what makes an agent's beliefs a record of what it decided, rather than of everything that was ever said to it.

### Package Layout

The code is organized into namespaced modules, exposed as subpath exports:

```
src/
├── index.ts         classic-agents              — main entry: core + bus
├── bus/             classic-agents/bus          — MessageBus interface + InMemoryMessageBus
├── core/            classic-agents/core         — Belief base, goals, plans, intentions, reasoning cycle
└── examples/        (not exported) — runnable demo agents
tests/                                         — all unit + integration tests
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

Actions publish by setting `topic` on an entry in their result's `messages` (routed via `bus.publish`); point-to-point delivery uses `receiver` (routed via `bus.send`). `src/examples/main.ts` is a runnable two-agent demo: one asks the other to watch a temperature reading, the other waits for the reading, then acts on it.

#### Messaging Protocol (FIPA-ACL)

Messages carry a performative: a speech act typing what the sender is doing to
the conversation. The full [FIPA-ACL 97](https://www.fipa.org/specs/fipa00037/)
vocabulary is supported, grouped by the **communicative-act class** that
determines what a receiver is obliged to do:

| Class | Performatives | Hearer effect |
|-------|---------------|---------------|
| **Assertive** | `inform`, `confirm`, `disagree`, `disconfirm`, `agree`, `subscribe`, `query-if-known` | *none* — the sender asserts a proposition, the receiver decides what to do |
| **Directive** | `request`, `delegate`, `request-when`, `request-whenever` | the receiver is asked to act |
| **Declarative** | `declare`, `cancel` | the sender brings the proposition about |
| **Expressive** | `failure`, `refuse`, `reject-proposal`, `sorry`, `cancel`, `agree`, `disagree`, `disconfirm` | *none* — the sender reports a state of mind |
| **Commissive** | `accept-proposal`, `promise`, `commit` | *none* — the sender commits to a future action |

`invite`, `invoke`, `propagate`, `proxy` and `unsubscribe` are also accepted;
FIPA-ACL assigns them no CA class, and the agent treats them as non-propositional.

**The distinction that matters: an assertion compels nothing.** FIPA-ACL gives
`inform` no effect on the receiver at all, so becoming a belief is the
receiver's decision. That decision is the agent's `informs` policy:

```typescript
const agent = new Agent({
  id: "qualifier",
  bus,
  planLibrary,

  // Default — accept assertions into beliefs under `msg.<key>`.
  informs: "beliefs",

  // ...or perceive them and trust nothing.
  // informs: "ignore",

  // ...or decide per message.
  informs: (msg) => msg.sender === "trusted-scout",
});
```

A directive is the one performative with a compelled hearer effect, so it
becomes a goal. Expects `{ goal: "goalName" }` in content, and an `agree` goes
back to the sender naming the id actually assigned.

```typescript
// What each performative does, in one table.
import { directsAction, isPropositional } from "classic-agents/bus";

directsAction("request");        // true   → becomes a goal
directsAction("subscribe");      // false  → asks you to monitor, not to act
isPropositional("inform");       // true   → eligible for the belief base
isPropositional("failure");      // false  → about the conversation, not the world
isPropositional("declare");      // true   → the sender brought this about
```

A performative can be both classes at once. `request-when` asserts its
condition *and* asks for the action, so both halves are recognised — but only
the assertion is carried out, for the reason in
[Directives the Agent Cannot Act On](#directives-the-agent-cannot-act-on)
below.

Two legacy performatives are still accepted and are canonicalised on receipt:
`achieve` is a KQML performative (weighed as a stronger directive than `request`,
at priority 8) and `query` is FIPA's `query-if-known` under a shorter name.

An `agree` or `refuse` answering a directive is the one special case: both are
class-assertive, so on class alone they would be propositional and believed like
any other assertion. But *those* are bookkeeping — facts about a conversation,
not about the world. An `agree` emits `goalAcknowledged` and a `refuse` emits
`goalRefused`, and neither creates a belief, goal or intention, since folding
them into beliefs would let an unrelated plan act on a bookkeeping message. A
`confirm` that is *not* an answer to a directive is an ordinary assertion, and
is believed as one.

### Answering a directive: `agree` and `refuse`

A directive is a request, not an order. FIPA gives it a compelled hearer
effect — the receiver must notice it — but not an obligation to comply, so an
agent may decline. This library makes that explicit: a received directive is
answered with exactly one of

- **`agree`** — the goal exists and will be worked on. The content names the id
  actually assigned, so a sender whose requested `goalId` lost a race to an
  existing goal can follow the right one. The agreement is sent on admission,
  because by that point every question that can be answered "no" has been:
  `canAccept` said the agent is willing, the plan library said it is able (via
  `can`), and the queue said there is room. What remains — whether the
  preconditions are in place this cycle — is not a reason to withhold a
  commitment the agent has already made.
- **`refuse`** — declined, so no goal was created. Content carries
  `reason: "no-plan" | "capacity" | "predicate" | "unsupported"` and, where the
  agent supplied one, its own `detail`. `predicate` is `canAccept` declining;
  `no-plan` is no plan `can` the goal; `capacity` is the goal queue having no
  room; `unsupported` is a performative asking for something the agent cannot
  represent, which the conditional directives are the case for — see
  [Directives the Agent Cannot Act On](#directives-the-agent-cannot-act-on).

Never both, and never an `agree` naming a goal the receiver dropped: a sender is
told what actually happened.

`refuse` is not `failure`. A failure means work was *undertaken and could not be
completed* — the action ran and broke, or returned `failure: { reason }`. A
refusal means the work was never started. Only a real failure leaves an
intention behind.

The goal queue's own bound is answered as a `refuse` with
`reason: "capacity"`, since shedding load is declining rather than failing. The
`rejected: true` notice on `__failure__` is unchanged, so monitors can still
distinguish backpressure from a broken job.

To decline on your own terms, supply `canAccept`. It runs during the revision
step, before any goal exists, and returning a string declines with that string
as the reason passed to the sender:

```typescript
new Agent({
  id: "qualifier",
  bus,
  planLibrary,
  canAccept: (msg) =>
    msg.sender === "user-proxy" ? true : `only the user-proxy may direct me, not ${msg.sender}`,
});
```

Absent a `canAccept`, the agent agrees to every well-formed directive it has
capacity for. That is a choice, not a rule of FIPA: it is what "compliant" means
for an agent that has not been told otherwise.

### Perception

Message structure:

```typescript
interface Message<T = unknown> {
  id?: string;           // optional sender-stamped correlation id, echoed in replies
  performative: Performative;  // any FIPA-ACL performative, plus the legacy two
  sender: string;
  receiver?: string;       // point-to-point target agent id
  topic?: string;          // pub/sub topic
  content: T;              // message payload
  conversationId?: string; // optional correlation id
```

### The Inbox

An agent's inbox holds what the bus has delivered but the cycle has not
perceived. It is separate from the belief base on purpose — a message is an
event, a belief is state — and reading it is a decision the reasoning loop
makes rather than one the bus makes for it.

```typescript
agent.inbox.size();      // delivered, not yet perceived
agent.inbox.peek();      // readable without draining
agent.inbox.dropped;     // shed on overflow
```

It is bounded (`maxInboxSize`, default `DEFAULT_MAX_INBOX_ENTRIES`) so an agent
that stops ticking sheds load rather than growing without limit. On overflow
the **oldest** message is dropped, since a newer assertion supersedes an older
one about the same proposition, and `dropped` counts it so a gap is never
mistaken for quiet delivery.

```typescript
interface Message<T = unknown> {
  id?: string;           // optional sender-stamped correlation id, echoed in replies
  performative: Performative;  // any FIPA-ACL performative, plus the legacy two
  sender: string;
  receiver?: string;       // point-to-point target agent id
  topic?: string;          // pub/sub topic
  content: T;              // message payload
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
  if (msg.performative === "agree") {
    // { goal: "deploy", goalId: "goal-8f3c…", conversationId: "chat-42" }
    track(msg.content.goalId, msg.content.conversationId);
  } else if (msg.performative === "refuse") {
    // { goal: "deploy", reason: "capacity", detail: "goal queue is full (limit 4)" }
    offerLater(msg.content.goal, msg.content.reason);
  }
});
```

When the sender is itself an `Agent`, use the `goalAcknowledged` and
`goalRefused` events instead of a raw inbox (see
[Events You Can Listen To](#events-you-can-listen-to)). Both are bookkeeping, not
world state, so they deliberately create no belief, goal or intention — folding
them into beliefs would let a belief-triggered plan fire off a bookkeeping
message:

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

- **GoalQueue** — priority-based goal queue with pluggable selection strategy. Goals have statuses: `pending → active → achieved | failed | dropped`. Goals can declare dependencies on other goals via `dependsOn: string[]` — a goal is only selected when all its dependencies have achieved. Failed goals cause dependent goals to be dropped. Sub-goals created by an action's `newGoals` record where they came from: `parentGoalId` is the goal whose plan created them, and `rootGoalId` is the top of that chain (the parent's `rootGoalId`, or the parent's own id), so lineage survives the creating intention. The queue emits `goalAdded`, `goalStatusChanged`, `goalRejected` and `goalRemoved` for everything that happens to it (see [Events You Can Listen To](#events-you-can-listen-to)).

  Because an achieved goal is collected at the end of the cycle that finished it, the queue keeps a small separate record of achievements that something still depends on — `goals.achievedIds()`, or `goals.dependenciesMet(goal)` for the check itself. It is reference-counted against the goals that declare `dependsOn`, so the record is retained only while there is work waiting on it: an agent that never uses `dependsOn` retains nothing, and a goal that is waiting on a dependency nobody has achieved yet simply stays `pending`.

  Goals are **bounded, not rotated**. An agent holds at most `maxGoals` unfinished goals (`pending` + `active`, sub-goals included; default `1000`, `0` or `Infinity` for unbounded). A goal offered once the bound is reached is admitted and immediately failed rather than queued — the queue is full, so backpressure is the honest answer. Nothing is ever evicted to make room: a goal leaves the queue only after reaching `achieved`, `failed` or `dropped`, at the end of the cycle that finished it. So `goals.all()` is the agent's *current* work, not its history; read history off the event stream (see [Working Set and History](#working-set-and-history)).

- **PlanLibrary** — registers plans, each declaring the goal it serves via `can` (defaulting to the plan's own `name`) and answering `true`/`false` from its `trigger`, which judges readiness rather than willingness. `declares(goalName)` is the static check that lets a directive be refused as `no-plan` before a goal exists; `match(beliefs, goal)` returns the first plan that can start this goal now, or `undefined` while the goal waits.

- **IntentionStack** — tracks active intentions with states: `pending → executing | waiting → completed | failed`. Intentions enter `waiting` when their action creates sub-goals (`newGoals`) and more plan actions remain — the parent pauses until all children achieve, then resumes. If sub-goals are created by the last action, the parent completes immediately and new goals become independent next steps. A sub-goal that *fails* also releases the parent, which fails with it (see [Action Failures](#action-failures)).

- **Agent** — orchestrates the full BDI cycle. Configurable for max concurrent intentions and `maxGoals`.

#### Working Set and History

Finished goals and intentions are **collected**, not retained: once a goal reaches `achieved`, `failed` or `dropped` it leaves the queue at the end of the cycle that finished it, and an intention in `completed` or `failed` leaves the stack the same way. Neither store is a log. A long-running agent that completes a million jobs holds roughly a million jobs' worth of *nothing* — just its current working set — because both stores are indexed by status and only the unfinished entries are ever walked by the reasoning cycle.

The practical consequence: `goals.all()` and `intentions.getAll()` answer "what is the agent working on now?", not "what has it ever done?". Anything that needs history should subscribe to the event stream, which is the same thing a monitor does.

Collection is deliberately deferred to the end of the cycle rather than done at the transition, so a job's whole event sequence arrives with the store objects still present. A listener on `intention:completed` can still read its goal as `achieved`, because the goal is collected after that event fires, not before.

```typescript
// A monitor keeps the history the stores deliberately do not.
const history: Goal[] = [];
agent.on("goal:status", ({ goal }) => history.push({ ...goal }));
agent.on("goal:removed", (goal) => history.push({ ...goal }));
```

#### Refusing Work Past the Bound

A goal the queue could not take fails immediately, which means the same three things a failed job does: a notice on `__failure__`, a `refuse` reply to whoever asked for it, and a parent waiting on that sub-goal failing with it. What sets it apart is `rejected: true` on the notice and a `reason` naming the limit, so a caller can tell "you are too busy" from "this job is broken" and retry later. The reply is a `refuse` rather than a `failure` because the work was declined, never attempted — see [Answering a directive](#answering-a-directive-agree-and-refuse):

```typescript
await bus.subscribe(FAILURE_TOPIC, (msg) => {
  const notice = msg.content[`failure.${msg.sender}`];
  if (notice?.rejected) {
    scheduleRetry(notice.goalId); // backpressure, not a fault
  }
});
```

Refusal releases room as soon as earlier work finishes, so a queue at its bound still drains.

#### Events You Can Listen To

Everything an agent does is observable without polling it. The stores emit their own events, and `Agent` re-emits the reasoning cycle as a typed event stream, so a monitor can follow an agent live instead of diffing `intentions.getAll()` between ticks or wrapping the bus.

The stores keep their own events:

| Store | Event | Payload |
|-------|-------|---------|
| `agent.beliefs` (`BeliefBase`) | `beliefAdded`, `beliefUpdated`, `beliefRemoved` | `{ key, value?, previousValue? }` |
| `agent.goals` (`GoalQueue`) | `goalAdded` | `Goal` — the stored goal, at the status it was added with |
| `agent.goals` (`GoalQueue`) | `goalStatusChanged` | `Goal` — as it now stands, so the previous status is not in the payload |
| `agent.goals` (`GoalQueue`) | `goalRejected` | `Goal` — refused for room, at the status it was admitted with, before the `goalStatusChanged` that fails it |
| `agent.goals` (`GoalQueue`) | `goalRemoved` | `Goal` — a finished goal left the queue |
| `agent.intentions` (`IntentionStack`) | `intentionRemoved` | `Intention` — a finished intention left the stack |

`agent.on(event, handler)` covers the rest. Every handler is typed for its event, and `on` returns an unsubscribe function:

| Event | Payload |
|-------|---------|
| `goal:added` | `Goal` |
| `goal:status` | `{ goal, from, to }` — the status it left and the one it took |
| `goal:rejected` | `{ goal, reason }` — refused for room; the goal is failed and never worked on |
| `goal:removed` | `Goal` — collected after it finished, at the end of that cycle |
| `intention:started` | `Intention` |
| `intention:advanced` | `{ intention, action, result }` — the action that just ran, and what it returned |
| `intention:waiting` | `{ intention, children }` — the sub-goal ids it is waiting for |
| `intention:completed` | `Intention` |
| `intention:failed` | `{ intention, reason }` |
| `intention:removed` | `Intention` — collected after it finished, at the end of that cycle |
| `message:received` | `Message` — point-to-point or on a subscribed topic, before it is processed |
| `message:sent` | `Message` — handed to the bus, from an action, an `agree`/`refuse`, or a notice |
| `goalAcknowledged` | `GoalAck` — an `agree` answering a request this agent sent |
| `goalRefused` | `GoalRefusal` — a `refuse` answering a request this agent sent |

A monitor built on nothing but events:

```typescript
const agent = new Agent({ id: "bot", bus, planLibrary: lib });

agent.on("goal:added", (goal) => console.log(`queued ${goal.name}`));
agent.on("goal:status", ({ goal, from, to }) =>
  console.log(`${goal.name}: ${from} -> ${to}`),
);
agent.on("intention:advanced", ({ action, result }) =>
  console.log(`ran ${action.name} -> ${JSON.stringify(result)}`),
);
agent.on("intention:waiting", ({ intention, children }) =>
  console.log(`${intention.goal.name} waiting on ${children.length} sub-goal(s)`),
);
agent.on("intention:failed", ({ intention, reason }) =>
  console.error(`${intention.goal.name} failed: ${reason}`),
);
agent.on("message:received", (msg) => console.log(`< ${msg.sender}`));
agent.on("message:sent", (msg) => console.log(`> ${msg.topic ?? msg.receiver}`));
```

Two things to know about the payloads:

- **Goals and intentions are live objects.** `goal`/`intention` are the very objects the queue and stack hold, mutated in place as work progresses (`setStatus`, `advance`, …), so a handler that keeps one sees later changes. Snapshot it — `{ ...goal }` — to hold the state you saw; every other field is plain data and safe to serialise.
- **Handlers run synchronously**, on the cycle that raised the event, so they must not block; hand slow work to a queue. A handler that throws fails that cycle.
- **Finished items leave the stores.** A goal or intention is collected once it is terminal, at the end of the cycle that finished it, so `goal:removed` / `intention:removed` are the last event in a job's sequence. Within a cycle everything is still readable; across cycles, snapshot the stream rather than polling `all()`.

Goal events are delivered whether or not the agent is running, and survive `stop()`/`start()`. All of them cover only this agent's own work — for a bus-wide view, subscribe to `__failure__` and `__goal_achieved__` instead. An agent subscribed to a topic receives what it publishes itself, so `message:received` fires for its own sends too.

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

#### Goal Achieved Notices

The achieved counterpart of `__failure__`: when a goal reaches `achieved`, the agent publishes an `inform` on `__goal_achieved__` (`GOAL_ACHIEVED_TOPIC`). The shape mirrors a failure notice — same `achieved.<agentId>` namespacing, same `parentGoalId`/`rootGoalId` and `source` fields — plus `status: "achieved"` and the `result` of the last action:

```typescript
await bus.subscribe("__goal_achieved__", (msg) => console.log(msg.content));
// { "achieved.worker-1": { agentId: "worker-1", intentionId: "intention-4",
//                         goalId: "g-7", goal: "deploy", plan: "deploy",
//                         action: "put", status: "achieved",
//                         result: { beliefUpdates: [{ key: "deployed", value: true }] } } }
```

With both topics published, a monitor can watch a job end to end without inferring success from silence. A notice for a goal that came from a `request`/`achieve` carries the same `source` as its failure notice, so completions route back to whoever asked for the work.

Completion notices go to monitors only. Replying to whoever requested a goal is left to the plan that requested it, which knows the reply shape its caller needs — an automatic reply would force every request to carry the whole follow-up logic.

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

#### Declaring a Goal and Answering as a Trigger

A plan has two jobs. `can` states statically which goal name it serves, and
`trigger` decides per instance whether this agent can start the work *now*. The
two are separate on purpose: `can` is a fact about the agent that lets a
directive be answered *before* a goal is created, and `trigger` is a judgement
about the current beliefs and the request at hand.

```typescript
lib.register({
  name: "acknowledge-reading",          // plan name
  can: "handle-reading",                // the goal name it serves
  trigger: (beliefs, goal) => {
    const reading = beliefs.get<number>(`msg.${goal.data?.sensor}.reading`);
    if (reading === undefined) {
      return false;                     // not ready yet: the goal waits
    }
    if (reading > 100) {
      return false;                     // still not ready: wait for better data
    }
    return true;                        // can start now
  },
  body: [/* … */],
});
```

`can` defaults to the plan's own `name`, so a plan whose name already is the
goal name needs nothing extra. The trigger returns only `true` or `false`:

| Returned | Meaning | Effect on the goal |
| --- | --- | --- |
| `true` | can start now | an intention is created and the action runs |
| `false` | not ready yet | nothing — the goal waits, re-evaluated every cycle, and becomes servable if the fact it was missing arrives |

A trigger cannot decline. Whether this agent takes on a goal at all is settled
before a goal exists, by whether any plan `can` it. By the time a trigger runs
the requester has already been sent an `agree`, and that commitment is not this
function's to withdraw. Use `false` for a precondition that has not arrived yet,
and let the plan's body report a `failure` if the work turns out to be impossible
once attempted.

A plan that declares a goal but whose trigger never returns `true` is an agent
that agreed to work it cannot start. The requester holds the `agree` and waits;
nothing on the wire changes until the body either runs or reports a `failure`.
This is FIPA's model: an intention held pending conditions, not a broken promise.

`declares()` is checked against a plan library that is fixed for the agent's
lifetime, so a plan registered *after* a request was refused will not retroactively
rescue it. That is the trade for answering honestly at admission instead of
agreeing and stalling: an unservable request can never occupy a `maxGoals` slot.

#### Directives the Agent Cannot Act On

Not every performative in the directive class asks the receiver to do the thing.
Two FIPA directives ask for something else, and `Agent` **refuses** them with
`reason: "unsupported"` rather than inventing work:

| Performative | Asks the receiver to | Why not |
| --- | --- | --- |
| `request-when`, `request-whenever` | do an action **if** `p` holds | The condition belongs to the receiver, and arrives as data |
| `subscribe` | *monitor* `p` and report changes | There is no monitor; `Agent.subscribe` is an outbound topic subscription |

`request-when` is `⟨s, h | do(a) | p⟩`. The sender names `p` but cannot compute
it, because it cannot see the state it would be computed against. Honouring one
needs a condition that arrives as data and is reconstructed on arrival — a shared
ontology, a serializable expression form, or receiver-owned named conditions.
None of that is in the box, and a predicate cannot be serialized onto a JSON bus
to stand in for it.

`subscribe` is not about work at all. It asks the receiver to watch a
proposition, which is a standing obligation to report later. The `subscribe`
method on `Agent` is the other direction: it subscribes *this* agent's inbox to a
bus topic, and is not an implementation of the performative.

```json
{ "performative": "request-when", "content": { "goal": "close-window", "condition": { "raining": true } } }
// agent replies: { "performative": "refuse", "content": { "reason": "unsupported" } }
```

The tempting shortcut — admit the goal and let the plan's own `trigger` stand in
for the condition — is not a conditional request. It is an unconditional one
wearing a condition's syntax: the action runs as soon as *anything* makes the
plan servable, which may be in clear weather when rain was the condition. A
`refuse` says the real reason instead of doing something the sender did not ask
for.

The asserted half is still honoured: these performatives are also assertions, so
what the sender claims about the world goes to the belief base under `informs`
like any other proposition. Refusing the work is not a reason to disbelieve the
sender.

There is no special case for conditionals here. `Agent` refuses any performative
that is a directive in the CA taxonomy but not one whose receiver takes on work,
and the test is derived from the taxonomy rather than from a list of names, so a
directive added to the vocabulary later cannot slip through to do nothing at all.
`isUnsupportedDirective()` is exported if you want to ask the same question.

If your agent can honour one of these, extend `Agent` and override one method:

```typescript
class WeatherAgent extends Agent {
  protected override handleUnsupportedDirective(msg: Message): void {
    // Evaluate the condition against *this* agent's beliefs, your own way.
    if (this.conditions.satisfied(msg.content.condition)) {
      // Then hand it to ordinary admission: `canAccept`, the plan check, the
      // goal bound and the `agree` all apply as they would for a `request`.
      this.considerDirective(msg, 5);
    } else {
      // Answers in the standard shape: one `goal:refused`, one `refuse` on the
      // wire, carrying a `RefusalReason` the sender already understands.
      this.declineDirective(msg, "predicate", { detail: "condition not met" });
    }
  }
}
```

This is deliberate: the library stays unopinionated about how a condition is
represented, and an agent that needs one brings its own.

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

// The achievement outlives the goal that made it, so a dependent goal added
// later — or selected on a later cycle — still sees the dependency as met:
agent.goals.achievedIds(); // => Set { "g-build", "g-test" }
agent.goals.dependenciesMet({ id: "x", name: "deploy", priority: 1, status: "pending", dependsOn: ["g-build"] }); // => true
```

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
agent.goals.add({ id: "g1", name: "greet", priority: 10, status: "pending" });

// Let the reasoning cycle run
await agent.tick();
agent.stop();
```

## Testing

```bash
npm test                  # run all tests
npm run test:watch        # watch mode
```

Tests cover: belief base CRUD and events, goal queue selection and events, plan matching and trigger readiness, intention lifecycle, directive negotiation (agreement, refusal and the `no-plan` answer), agent and goal-queue event streams, multi-step plans and sub-goal failure cascades, in-memory bus delivery, a full two-agent integration test, and Redis-backed bus and belief storage.

## License

MIT
