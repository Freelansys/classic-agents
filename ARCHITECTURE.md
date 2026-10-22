# Architecture

How the pieces fit together, one reasoning cycle at a time. This is the
reference for the engine; [GETTING-STARTED.md](GETTING-STARTED.md) is the
walkthrough if you are new here.

- [The BDI reasoning cycle](#the-bdi-reasoning-cycle)
- [The stores](#the-stores)
- [Working set and history](#working-set-and-history)
- [Refusing work past the bound](#refusing-work-past-the-bound)
- [Goals and dependencies](#goals-and-dependencies)
- [Plans serve goals by name](#plans-serve-goals-by-name)
- [Alternative plans: `context`](#alternative-plans-context)
- [When a plan fails: `onPlanFailure`](#when-a-plan-fails-onplanfailure)
- [When a goal fails: `onGoalFailure` and `goal:failed`](#when-a-goal-fails-ongoalfailure-and-goalfailed)
- [Action failures](#action-failures)
- [Sub-goal failures](#sub-goal-failures)
- [Goal achieved](#goal-achieved)
- [Delegation in brief](#delegation-in-brief)
- [Contract Net in brief](#contract-net-in-brief)

## The BDI reasoning cycle

Each agent runs an asynchronous reasoning loop. One cycle — one `tick()` — does, in order:

1. **Perceive** — take everything the bus has delivered since the last cycle out of the inbox (`agent.inbox`), oldest first. Nothing is decided yet: a message is an *event*, and being told something is not the same as having taken it in.
2. **Revise Beliefs** — decide what the perceived messages mean. An assertion about the world becomes a belief if — and only if — its `middleware` chain does not cancel the write. A directive passes its `directiveMiddleware` chain and then takes its own path: a `request` becomes a goal, a query is answered from the agent's knowledge, a standing directive is agreed to and watched, and a `cfp` is bid on. A reply to a directive this agent sent settles what it was tracking for it. This is where an agent chooses to believe, and chooses to work, rather than having either happen as a side effect of delivery.
3. **Expire and answer** — close the exchanges whose `reply-by` passed unanswered, drop the bids that expired, close the calls for proposals that are done, fail the delegations whose work deadline passed, send the `agree`s and `refuse`s just decided, and evaluate the standing directives.
4. **Deliberate** — reconsider the agent's desires: for each that asks for one, generate a goal, then promote the highest-priority eligible goal to active. Work only ever starts because a goal says it should, so every action can name the goal it was for and be correlated with it — a desire's goal no less than a request's, only with no requester to answer.
5. **Means-Ends Reasoning** — for active goals not already covered by an intention, take the first plan that serves the goal by name and whose `context` holds in the current beliefs, and instantiate an intention, up to `maxConcurrentIntentions`. A goal no plan is applicable to fails; it never waits.
6. **Execute** — advance each runnable intention by one action step. Concurrent intentions execute in parallel via `Promise.allSettled`; an intention waiting on delegated work or an open call is skipped.
7. **Report and collect** — send the refusals for goals shed past the bound and the terminal `inform`/`failure` owed for every agreed request that finished, then collect finished goals and intentions.

The cycle runs on a timer (`start(tickIntervalMs)`) or is driven manually via `tick()`.

On the timer, cycles never overlap, and a cycle that fails (`tick()` rejects, for example because an event handler threw) is reported on `cycle:failed` and the next one still runs; without a listener the error is logged to the console. `stop()` schedules no further cycle and waits for the one running, which may be in the middle of a slow action; `stop({ timeoutMs })` bounds that wait (`0` does not wait), and `idle({ timeoutMs? })` waits for a cycle `stop()` stopped waiting for. Both resolve `true` once no cycle is running, `false` if the wait timed out:

```typescript
agent.on("cycle:failed", ({ agentId, error }) => log.error(agentId, error));
await agent.start(50);
// …
if (!(await agent.stop({ timeoutMs: 5000 }))) {
  log.warn("stopped with a cycle still running");
}
```

Because perception is a step of the cycle and not of delivery, a message that arrives between two ticks changes nothing until the next one. That is what makes an agent's beliefs a record of what it decided, rather than of everything that was ever said to it.

The two middleware chains hook into steps 2, and only there: the belief chain
gates what an assertion is allowed to write, the directive chain gates what a
directive is allowed to become. See [MIDDLEWARE.md](MIDDLEWARE.md).

## The stores

The BDI engine is four stores and the cycle that reads and writes them.

### `BeliefBase`

A pluggable typed key-value belief store, holding a `BeliefStatus` (`"positive"`/`"uncertain"`/`"negative"`) beside each value so a `disconfirm` can record the sender's stance against the content it names. The `BeliefBase` interface defines the contract (`get`/`set`/`setStatus`/`statusOf`/`compareAndSet`/`remove`, prefix and predicate queries, `beliefAdded`/`beliefUpdated`/`beliefRemoved` events); the default backend is `InMemoryBeliefBase`. Inject any implementation via `Agent` config (`beliefs`) — one backed by Redis, say — just like swapping message-bus transports.

The full API, the stance model and update patterns are in
[BELIEFS.md](BELIEFS.md).

### `GoalQueue`

Priority-based goal queue with pluggable selection strategy. Goals have statuses: `pending → active → achieved | failed | dropped`. Goals can declare dependencies on other goals via `dependsOn: string[]` — a goal is only selected when all its dependencies have achieved. Failed goals cause dependent goals to be dropped. Sub-goals an action delegates to its own agent (`delegations` with no `receiver`) record where they came from: `parentGoalId` is the goal whose plan created them, and `rootGoalId` is the top of that chain (the parent's `rootGoalId`, or the parent's own id), so lineage survives the creating intention. The default selection never activates the same goal twice at once — same name and same `key`, which defaults to the goal's `data` compared by value — so a duplicate request waits for the first instead of running on top of it, while goals of one name about different things (a `qualify` per lead) run side by side. A sub-goal under a waiting ancestor that is the same goal is exempt, so a plan may delegate its own goal (bounded recursion) without deadlocking. `goalKey(goal)` exposes the comparison for a custom selection (`goalSelection` in `Agent` config). The queue emits `goalAdded`, `goalStatusChanged`, `goalRejected` and `goalRemoved` for everything that happens to it (see [EVENTS.md](EVENTS.md)).

A selection is a `GoalSelectionFunction`: `(pending, active, achieved) => Goal | undefined`, where `achieved` is the set of achieved goal ids that something still depends on. Before 1.6.0 the default held back every goal of the same name, not only the same goal. An agent whose plans share state that only the goal's name identifies can restore that by wrapping `defaultGoalSelection` (this simple version also drops the recursion exemption, so a plan must not delegate its own goal under it):

```typescript
import { defaultGoalSelection, type GoalSelectionFunction } from "classic-agents/core";

const oneAtATimePerName: GoalSelectionFunction = (pending, active, achieved) =>
  defaultGoalSelection(
    pending.filter((p) => !active.some((a) => a.name === p.name)),
    active,
    achieved,
  );

new Agent({ id: "crm", bus, planLibrary: lib, goalSelection: oneAtATimePerName });
```

Because an achieved goal is collected at the end of the cycle that finished it,
the queue keeps a small separate record of achievements that something still
depends on — `goals.achievedIds()`, or `goals.dependenciesMet(goal)` for the
check itself. It is reference-counted against the goals that declare
`dependsOn`, so the record is retained only while there is work waiting on it:
an agent that never uses `dependsOn` retains nothing, and a goal that is waiting
on a dependency nobody has achieved yet simply stays `pending`.

Goals are **bounded, not rotated**. An agent holds at most `maxGoals` unfinished goals (`pending` + `active`, sub-goals included; default `1000`, `0` or `Infinity` for unbounded). A goal offered once the bound is reached is admitted and immediately failed rather than queued — the queue is full, so backpressure is the honest answer. Nothing is ever evicted to make room: a goal leaves the queue only after reaching `achieved`, `failed` or `dropped`, at the end of the cycle that finished it. So `goals.all()` is the agent's *current* work, not its history; read history off the event stream (see [Working set and history](#working-set-and-history)).

### `PlanLibrary`

Registers plans, each a `{ goal, name?, body, context? }` where `goal` is the goal it serves, `name` the plan's own unique name (defaulting to the goal's, so a goal's second plan needs one), `body` the actions it runs, and `context` an optional condition choosing among several plans for the same goal. Registering a plan that serves a goal is the agent saying it can do it. `declares(goalName)` is the static check that lets a directive be refused as `no-plan` before a goal exists; `applicable(beliefs, goal, exclude?)` returns the plans that serve a goal and whose context holds, in registration order; `serving(goalName)` returns every plan that serves a goal, ignoring context; `match(goal)` returns the first plan that serves a goal by name, ignoring context.

See [Plans serve goals by name](#plans-serve-goals-by-name) and
[Alternative plans: `context`](#alternative-plans-context) below.

### `DesireLibrary`

Registers the desires an agent holds, each a `{ name, intend, trigger?, retryAfterMs?, onRetract? }` rule. `intend(beliefs)` is a pure, synchronous function returning the goal descriptor (`{ goal, priority?, data?, dependsOn?, key? }`) to pursue now, a list of them — one per item, told apart by `key` — or `undefined` for "not asking" — the same descriptor an action `spawn`s, so it is goal-driven rather than action-shaped. The generated `goal` is treated as any other, save that it has no `source` and so owes no reply. A desire does not fire again for an item whose goal is still in flight; `trigger` (`"edge"`, the default, or `"level"`) decides whether it fires again once that goal finishes — the same `Trigger` rule standing `request-when*` directives follow. `declares(name)` and `all()` round it out. Inject via `Agent` config (`desires`); see [DESIRES.md](DESIRES.md).

### `Trigger`

The firing rule shared by desires and standing `request-when` / `request-whenever` directives: watch a condition cycle by cycle (`observe(holds)`), decide when a goal is due — on a rising edge (`"edge"`) or while it holds (`"level"`) — and hold the firing until the goal queue has room (`ready(goals)`). Optionally allows only one goal in flight (`oneInFlight`) and waits `retryAfterMs` after a goal it fired failed. The caller creates the goal and reports it with `fired(goal)`; `outstanding()` returns that goal while it is unfinished. An evaluation that errored is simply not observed, so it never counts as an edge. `idle()` says whether the trigger holds nothing worth keeping — the condition does not hold, no goal is in flight and no retry delay is running — so a caller watching many conditions can discard idle triggers, as a fanned-out desire does for an item that has left.

### `IntentionStack`

Tracks active intentions with states: `pending → executing | waiting → completed | failed`. Intentions enter `waiting` when their action delegates work (`delegations`) — sub-goals of this agent's, or requests to other agents — and resume once all of it is done; work delegated by the last action is waited for too, and the intention completes then. A delegation that *fails* also releases the parent, which fails with it (see [Sub-goal failures](#sub-goal-failures)). Goals an action `spawn`s are independent and never waited for. A last action that hands its goal on with `continueWith` completes the intention without achieving the goal; see [DELEGATION.md](DELEGATION.md) › *Handing on: `continueWith`*.

### `Agent`

Orchestrates the full BDI cycle. Configurable for:

| Option | Default | What it does |
| --- | --- | --- |
| `maxConcurrentIntentions` | `10` | plans run at once |
| `maxGoals` | `1000` | unfinished goals (`0`/`Infinity` unbounded) |
| `maxInboxSize` | `DEFAULT_MAX_INBOX_ENTRIES` | delivered-but-unperceived messages |
| `middleware` | `[]` | the belief chain ([MIDDLEWARE.md](MIDDLEWARE.md)) |
| `directiveMiddleware` | `[]` | the directive chain ([MIDDLEWARE.md](MIDDLEWARE.md)) |
| `beliefs` | a new `InMemoryBeliefBase` | the belief store ([BELIEFS.md](BELIEFS.md)) |
| `beliefKey` | `defaultBeliefKey` (the `msg.` prefix) | where an accepted assertion's content keys are stored |
| `propositionLibrary` | an empty `PropositionLibrary` | named predicates a query can read |
| `expressionLibrary` | an empty `ExpressionLibrary` | named expressions, also used for `cfp` bids |
| `desires` | an empty `DesireLibrary` | goals the agent starts itself ([DESIRES.md](DESIRES.md)) |
| `goalSelection` | `defaultGoalSelection` | how the next pending goal is chosen ([`GoalQueue`](#goalqueue)) |
| `onGoalFailure` | none | runs once when a goal's work fails for good ([When a goal fails](#when-a-goal-fails-ongoalfailure-and-goalfailed)) |
| `replyTimeoutMs` | `30_000` | default `reply-by` stamped on every directive it sends |
| `evaluationTimeoutMs` | `10_000` | how long a proposition or expression may run before it is answered `failure` |
| `maxConcurrentEvaluations` | `100` | how many may run at once before a query is refused `capacity` |
| `delegationTimeoutMs` | `300_000` | how long a remote delegation's work may take before it fails and its receiver is sent a `cancel` |
| `proposalTimeoutMs` | `replyTimeoutMs` | how long a bid it makes stays valid |
| `supportedLanguages` | `[]` (all) | content languages it can read |
| `supportedOntologies` | `[]` (all) | ontologies it can read |

Replies always go to a message's `reply-to` when it names one; evaluations never
block the reasoning cycle. See [PERFORMATIVES.md](PERFORMATIVES.md) › *`reply-to`
and `reply-by`* and *Evaluating propositions and expressions*.

## Working Set and History

Finished goals and intentions are **collected**, not retained: once a goal reaches `achieved`, `failed` or `dropped` it leaves the queue at the end of the cycle that finished it, and an intention in `completed` or `failed` leaves the stack the same way. Neither store is a log. A long-running agent that completes a million jobs holds roughly a million jobs' worth of *nothing* — just its current working set — because both stores are indexed by status and only the unfinished entries are ever walked by the reasoning cycle.

The practical consequence: `goals.all()` and `intentions.getAll()` answer "what is the agent working on now?", not "what has it ever done?". Anything that needs history should subscribe to the event stream, which is the same thing a monitor does.

Collection is deliberately deferred to the end of the cycle rather than done at the transition, so a job's whole event sequence arrives with the store objects still present. A listener on `intention:completed` can still read its goal as `achieved`, because the goal is collected after that event fires, not before.

```typescript
// A monitor keeps the history the stores deliberately do not.
const history: Goal[] = [];
agent.on("goal:status", ({ goal }) => history.push({ ...goal }));
agent.on("goal:removed", (goal) => history.push({ ...goal }));
```

## Refusing Work Past the Bound

A goal the queue could not take fails immediately, which means the same two things a failed job does: an answer to whoever asked for it, and a failed child for the parent waiting on that sub-goal. The answer differs by lineage. A **root** goal gets a `refuse`, since no `agree` went out for it. A **sub-goal** gets none: it carries its parent's `source`, so its requester is the one already holding an `agree` for the goal it did ask for, and FIPA allows no `refuse` after `agree` — the shed sub-goal fails its parent, and the requester hears the root goal's single `failure` instead. What sets the shed apart either way is the event that reports it: a goal shed for capacity is declined, never attempted, so it fires `goal:rejected` rather than `intention:failed`, and the `reason` names the limit:

```typescript
agent.on("goal:rejected", ({ goal, reason }) => {
  console.warn(`${goal.name} shed for capacity: ${reason}`);
  scheduleRetry(goal.id); // backpressure, not a fault
});
```

Refusal releases room as soon as earlier work finishes, so a queue at its bound still drains.

## Goals and dependencies

Two ways to make goals without a request:

```typescript
// Independent work, nobody waits for it: spawn.
lib.register({
  goal: "onboard",
  body: [
    {
      name: "create-account",
      execute: async () => ({
        beliefUpdates: [{ key: "accountCreated", value: true }],
        spawn: [{ name: "setupProfile", priority: 10 }],
      }),
    },
  ],
});

// Prerequisites, by id: dependsOn.
agent.goals.add({
  id: "g-deploy",
  name: "deploy",
  priority: 10,
  status: "pending",
  dependsOn: ["g-build", "g-test"], // won't be selected until both achieve
});
```

A spawned goal has no parent and no `source`: it is not dropped when the
spawning goal fails, not withdrawn by a `cancel` of its request, and not
answered to anyone.

The achievement outlives the goal that made it, so a dependent goal added
later — or selected on a later cycle — still sees the dependency as met:

```typescript
agent.goals.achievedIds(); // => Set { "g-build", "g-test" }
agent.goals.dependenciesMet({
  id: "x",
  name: "deploy",
  priority: 1,
  status: "pending",
  dependsOn: ["g-build"],
}); // => true
```

## Plans Serve Goals by Name

A plan carries the `goal` it serves and a `body`: the work that goal takes.
Registering a plan for `deploy` is the agent saying it can `deploy`, and
nothing more: the moment a `deploy` goal exists, means-ends reasoning finds that
plan and starts it.

```typescript
lib.register({
  goal: "reading",          // the goal it serves
  body: [/* … */],
});
```

A plan also has a `name`, which defaults to its goal's. The name is the plan's
identity: it is what `goal:failed`'s `attempts`, cancellation reports and
failure reasons call the plan, and it must be unique in the library —
`register` throws on a duplicate. A goal with a single plan needs no name; when
a goal has several plans, give each one after the first its own:

```typescript
lib.register({
  name: "read-from-cache",  // the plan's own name
  goal: "reading",          // the goal it shares
  body: [/* … */],
});
```

Plans share a goal, never a name.

There is no readiness test between the goal and the body. A plan is a
capability, so whether the work *can* proceed is the body's business, and the
body reports a `failure` when it cannot. This is deliberate: making work wait
inside the agent on a belief only the agent holds is a `request-when` the
sender never named, so a condition to wait on is always the sender's to
declare — see [MESSAGING.md](MESSAGING.md) › *Standing directives*.

`declares()` reports whether some plan serves a goal name. It is checked against
a plan library that is fixed for the agent's lifetime, so a plan registered
*after* a request was refused will not retroactively rescue it. That is the
trade for answering honestly at admission instead of agreeing and stalling: an
unservable request can never occupy a `maxGoals` slot.

## Alternative Plans: `context`

Several plans may serve the same goal: different ways of achieving it. A plan's
optional `context` — `(beliefs, goal) => boolean` — says whether it is a
sensible way *now*, and chooses among them; it never delays.

```typescript
lib.register({
  name: "ship-by-courier",
  goal: "ship",
  context: (beliefs) => beliefs.get("courier.up") === true,
  body: [/* book a courier */],
});
lib.register({
  name: "ship-by-post",
  goal: "ship",                // no context: always applicable
  body: [/* send it by post */],
});
```

- **Selection.** When a goal is planned, the first plan in registration order
  that serves it and whose context holds runs. Register the preferred way
  first.
- **Fallback.** When that plan fails — an action reports a `failure` or
  throws, or a delegation it cannot do without fails — the goal is not failed
  yet. Contexts are evaluated again, against the beliefs the failure left, and
  the next applicable plan not yet tried takes the goal over. The goal stays
  `active` and its requester is still owed one answer. It fails, with the last
  plan's reason, only once no untried plan is applicable. A failed plan is not
  retried for the same goal; a goal handed on with `continueWith` is planned
  afresh.
- **Never waiting.** A goal no plan is applicable to fails at once with
  `no applicable plan for "<goal>"`. A requester that was agreed to gets a
  `failure`, not a stall.
- **Admission ignores it.** A request is agreed to if any plan serves it by
  name: the beliefs a context reads may change before the goal is worked.
- **Not for withdrawn work.** A goal that is removed or being cancelled is
  never handed to another plan.

Each handover emits `intention:failed` for the plan that failed, then
`goal:replanned` (`{ goal, failed, reason, intention }`), then
`intention:started` for the next plan. Effects of the failed plan's earlier
actions are not undone; the next plan runs in the world they left, which is
what its context is evaluated against — undoing them is the job of
`onPlanFailure`, below. A context should be cheap, synchronous and free of side
effects; one that throws counts as not applicable.

## When a Plan Fails: `onPlanFailure`

A plan's optional `onPlanFailure` hook runs each time the plan fails, before
anything else reacts: before its delegations are cancelled, before another plan
is tried, before the requester is answered. It is the one place for what every
action would otherwise repeat in a `catch` — logging, a status belief, a message
on a failure topic, releasing a resource, compensating for what the plan's
earlier actions did.

```typescript
lib.register({
  goal: "enrich",
  body: [/* actions that do I/O, with no try/catch */],
  onPlanFailure: async (intention, beliefs, failure) => {
    // failure: { reason, cause: "action" | "delegation", action?, error? }
    logger.error(`enrich failed in ${failure.action}: ${failure.reason}`);
    await releaseLease(intention.goal.id);
    return {
      beliefUpdates: [{ key: "status", value: "degraded" }],
      reason: "enrichment unavailable", // optional: replaces the reason
    };
  },
});
```

- **When.** An action returned `failure` or threw (`cause: "action"`, with the
  action's name and, for a throw, the `error`), or a delegation the plan could
  not do without failed (`cause: "delegation"`). Not for withdrawn work — a
  `cancel`, or a goal removed before it finished — which is `onCancel`'s.
- **What it may do.** Its `beliefUpdates`, `beliefRemovals` and `messages` are
  applied; it cannot start work. Its `reason`, when given, replaces the
  failure's reason in `intention:failed`, `goal:replanned`, `goal:failed` and
  the requester's `failure`.
- **Per plan, not per goal.** If another applicable plan then takes the goal
  over, this plan has still failed and its hook still ran. Its belief updates
  are applied before the contexts are evaluated again, so it can steer which
  plan runs next. For the goal's own failure, listen to `goal:failed`.
- **A hook that throws** does not stop the failure: it goes ahead with the
  reason unchanged, and the error is reported on `intention:failed` as
  `onPlanFailureError`.

## When a Goal Fails: `onGoalFailure` and `goal:failed`

A plan's hook sees one plan. For what should happen when a goal's work fails
*for good* — its last applicable plan failed, or no plan was applicable — give
the agent an `onGoalFailure` hook:

```typescript
const agent = new Agent({
  id: "shipper",
  bus,
  planLibrary,
  onGoalFailure: async (goal, beliefs, { reason, attempts }) => ({
    beliefUpdates: [{ key: "status", value: "failed" }],
    messages: [
      { topic: "failures", performative: "inform", content: { goal: goal.name, reason } },
    ],
    // optional: replaces what the requester is told
    reason: `${goal.name} unavailable after ${attempts.length} attempt(s)`,
  }),
});
```

- **When.** Once per goal, after its last plan's `onPlanFailure`, before the
  goal is marked `failed`: so before `goal:failed` and before the requester's
  `failure`. Not for a goal that was never taken on — declined, or rejected
  for room — whose requester gets a `refuse`, and not for one cancelled or
  dropped.
- **What it may do.** The same as `onPlanFailure`: `beliefUpdates`,
  `beliefRemovals`, `messages` (sent in the goal's conversation), and a
  `reason` that replaces the goal's in `goal:failed`, the requester's
  `failure` and a waiting parent's child failure. `intention:failed` keeps the
  plan's own reason. It cannot start work or save the goal: alternative plans
  are how a goal recovers.
- **`attempts`** lists every plan tried for the goal, in order: each is its
  `PlanFailure` (`reason` as `onPlanFailure` left it, `cause`, `action`,
  `error`) plus the `plan` object and the `intentionId`. Empty when no plan
  ran. This is the one place that sees them all and can still change what the
  requester is told; by default a requester's `failure` carries only the last
  reason, since how many ways the agent tried is its own business and plans
  have no identity to put on the wire.
- **A hook that throws** does not stop the failure; the reason stays as it
  was and the error is reported on `goal:failed` as `onGoalFailureError`.

`goal:failed` (`{ goal, reason, attempts, onGoalFailureError? }`) is the
observation side of the same moment. It fires for *every* goal that reaches
`failed` — including those declined or rejected for room, which the hook
skips — any number of listeners can watch it, and it changes nothing. Use the
hook to act, the event to watch:

```typescript
agent.on("goal:failed", ({ goal, reason, attempts }) => {
  logger.warn(`${goal.name} (${goal.id}) failed: ${reason}`, {
    tried: attempts.map((a) => ({ action: a.action, reason: a.reason })),
  });
});
```

## Action Failures

An action signals failure by returning `failure: { reason }` in its `ActionResult` (or by throwing). Either way the intention and its goal are marked `failed`, goals that depend on it are `dropped`, its open delegations are cancelled, a requester that was agreed to is sent `failure { goal, reason }` once the root goal fails, and the `intention:failed` event reports it:

```typescript
agent.on("intention:failed", ({ intention, reason }) => {
  console.error(`${intention.goal.name} failed: ${reason}`);
});
```

The event carries the live intention, which is what makes it a complete report: its goal, plan, the action that failed, and — when the failing goal was itself a sub-goal — the same lineage the goal carries, so whoever consumes the event still knows which job the failure belongs to:

```typescript
agent.on("intention:failed", ({ intention }) => {
  const { parentGoalId, rootGoalId } = intention.goal; // undefined at the root
  sendAlert({ goal: intention.goal.name, parentGoalId, rootGoalId });
});
```

A goal that came from a directive also carries its `source` on the goal, so the consumer of the event can route the failure back to whoever asked for the work — per chat thread, per conversation. The `source` is the same on every failure in the chain, whether it surfaced on the top-level goal or on a deeply nested sub-goal.

A failure never discards the rest of the action's result. When an action returns `failure` *alongside* `beliefUpdates`, `beliefRemovals`, `spawn`, `delegations` or `messages`, every one of those is still applied before the intention is failed — partial progress is real progress. An action that reports a failure keeps that reported reason even if applying its other results subsequently throws.

## Sub-goal Failures

An intention waiting on its delegations is released when one of them fails — a parent can never sit in `waiting` forever (which would also keep holding a `maxConcurrentIntentions` slot). By default the waiting parent fails too, with a reason naming the sub-goal or the delegate, and the failure keeps cascading to *its* waiting parents until the top-level goal fails:

```
sub-goal "build" failed: 503 from registry
delegation of "pick" to warehouse failed: refused (no-plan): no plan serves "pick"
```

Every intention that fails this way reports the same `intention:failed` event as any other failure.

A plan that can recover from a failed sub-goal says so on the delegation:

```typescript
lib.register({
  goal: "deploy",
  body: [
    {
      name: "prepare",
      execute: async () => ({
        delegations: [
          // "fail" (default) | "continue"
          { goal: "build", priority: 10, onFailure: "continue" },
          { goal: "test", priority: 9, onFailure: "continue" },
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

With `"continue"` the failed delegation is no longer awaited, the reason is
recorded in `intention.childFailures`, and the parent resumes with its next
action once nothing is left outstanding — the remaining delegations are still
awaited rather than abandoned. See [DELEGATION.md](DELEGATION.md) › *Failure
handling*.

## Goal Achieved

When a goal reaches `achieved`, the `intention:completed` event reports it, carrying the completed intention — its goal, plan, and the `result` of the last action. The one exception is a plan that hands its goal on with `continueWith`: its intention completes too, but the goal goes back to `pending` (check `intention.goal.status`, or listen to `goal:continued`):

```typescript
agent.on("intention:completed", (intention) => {
  console.log(`${intention.goal.name} achieved`, intention.result);
});
```

The completed intention mirrors a failure report: the same `parentGoalId`/`rootGoalId` lineage and the same `source` for goals that came from a directive, so completions route back to whoever asked for the work. A monitor watching both `intention:failed` and `intention:completed` sees a job end to end.

Whoever requested a goal is answered automatically when its root goal ends: `inform { goal, goalId, done: true, result? }` when it is achieved, `failure { goal, reason }` when it fails or is dropped. `result` is the goal's answer: whatever its plan last set as `ActionResult.result`, left out when it set none.

```typescript
lib.register({
  goal: "quote",
  body: [
    {
      name: "price",
      execute: async (intention) => ({ result: { price: await price(intention.goal.data) } }),
    },
  ],
});
// The requester receives: inform { goal: "quote", goalId: "goal-…", done: true, result: { price: 12.5 } }
```

A plan that wants to send the reply itself can: an `inform` it sends to the
requester marked `done: true` replaces the automatic one, and any other
`inform` is a progress note. See [PERFORMATIVES.md](PERFORMATIVES.md) ›
`request` › *The terminal reply*.

## Delegation in brief

A plan hands work off with `delegations` and waits for it, whether this agent
does it or another one:

| `ActionResult` field | What it creates | Waited for |
| --- | --- | --- |
| `delegations` (no `receiver`) | a sub-goal of this agent | yes |
| `delegations` (a `receiver`) | a FIPA `request` to that agent | yes |
| `spawn` | a new root goal | no |
| `continueWith` | the same goal, handed on under a new name | — |

Every delegation is recorded on `intention.delegations`, open or settled, with
its `status`, `goalId`, `result` (or `reason`) and the latest `progress` note a
remote delegate sent. `waitFor` on the action (`"all"`, `"any"` or a number)
and `onFailure` on each delegation (`"fail"` or `"continue"`) decide what the
parent needs.

[DELEGATION.md](DELEGATION.md) is the full reference: the wire shape, the
record, deadlines, cancelling, `continueWith`, failure handling, and the limits
of talking to peers that are not classic-agents.

## Contract Net in brief

Where a delegation picks the receiver up front, a **call for proposals** asks
several and lets the answers decide. An action opens calls with `calls`, the
intention waits until every call has closed, and the next action reads the bids
and awards them:

```typescript
lib.register({
  goal: "pave",
  body: [
    {
      name: "call",
      execute: async () => ({ calls: [{ goal: "dig", receivers: ["b1", "b2"] }] }),
    },
    {
      name: "award",
      execute: async (intention) => {
        const bids = intention.calls.flatMap((call) => call.proposals);
        if (bids.length === 0) return { failure: { reason: "no bids" } };
        const best = bids.sort((a, b) => cheap(a) - cheap(b))[0];
        // Every bid not awarded is sent `reject-proposal` for you.
        return { awards: [{ proposal: best.id }] };
      },
    },
    { name: "done", execute: async () => ({}) },
  ],
});
```

A participant opts in by naming a `bid` on the plan — an `Expression`,
computed against the `cfp` as its message, whose result becomes the `propose`'s
`terms`:

```typescript
agent.expressionLibrary.register({
  name: "quote",
  evaluate: (beliefs, cfp) => {
    const { goal } = cfp.content as { goal: string };
    return (beliefs.get<number>(`stock.${goal}`) ?? 0) > 0 ? { price: 40 } : null;
  },
});
lib.register({ goal: "dig", bid: "quote", body: [/* ... */] });
```

A call closes when every invitee has answered, when its deadline
(`deadlineMs`, default `replyTimeoutMs`) passes, or when a bid it holds is
about to expire. An action's `awards` and `delegations` form one batch, counted
by its `waitFor`, and each award has the same `onFailure` and `timeoutMs` a
delegation has. An action that fails awards nothing. Only an invitee answers
its own `cfp`.

[CONTRACT-NET.md](CONTRACT-NET.md) has the protocol, the participant and
initiator sides, and the decisions; [PERFORMATIVES.md](PERFORMATIVES.md) ›
*Contract Net* has the act-by-act rationale.
