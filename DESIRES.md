# Desires: goals the agent starts itself

Everything else in this library begins with someone else: a `request` on the
bus, a standing directive, a `cfp`. A **desire** is the other kind of goal — one
the agent chooses for itself because of what it believes. It is a standing
preference, "when my beliefs say so, pursue this goal", and it is how an agent
acts on its own initiative.

- [A desire is one function](#a-desire-is-one-function)
- [What the generated goal is](#what-the-generated-goal-is)
- [Rules worth knowing](#rules-worth-knowing)
- [Fanning out: a goal per item](#fanning-out-a-goal-per-item)
- [Events](#events)

## A desire is one function

A desire is one pure function, `intend`, asked against the beliefs once per
cycle. It returns the goal to pursue now — the same descriptor an action
`spawn`s — or `undefined` for "not right now":

```typescript
import { Agent, DesireLibrary } from "classic-agents";

const desires = new DesireLibrary();
desires.register({
  name: "cool-room",
  // What the agent wants, given what it believes. The goal, its priority and
  // its data can all depend on the situation.
  intend: (beliefs) => {
    const temperature = beliefs.get<number>("room.temperature") ?? 0;
    if (temperature <= 30) return undefined;
    return {
      goal: "cool",
      priority: temperature > 40 ? 10 : 8,
      data: { at: beliefs.get("room.id") },
    };
  },
});

const agent = new Agent({ id: "thermostat", bus, planLibrary, desires });
```

Because the goal is *returned* — the framework creates it — `intend` never does
anything itself. That is what lets the agent ask every cycle, watching for the
moment the desire begins, and stops, wanting something.

Nothing fires on `start`: desires are reconsidered in **Deliberate**, before
selection, so a goal one asks for can be worked in the same cycle.

## What the generated goal is

Once generated the goal is an ordinary goal — queued, selected, planned,
executed, cancellable — with one difference: it has no `source`, so the agent
owes nobody a reply. There is no `agree`, no `refuse`, and no terminal
`inform`/`failure`, because there is no requester; everything else is the same,
including `spawn`, `delegations`, `continueWith` and `onGoalFailure`.

A desire does not fire again for an item whose goal is still in flight, so no
desire can pile up goals.

## Rules worth knowing

- **`intend` is synchronous, cheap and free of side effects**, exactly like a
  `Plan.context`. It reads the beliefs and says what is wanted; it is not a
  place to do work. Returning `undefined` means "not asking". One that throws
  is reported on `desire:error` and changes nothing — it neither fires the
  desire nor counts as it stopping, so a flaky read cannot cause a refire.
- **One goal in flight at a time** per item. A desire with a goal still in the
  queue does not fire again for it.
- **`trigger`** decides when it fires — the same rule a `request-whenever`
  follows, shared with standing directives:
  - `"edge"` (the default) fires on the **rising edge** of the asking. A goal
    that succeeds without changing the beliefs does not immediately trigger
    another; `intend` must return nothing and then a goal once more. "Pursue X
    while P" means one attempt per occurrence of P.
  - `"level"` fires again as soon as the previous goal finishes, while `intend`
    keeps asking — for a recurring or maintenance goal.
- **`retryAfterMs`** (default 1000) is how long a desire waits after its goal
  *failed* before firing again, so a goal that fails every time is not re-run
  every cycle. An achieved goal is not delayed.
- **A goal no plan serves is not generated.** The desire is reported on
  `desire:error` instead, and fires once a plan for it is registered.
- **`onRetract`** decides what happens to the goal in flight when the desire
  stops asking: `"keep"` (the default) lets it run to its end; `"withdraw"`
  withdraws it under the rules a requester's `cancel` follows — at once if
  nothing has started, otherwise only if every started plan is `cancellable`,
  never mid-action — and reports the attempt on `desire:retracted`.
- **At the goal bound** (`maxGoals`) a desire waits rather than generate a goal
  the queue would only reject, and fires once there is room. When several are
  due and only some fit, the goals asked for at the highest priority go first.
- **`dependsOn`** on the generated goal is gated as any other: it is not selected
  until each dependency has been achieved.

## Fanning out: a goal per item

A desire may return a list — one goal per item that needs work — and each item
is then a desire of its own: it has its own trigger, fires on its own rising
edge, waits for its own goal, retries on its own after a failure, and stops
asking when it drops out of the list (withdrawn, under `onRetract:
"withdraw"`, without touching the others). An empty list is not asking.

```typescript
desires.register({
  name: "qualify-leads",
  intend: (beliefs) =>
    (beliefs.get<Lead[]>("leads.new") ?? []).map((lead) => ({
      goal: "qualify",
      key: lead.id,
      data: lead,
    })),
});
```

Each item is told apart by its `key`, recorded on the goal it generates. Leave
it out and the item is its goal name and `data`, compared by value — fine for
data that only names the item, but set `key` when `data` carries anything that
changes while it is still the same item (a score, a timestamp), or every
change would count as a new item. Two items of one answer with the same key
are reported on `desire:error`, and only the first fires.

The goals run side by side: the default goal selection only holds back the
*same* goal, and goals with different keys are not. Goals are the same when
they share a name and a key — or, with no key on either, equal data — so a
goal for the same lead added some other way is only recognised as the same,
and made to wait, if it carries the same `key`.

## Events

Listen for `desire:triggered` — it carries the desire and the goal it motivated
together, so a monitor sees *why* the work exists:

```typescript
agent.on("desire:triggered", ({ desire, goal }) => {
  log.info(`desire ${desire.name} -> goal ${goal.name} (${goal.id})`);
});
```

- `desire:triggered` — `{ desire, goal }`
- `desire:error` — `{ desire, reason }`
- `desire:retracted` — `{ desire, goal, withdrawn, reason? }`

The full catalogue is in [EVENTS.md](EVENTS.md). The `Trigger` rule itself is
described in [ARCHITECTURE.md](ARCHITECTURE.md#the-stores).
