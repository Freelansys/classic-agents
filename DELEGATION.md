# Delegating Sub-goals to Other Agents

A plan body today can split a goal into **local** sub-goals (`ActionResult.newGoals`).
This file tracks the work to let a plan also hand work to **other** agents — send
a request, wait for the outcome, and let success or failure of the remote job
drive the parent intention exactly as a local sub-goal does.

## Goal

`newGoals` spawns children that the agent itself serves. A delegation is the
same thing with a different server: the action asks `Agent` to send a `request`
to a named receiver, the intention enters `waiting`, and the receiver's eventual
answer — `inform` for completion, `refuse`/`failure` for not happening — resolves
the waiting intention the way a local child's completion/failure does today.

The shape we want on the plan author's side:

```ts
{
  name: "ship",
  trigger: () => true,
  body: [
    {
      name: "split",
      execute: async () => ({
        // unshipped: a local goal this agent serves.
        newGoals: [{ name: "package", priority: 10 }],
        // staged: a goal another agent must serve.
        delegations: [
          { receiver: "warehouse", goal: "pick", view: { orderId: "o-1" } },
          { receiver: "courier", goal: "deliver", view: { orderId: "o-1" } },
        ],
      }),
    },
  ],
}
```

## Current state: the plan action sequence

One goal maps to one `Intention`, driven by `plan.body` of `Action`s
(`src/core/plans.ts:25` — `execute(intention, beliefs) -> ActionResult`).

### The cycle that advances an intention

Per `tick()` (`src/core/reasoning.ts:697`):

1. `reviseBeliefs(perceive())` — percepts become beliefs/goals by performative
   (`reasoning.ts:1093`). Directives go to `considerDirective` → middleware →
   `admitDirective` → `goalFromMessage` (creates the goal, records `GoalSource`,
   queues the `agree` via `pendingAcks`), or are declined (`refuse`). `agree`,
   `refuse`, `failure`, `not-understood` have their own handlers (below).
2. `flushDirectiveAnswers()` — the queued `agree`/`refuse` go out
   (`reasoning.ts:1863`).
3. `deliberate()` → `goals.selectNext()` activates one goal (`reasoning.ts:1935`).
4. `meansEndsReasoning()` — for each active goal with no intention yet, select a
   plan (`planLibrary.match`) and push an intention in `executing`
   (`reasoning.ts:1942`). Bounded by `maxConcurrentIntentions`.
5. `execute()` — runs every runnable intention's current action
   (`reasoning.ts:2059` → `executeIntention:2075`).
6. `reportRejections()` — shed-goal refusals go out (`reasoning.ts:896`).
7. `collectFinished()` — terminal goals/intentions are collected
   (`reasoning.ts:1922`), which in turn releases waiting parents.

### What one action run does

`executeIntention` (`reasoning.ts:2075`):

- Runs `plan.body[actionIndex].execute(intention, beliefs)` → `ActionResult`.
- Applies the result — including **before** handling the reported failure, so
  partial progress is kept (`reasoning.ts:2086-2089`).
- If the action reported `failure` → `failIntention` (intention + goal `failed`,
  `intention:failed`, `dropDependentGoals`, `failWaitingParents`).
- Otherwise advances `actionIndex`; if the body is exhausted → `completeIntention`;
  if the action spawned children → status `waiting` (+ `intention:waiting`).

### What a plan can produce today — `ActionResult` (`plans.ts:6`)

| Field | Effect | Local/remote |
| --- | --- | --- |
| `beliefUpdates` / `beliefRemovals` | write the belief base | local |
| `newGoals` | spawn sub-goals, appended to `intention.children` | **local only** |
| `messages` | send point-to-point or topic messages (any performative) | remote, but fire-and-forget |
| `failure` | fail this intention | local |

`applyActionResult` (`reasoning.ts:2205`):

- `newGoals` → `goals.add` with `parentGoalId = intention.goal.id`,
  `rootGoalId` and `source` **inherited** from the parent goal
  (`reasoning.ts:2227-2238`); the parent gets the child ids in
  `intention.children` and goes `waiting` (`reasoning.ts:2109-2116`).
- `messages` → point-to-point via `sendMessage`, topic via `publishMessage`,
  both **inheriting `goal.source`'s `conversationId`/`inReplyTo`**
  (`reasoning.ts:2246-2284`). No linkage back to the intention — the reply, if
  any, is just another inbox message.

### How a waiting intention is released

Local sub-goals, two triggers:

- **Success**: the child goal achieves and is collected → `releaseWaitingParents`
  (`reasoning.ts:2305`) removes the child id from `intention.children`; when
  the list is empty the intention returns to `executing`.
- **Failure**: `failWaitingParents` (`reasoning.ts:2160`) — the parent fails
  with `sub-goal "<child>" failed: <reason>`, or, for plans with
  `onChildFailure: "continue"`, resumes with the failure recorded in
  `intention.childFailures`.

Both lookups are keyed by **local goal id** (`intention.children: string[]`,
`IntentionStack.byGoal`).

## The infrastructure already in place (why this is now feasible)

Everything needed to carry a request to another agent and correlate the answer
exists. The gap is plumbing the correlation into the intention's lifecycle.

**Wire correlation** (`src/bus` + `sendMessage`/`publishMessage`, `reasoning.ts:1003-1044`):
`sendMessage` and `publishMessage` stamp `conversationId` + `replyWith` when
absent; replies echo `inReplyTo = replyWith`. `GoalSource` records
`{ sender, conversationId?, inReplyTo? }` on every request-born goal
(`reasoning.ts:1793`) and is inherited down the decomposition.

**Sender-side bookkeeping** on `sendMessage` of a `request` (`reasoning.ts:1013-1019`):
`markRequestIntention` writes `intent.<peer>.<goal>.<exchange>` as `uncertain`
(`reasoning.ts:767`), so a delegation already *may* be tracked without the plan
doing anything — if the engine sends the request through `sendMessage`.

**Reply handlers** on the delegating agent:

- `agree` → `handleAgreement` `reasoning.ts:1570`: `goalAcknowledged` event
  (+ GoalAck with `conversationId`/`inReplyTo`), promotes the exchange's
  `intent` belief to `positive`.
- `refuse` → `handleRefusalMessage` `reasoning.ts:1637`: `goalRefused` event,
  sets `intent.<peer>.<goal>.<exchange>` to `negative` plus an
  `infeasible.<peer>.<goal>.<exchange>` belief.
- `failure` → `handleFailureMessage` `reasoning.ts:1706`: normal assertion path +
  semantic `failed.<sender>.<goal>` belief.
- `not-understood` → `handleNotUnderstoodMessage` `reasoning.ts:1734`.

**Receiver side** is a solved problem: a plain `request` is admitted as a goal
(agree/refuse/no-plan/capacity), and its plan answers with `inform`/`failure`
through `ActionResult.messages` — already correlated to the exchange via
`applyActionResult`'s inheritance. That is exactly the delegation target's
behaviour, no change needed there.

The belief keys (`exchangeKey`, `reasoning.ts:739`) are per-exchange:
`intent.<peer>.<goal>.<exchange>`, so each delegation already has a unique,
queryable record — `statusOf` on the key tells a plan / monitor whether the
receiver agreed, refused, or is undecided.

## What needs to be done

One primary change plus decisions. The core: **a remote child entry on the
intention, fed by the existing reply handlers.**

### 1. `ActionResult.delegations`

Add a field parallel to `newGoals`:

```ts
delegations?: Array<{
  receiver: string;
  goal: string;
  view?: unknown; // forwarded verbatim into the request body
}>;
```

`applyActionResult` handles it like `newGoals`, but remote:

- For each entry, send to `receiver` a `request` with content
  `{ goal, ...view }` via `sendMessage` (so `markRequestIntention` runs and the
  exchange is stamped automatically).
- Record a remote child on the intention in place of a local goal id — e.g.
  extend `Intention.children` from `string[]` (local ids) to a discriminated
  union of `{ kind: "local"; goalId } | { kind: "remote"; receiver; goal;
  exchange }`, or add a sibling array `delegations`. The rest of the code reads
  only "are any children/delegations outstanding", so a union is less invasive
  than it sounds.
- Set the intention `waiting` exactly as `newGoals` does.

### 2. Release the waiting intention from the remote replies

- **Refusal** (`handleRefusalMessage`): the refusal names `goal`, `inReplyTo`
  (the delegation's `replyWith`, so the exchange matches). For a waiting
  intention with a matching remote child, behave like a failed sub-goal:
  `refuse` → child failed (`onChildFailure` default `"fail"` fails the parent
  with the refusal reason; `"continue"` records it in `childFailures` and
  resumes). This is the same decision point `failWaitingParents` already owns
  for local children (`reasoning.ts:2160`).
- **Completion**: the delegated request's plan answers with `inform`.
  Following the library's existing rule that terminal replies are plan-authored,
  the delegating engine treats an `inform` that names the delegation's exchange
  (`inReplyTo` = the request's `replyWith`) as completion and removes the remote
  child — mirroring `releaseWaitingParents` (`reasoning.ts:2305`). The theme
  is optional: correlate on `inReplyTo ?? conversationId`, degrade to
  `intent.<peer>.<goal>` like the beliefs do.
- **Failure**: similarly map the receiver's `failure` onto the remote child as a
  child failure (parent fails or continues).

This is the real delta: today `handleAgreement`/`handleRefusalMessage` only write
beliefs and fire events; nothing walks the intention stack. They become the
release path too.

### 3. Open decisions to settle while implementing

- **Conversation identity.** Does a delegation inherit `goal.source`'s
  `conversationId` (whole decomposition stays one thread, as beliefs/events do
  today) or mint a child conversation per delegation? The exchange (`replyWith`)
  must be fresh per delegation either way so the replies pair. Recommend:
  inherit `conversationId`, fresh `replyWith`/`inReplyTo` to keep each remote
  leg distinguishable.
- **Proxy goal or not.** Recommended: no local goal is spawned for the remote
  work (no queue slot, no plan needed to match it); the *waiting intention*
  still holds its `maxConcurrentIntentions` slot while the child runs, exactly
  as local children do today. The alternative — a local proxy goal — would
  route through plan selection and reuse `failWaitingParents`/`releaseWaitingParents`
  as-is, at the cost of a goal that exists only to wait.
- **Timing out.** Nothing enforces a deadline today (on either side). A delegation
  whose receiver agrees and never answers would hold the parent forever, the same
  leak `failWaitingParents` exists to prevent locally. A timeout/deadline field on
  the delegation is a candidate, but it is new engine behaviour, not correlation —
  note it explicitly.
- **`ChildFailure` shape** (`intentions.ts:27`): extend with `receiver`/`goal`
  so a `"continue"` plan can distinguish which peer failed.
- **Events.** `intention:waiting` today emits `{ intention, children }`
  (`reasoning.ts:2111`); remote children should be visible there (and possibly a
  new `intention:delegated` event).

### 4. Receiver-side expectations (no change, but a contract)

The receiver already handles the request; its plan must answer with `inform`
(completion) or `failure` (agreed-but-could-not) via `ActionResult.messages`.
That answer is correlated by the existing `applyActionResult` inheritance. The
delegator's release logic in §2 is what makes it land.

### 5. Tests

- A plan delegates, the target agrees and informs → parent resumes, next action
  runs, `conversationId`/`inReplyTo` round-trip on the wire.
- Refusal (`no-plan`/`capacity`) → parent fails with the reason; `onChildFailure:
  "continue"` resumes and records the refusal in `childFailures`.
- Failure after agree → parent fails; cascade to the parent's own parent still
  works.
- Two delegations to two agents: both must resolve before the parent resumes.
- A delegation does not consume a queue slot on the delegator, and a waiting
  delegation holds its `maxConcurrentIntentions` slot.

## Files touched (when implemented)

- `src/core/plans.ts` — `ActionResult.delegations` type (+ docs matching the
  `newGoals`/`messages` documentation style).
- `src/core/intentions.ts` — `Intention.children` union or a `delegations`
  array; `ChildFailure` shape.
- `src/core/reasoning.ts` — `applyActionResult` (send + wait),
  `handleAgreement`/`handleRefusalMessage`/`handleFailureMessage` (release
  path), `failWaitingParents`/`releaseWaitingParents` (handle remote children),
  `intention:waiting` payload.
- `tests/*` — the scope in §5.
- `README.md`, `PERFORMATIVES.md` — the plan section and the `request`/`failure`
  sections documenting that delegations follow the same completion protocol as
  local sub-goals.