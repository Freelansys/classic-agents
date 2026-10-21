# Getting started

This guide builds one agent end to end: a pricing agent that answers requests,
publishes what it computed, splits work between itself and another agent, and
reports what happened.

Every snippet below is the code in
[`src/examples/getting-started.ts`](src/examples/getting-started.ts), so you can
read the guide and run the demo side by side:

```bash
npm install
npm run example:getting-started
```

The demo prints what goes on the wire, so you can watch every step as it
happens.

## What you need

```bash
npm install classic-agents
```

Three things are imported in this guide:

```typescript
import { Agent, PlanLibrary } from "classic-agents";
import { InMemoryMessageBus } from "classic-agents/bus";
```

- **`Agent`** — the reasoning cycle: beliefs, goals, plans, intentions.
- **`PlanLibrary`** — what the agent can do, one plan per goal.
- **`InMemoryMessageBus`** — the transport. Agents in one process talk over it.
  A bus across processes is yours to write: implement the `MessageBus`
  interface (four methods) over Redis, NATS or whatever you already run.

## Step 1 — An agent, a plan, an action

A **plan** says what the agent can do, and names the **goal** it does it for. An
**action** is one step of that plan. Nothing happens until a goal named
`"quote"` exists: the agent finds the plan that serves it and runs its steps.

```typescript
const plans = new PlanLibrary();

plans.register({
  goal: "quote",
  body: [
    {
      name: "total",
      execute: async (intention, beliefs) => ({
        result: { total: 42 },
      }),
    },
  ],
});

const pricing = new Agent({
  id: "pricing",
  bus,
  planLibrary: plans,
});
```

Three things an action can hand back, and this guide uses all of them:

| Field | What it does |
| --- | --- |
| `result` | the goal's answer — it goes back to whoever asked |
| `beliefUpdates` | what the agent now knows |
| `messages` | what the agent says to others |
| `failure` | the work could not be done, and why |

An action may also `delegate` work, `spawn` goals, or hand its goal on with
`continueWith` — steps 5 and 6 below.

## Step 2 — A request starts a goal

Nobody has to call `pricing.goals.add(...)`. A **request** on the bus does it:
the goal's name is the plan's goal, so the agent agrees, plans, and works.

```typescript
await bus.send("pricing", {
  performative: "request",
  sender: "customer",
  receiver: "pricing",
  content: { goal: "quote", item: "widget", quantity: 10 },
  timestamp: Date.now(),
});
```

The content of a request is the new goal's **data**, so the plan reads it from
`intention.goal.data`:

```typescript
const { item, quantity } = intention.goal.data as {
  item: string;
  quantity: number;
};
```

The requester is answered in the same conversation, and the reply is one of
two acts:

- **`agree`** — the work is on. The content names the goal id that was
  assigned, so the requester never has to guess which job it is now
  responsible for.
- **`refuse`** — the work was never taken on, with a `verdict` saying why:
  `"no-plan"` (no plan serves that goal), `"capacity"` (the queue is full),
  `"middleware"` (your own chain declined it), and two more.

Work that was *undertaken* and could not be completed ends differently — with a
`failure`, not a `refuse`. Step 4 is about that difference.

So a request that was agreed ends like this:

```
inform { goal: "quote", goalId: "goal-…", done: true, result: { total: 42 } }
```

`result` is the goal's answer: whatever the plan's last action set as
`ActionResult.result`.

**The agent needs a tick.** Perception is a step of the reasoning cycle, not of
delivery, so nothing an agent is told changes anything until its next cycle:

```typescript
await pricing.tick(); // the request is perceived, the goal created, the plan run
```

In production you let the timer do it — `await pricing.start(50)` runs a cycle
every 50 ms — and drive it by hand only in tests.

## Step 3 — Publishing a result; a second agent subscribes

A plan can also say something to *everyone* rather than to one peer, by putting
a `topic` on a message instead of a `receiver`:

```typescript
{
  name: "announce",
  execute: async (_intention, beliefs) => ({
    messages: [
      {
        topic: "quotes",
        performative: "inform",
        content: beliefs.get("lastQuote"),
      },
    ],
  }),
}
```

Any agent that subscribed to the topic hears it, and — since an `inform` is an
assertion — believes it:

```typescript
const dashboard = new Agent({
  id: "dashboard",
  bus,
  planLibrary: new PlanLibrary(),
});
await dashboard.subscribe("quotes");
```

The belief base is where the content lands, one key per content key, under the
`msg.` prefix:

```typescript
dashboard.beliefs.all();
// { "msg.item": "widget", "msg.quantity": 10, "msg.total": 148.75 }
```

An agent subscribed to a topic receives what it publishes itself, so an agent
that both publishes and subscribes hears its own announcements.

## Step 4 — Failing, and what the requester receives

An action reports failure by returning it:

```typescript
const unit = beliefs.get<number>(`price.${item}`);
if (unit === undefined) {
  return { failure: { reason: `no price for ${item}` } };
}
```

The intention fails, the goal fails, and the requester — which was told
`agree` — is told `failure`:

```
failure { goal: "quote", reason: "no price for spaceship" }
```

The difference between the two answers is the whole point of the vocabulary:

| | `refuse` | `failure` |
| --- | --- | --- |
| when | before the work starts | after it was undertaken |
| what it says | the work will not be done | the work was tried and could not be completed |
| who gets it | the requester, instead of an `agree` | the requester, instead of the terminal `inform` |

A `refuse` is never sent after an `agree`, and a `failure` is never sent
without one. So the requester always learns exactly one thing: the work is on
and it finished, the work was never taken on, or the work was tried and failed.

A failure does not discard the rest of the action's result: an action that
returns `failure` *alongside* belief updates or messages has all of them
applied first. Partial progress is real progress.

## Step 5 — Splitting the work: `delegations` and `continueWith`

There are two ways to split work, and they answer different questions.

**`delegations` — hand the work off and wait for it.** The plan blocks until
the work is done, and reads the answer:

```typescript
{
  name: "ask-tax",
  execute: async () => ({
    delegations: [
      { receiver: "tax", goal: "vat", view: { country: "DE" } },
    ],
  }),
},
{
  name: "total",
  execute: async (intention) => {
    const vat = intention.delegations.find((d) => d.goal === "vat")
      ?.result as { rate: number };
    return { result: { total: vat.rate } };
  },
},
```

A delegation with no `receiver` (or this agent's own id) is a **sub-goal**: the
agent does the work itself, and the failure of one is the parent's failure. A
delegation with a `receiver` is a `request` to that agent, and its answer is
the `result` its plan returned.

**`continueWith` — hand the goal on.** A plan that loops — paging, polling,
retrying — should not delegate its next step, because every step would nest one
level deeper. The last action hands the goal on instead:

```typescript
{
  goal: "list-prices",
  body: [
    {
      name: "fetch-page",
      execute: async (intention) => {
        const { page = 1 } = intention.goal.data as { page?: number };
        if (!CATALOGUE[page]) {
          return { result: { pages: page - 1 } };
        }
        return {
          continueWith: { goal: "list-prices", data: { page: page + 1 } },
        };
      },
    },
  ],
}
```

The goal keeps its id, its lineage and the request it answers; it takes the new
name and data and goes back to `pending`, to be planned afresh. The requester
is answered once, when the chain ends:

```
inform { goal: "list-prices", goalId: "goal-…", done: true, result: { pages: 2 } }
```

So:

| | `delegations` | `continueWith` |
| --- | --- | --- |
| what moves | the work | the goal |
| who waits | the intention, until the work is done | nobody: the intention completes |
| what the requester gets | one answer, when the work is done | one answer, when the chain ends |
| use it for | work in parallel, or work another agent does | a loop: pages, polls, retries |

`continueWith` is valid only from a plan's **last** action, and never together
with `delegations`, `calls` or `awards`. Anywhere else the intention fails with
a reason saying so.

For work the plan does *not* wait for at all, `spawn` a new root goal instead:

```typescript
{ spawn: [{ name: "audit", priority: 1 }] }
```

A spawned goal has no parent and no requester: it is not dropped when the
spawning goal fails, and nobody is answered about it.

## Step 6 — Watching it happen: events

Everything an agent does is observable without polling it. `agent.on(event,
handler)` returns an unsubscribe function, and every handler is typed for its
event:

```typescript
pricing.on("goal:added", (goal) => console.log(`queued ${goal.name}`));
pricing.on("intention:advanced", ({ action }) => console.log(`ran ${action.name}`));
pricing.on("goal:failed", ({ goal, reason }) =>
  console.error(`${goal.name} failed: ${reason}`),
);
```

The events an agent emits are listed in [EVENTS.md](EVENTS.md). The ones worth
knowing first:

| Event | What it says |
| --- | --- |
| `goal:added` | a goal entered the queue |
| `goal:status` | a goal changed status |
| `intention:started` | a plan was picked for an active goal |
| `intention:advanced` | an action ran |
| `intention:waiting` | the intention is waiting for delegated work |
| `intention:completed` | the plan ran out of actions |
| `intention:failed` | the plan failed |
| `goal:failed` | the goal failed for good |
| `message:sent` / `message:received` | the traffic |
| `goalAcknowledged` / `goalRefused` | an answer to a request this agent sent |

Two rules worth knowing before you build a monitor on them:

- **Handlers run synchronously**, on the cycle that raised the event, so they
  must not block. Hand slow work to a queue. A handler that throws fails that
  cycle: a manual `tick()` rejects with its error, and the `start(interval)`
  loop reports it on `cycle:failed` and carries on.
- **Goals and intentions are live objects**, mutated in place as the work
  progresses. Snapshot one (`{ ...goal }`) to hold the state you saw.

## Step 7 — Testing a plan

`classic-agents/testing` runs a plan's steps without an agent, a bus or a
hand-built intention. Take the two-step version of the quote plan — `ask-tax`
and `total` — and run its second step:

```typescript
import { runAction } from "classic-agents/testing";

const { result, failure, beliefs } = await runAction(quotePlan, "total", {
  data: { item: "widget", quantity: 10 },
  beliefs: { "price.widget": 12.5 },
  results: { vat: { rate: 0.19 } },
});

expect(result?.result).toEqual({ total: 148.75 });
expect(failure).toBeUndefined();
```

`results` answers the sub-goals the plan already delegated: `vat` is recorded
on the intention as a delegation holding `{ rate: 0.19 }`, which is what
`intention.delegations.find(...)` finds.

`runAction` runs that one step, the way the agent runs it: the belief updates
are applied, and a `failure` or a throw runs the plan's `onPlanFailure` hook
and reports what the requester would be told. What the result would *start* —
delegations, messages, spawned goals — is returned for the test to check, not
carried out.

To test the plan as a whole, `runPlan` runs it to the end on a real agent, so
it is stepped, waits and fails exactly as in production. Each goal it delegates
is answered from `subGoals`, by goal name:

```typescript
import { runPlan } from "classic-agents/testing";

const trace = await runPlan(quotePlan, {
  data: { item: "widget", quantity: 10 },
  beliefs: { "price.widget": 12.5 },
  subGoals: { vat: { result: { rate: 0.19 } } },
});

expect(trace.outcome).toBe("achieved");
expect(trace.steps.map((s) => s.action)).toEqual(["ask-tax", "total"]);
```

The whole testing surface is in [TESTING.md](TESTING.md).

## Where to go next

You now have the 10% most people need. The rest is there when you need it:

- [ARCHITECTURE.md](ARCHITECTURE.md) — the reasoning cycle, one step at a time,
  and the stores behind it.
- [MESSAGING.md](MESSAGING.md) — the wire: performatives, the envelope, topics,
  and how to follow a request you sent.
- [BELIEFS.md](BELIEFS.md) — the belief base, and what `confirm` and
  `disconfirm` do to it.
- [MIDDLEWARE.md](MIDDLEWARE.md) — withdrawing the trust assumption: what you
  believe, and what you agree to do.
- [DESIRES.md](DESIRES.md) — goals the agent starts itself, from its own
  beliefs.
- [EVENTS.md](EVENTS.md) — every event, with its payload.
- [DELEGATION.md](DELEGATION.md) — delegating in depth: deadlines, cancelling,
  failure handling.
- [CONTRACT-NET.md](CONTRACT-NET.md) — asking several agents to bid, and
  choosing one.
- [PERFORMATIVES.md](PERFORMATIVES.md) — how each of the 22 FIPA acts is
  handled, and why.
- [EXAMPLES.md](EXAMPLES.md) — the runnable examples, and what each one shows.
