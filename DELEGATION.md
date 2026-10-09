# Delegating Sub-goals

A plan can hand work off and wait for it, whether this agent does the work or
another one. This is **delegation**: a sub-goal that may cross the agent's own
boundary. The parent intention waits, and the outcome of the work — done or
failed — drives it the same way wherever the work ran.

Work a plan does *not* want to wait for is **spawned** instead.

| `ActionResult` field | What it creates | Waited for | Tied to the parent |
| --- | --- | --- | --- |
| `delegations` (no `receiver`) | a sub-goal of this agent | yes | yes: lineage, `source`, withdrawn when nobody waits any more |
| `delegations` (a `receiver`) | a `request` to that agent | yes | yes: the delegate is sent a `cancel` when nobody waits any more |
| `spawn` | a new root goal of this agent | no | no |

`spawn` replaced `newGoals`. `newGoals` used to create sub-goals that were waited
for, except when the action creating them was the plan's last, which made them
independent. Each of those meanings now has its own field.

```ts
{
  name: "ship",
  body: [
    {
      name: "split",
      execute: async () => ({
        delegations: [
          // A sub-goal this agent serves.
          { goal: "package", priority: 10 },
          // Goals other agents must serve.
          { receiver: "warehouse", goal: "pick", view: { orderId: "o-1" } },
          { receiver: "courier", goal: "deliver", view: { orderId: "o-1" } },
        ],
        // Independent work nobody waits for.
        spawn: [{ name: "audit", priority: 1 }],
      }),
    },
    {
      name: "confirm",
      execute: async (intention) => {
        const pick = intention.delegations.find((d) => d.goal === "pick");
        return { beliefUpdates: [{ key: "picked", value: pick?.result }] };
      },
    },
  ],
}
```

## The delegation record

Every delegation an intention makes is kept on `intention.delegations`, in the
order made, open or settled (`src/core/intentions.ts`, `Delegation`):

- `receiver`, `goal`: who was asked, for what. A self-delegation's `receiver` is
  this agent's own id.
- `status`: `sent → agreed → done | failed | cancelled`. A self-delegation starts
  `agreed`, since its sub-goal is created on the spot.
- `exchange`: a remote delegation's request `replyWith`, which every reply names
  back.
- `goalId`: the goal the work runs under. For a remote delegation, this is the id
  from the delegate's `agree`. For a self-delegation, it is the sub-goal's id,
  which is also in `intention.children`.
- `result`: the answer the work produced, from the `ActionResult.result` of
  the plan that did it. For a remote delegation it comes from the `result`
  field of the delegate's `inform { done: true }`, and the reply's whole
  content is also kept at `done.<receiver>.<goal>.<exchange>`.
- `reason`: why it failed or was cancelled.
- `deadline`: when the work must be done by, if anything set one.

The intention is `waiting` while any delegation is open (`isAwaitingWork`). It
resumes with its next action once none is. If the delegating action was the
plan's last, the intention completes at that point instead. Work an action
hands off is part of the plan's outcome, so the goal is not achieved, and the
requester is not told `done`, until it is.

## Delegating to another agent

The delegation goes on the wire as a plain FIPA `request`. Content is
`{ ...view, goal }`, sent through `sendMessage`. The request belongs to the
delegating goal's conversation (`conversationId` inherited), opens an exchange
of its own (a fresh `replyWith`), and has no `inReplyTo`. The delegating agent
queues no goal for it and needs no plan for it.

The receiver handles it like any request. It agrees or refuses at admission,
and it always ends an agreed request with exactly one terminal reply. That
reply is an `inform { done: true }` or a `failure`, sent from the goal's own
terminal transition. So no change on the receiving side was needed; see
PERFORMATIVES.md › `request` › *The terminal reply*.

On the delegating side, every way a sent request ends goes through one place,
`endSentRequest`, which settles the delegation it carries:

| The request ended with | The delegation |
| --- | --- |
| `agree` | `agreed`, with the receiver's `goalId` (not an ending) |
| `inform { done: true }`, believed | `done`, `result` = the reply's `result` |
| `inform { done: true }`, rejected by belief middleware | `failed`: result not accepted |
| `refuse` | `failed`: `refused (<verdict>): <reason>` |
| `failure` | `failed`: the peer's reason |
| `not-understood` | `failed`: `not understood: <reason>` |
| no reply by `reply-by` | `failed`: `no reply by <time>` |
| no outcome by the work deadline | `failed`: `not done by <time>`, and the receiver is sent `cancel` |
| an `inform` without `done` | nothing: a note, filed at `result.*` |

The belief middleware decides what this agent believes, not whether the
exchange is over. A terminal reply it rejects still closes the request, because
the peer will say nothing more about it. The delegation fails, because this agent
cannot go on as if work it does not believe in had been done.

### Deadlines

`reply-by` (`replyTimeoutMs`, default 30 s) bounds only the first reply. A
delegate that agrees and never finishes would hold the parent, and its
`maxConcurrentIntentions` slot, forever. So a remote delegation also has a
deadline on the work. It is the delegation's own `timeoutMs`, or the agent's
`delegationTimeoutMs` (default five minutes, `DEFAULT_DELEGATION_TIMEOUT_MS`).
`null` or `0` means no deadline. `expireDelegations` checks it every cycle.

### Cancelling

When the delegating agent stops waiting for an open remote delegation, it sends
the delegate a `cancel` naming the request, and the delegation is marked
`cancelled`. That happens when:

- the delegation's deadline passes;
- the waiting intention fails, for example because a sibling delegation failed
  and the plan's `onChildFailure` is `"fail"`;
- the request the delegating goal serves is itself cancelled. A cancel
  therefore travels down a chain of delegations.

The `cancel`'s reply is filed like that of any cancel this agent sends.
Whether the work stops is up to the delegate: its plan may not be
`cancellable`.

## Delegating to this agent

A delegation with no `receiver`, or this agent's own id, is a sub-goal:

- it records `parentGoalId` and `rootGoalId`;
- it inherits the delegating goal's `source`;
- `view` becomes its `data`, and `priority` defaults to 5.

It never goes on the wire. It is cancelled along with the request its root
serves, and it answers no one itself: only the root goal's terminal reply does.

Its outcome settles the delegation:

- **Done:** it was achieved and collected.
- **Failed:** it failed, or one of the following happened:
  - no plan serves it;
  - the queue had no room for it;
  - it was dropped because a dependency failed;
  - it was removed before it finished.

A self-delegation has a deadline only when its own `timeoutMs` sets one.
Otherwise it is stopped exactly like a remote one. When the deadline passes, or
the waiting intention fails, the agent withdraws the sub-goal, applying the
same rules it would apply to a `cancel` it received for it:

- **Not started:** the sub-goal and everything under it are dropped.
- **Started:** it is withdrawn only if every plan working it is
  `cancellable`. It stops at the next action boundary, never mid-action, and
  each plan's `onCancel` clean-up runs.
- **Not cancellable:** it runs to the end and settles nothing, as a delegate
  that answered the `cancel` with `failure` would.

A withdrawn sub-goal is reported on `goal:cancelled` with `by` set to this
agent's own id.

## Failure handling

A failed delegation is a failed child, and `settleDelegation` handles local and
remote ones the same way. The plan's `onChildFailure` decides:

- `"fail"` (default): the parent fails, which cascades to its own waiting
  parents and stops its other open delegations, remote and local. The reason names the
  work:

  ```
  sub-goal "package" failed: out of boxes
  delegation of "pick" to warehouse failed: refused (no-plan): no plan serves "pick"
  ```

- `"continue"`: the failure lands in `intention.childFailures`, and the parent
  resumes once nothing is open. A remote failure carries `receiver` and
  `exchange` (`ChildFailure`).

## Events

- `intention:delegated`: `{ intention, delegations }`, the delegations an
  action just made. Emitted before `intention:waiting`.
- `intention:waiting`: `{ intention, children, delegations }`, the open
  sub-goal ids and delegations.
- `delegation:settled`: `{ intention, delegation }`, a delegation that was
  done, failed or cancelled.

## Not covered

- **Conditional requests.** Only a plain `request` is delegated. A
  `request-when` or `request-whenever` can still be sent through
  `ActionResult.messages`, but it is not waited for.
