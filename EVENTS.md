# Events

Everything an agent does is observable without polling it. The stores emit
their own events, and `Agent` re-emits the reasoning cycle as a typed event
stream, so a monitor can follow an agent live instead of diffing
`intentions.getAll()` between ticks or wrapping the bus.

[GETTING-STARTED.md](GETTING-STARTED.md#step-6-watching-it-happen-events) has
the short introduction; this is the complete catalogue.

## Store events

| Store | Event | Payload |
|-------|-------|---------|
| `agent.beliefs` (`BeliefBase`) | `beliefAdded`, `beliefUpdated`, `beliefRemoved` | `{ key, value?, previousValue?, status?, previousStatus? }` — a stance change is reported even though the value did not move |
| `agent.goals` (`GoalQueue`) | `goalAdded` | `Goal` — the stored goal, at the status it was added with |
| `agent.goals` (`GoalQueue`) | `goalStatusChanged` | `Goal` — as it now stands, so the previous status is not in the payload |
| `agent.goals` (`GoalQueue`) | `goalRejected` | `Goal` — refused for room, at the status it was admitted with, before the `goalStatusChanged` that fails it |
| `agent.goals` (`GoalQueue`) | `goalRemoved` | `Goal` — a finished goal left the queue |
| `agent.intentions` (`IntentionStack`) | `intentionRemoved` | `Intention` — a finished intention left the stack |

## Agent events

`agent.on(event, handler)` covers the rest. Every handler is typed for its event,
and `on` returns an unsubscribe function:

| Event | Payload |
|-------|---------|
| `goal:added` | `Goal` |
| `desire:triggered` | `{ desire, goal }` — a desire asked for a goal and got one the agent chose for itself; emitted right after the goal was added, so the goal is reported on `goal:added` too and this event says *why* it exists |
| `desire:error` | `{ desire, reason }` — a desire could not be acted on: its `intend` threw, or it asked for a goal no plan serves; reported once per problem |
| `desire:retracted` | `{ desire, goal, withdrawn, reason? }` — a desire with `onRetract: "withdraw"` stopped asking and its goal in flight was withdrawn, or could not be |
| `goal:status` | `{ goal, from, to }` — the status it left and the one it took |
| `goal:rejected` | `{ goal, reason }` — refused for room; the goal is failed and never worked on |
| `goal:refused` | `GoalRefusal` — this agent declined a directive or a goal: no plan, no room, unsupported, or its middleware said no |
| `goal:cancelled` | `{ agentId, goal, by, cleanupFailures }` — a request withdrawn at its requester's `cancel`, or a self-delegated sub-goal withdrawn because nobody waits for it any more |
| `goal:continued` | `{ goal, from, intention }` — a plan's last action handed its goal on with `continueWith`; the goal is `pending` again under its new name, `from` holds its previous name and data. Emitted before that intention's `intention:completed` |
| `goal:replanned` | `{ goal, failed, reason, details?, intention }` — a plan failed and the next applicable plan took the goal over; the goal stays `active`. Emitted between the failed plan's `intention:failed` and the next plan's `intention:started` |
| `goal:failed` | `{ goal, reason, details?, attempts, onGoalFailureError? }` — the goal reached `failed`: its last applicable plan failed, no plan was applicable, or it was declined or rejected for room. Once per goal, after its `goal:status`; `reason` and `details` as `onGoalFailure` left them; `details` is what the requester's `failure` carries. A cancelled goal, or one dropped for a failed dependency, is `dropped` instead |
| `goal:removed` | `Goal` — collected after it finished, at the end of that cycle |
| `intention:started` | `Intention` |
| `intention:advanced` | `{ intention, action, result }` — the action that just ran, and what it returned |
| `intention:delegated` | `{ intention, delegations }` — the delegations an action just made |
| `intention:waiting` | `{ intention, children, delegations }` — the sub-goal ids and the delegations it is waiting for |
| `delegation:progress` | `{ intention, delegation }` — a remote delegate sent a progress note, now on `delegation.progress` |
| `delegation:settled` | `{ intention, delegation }` — a delegation was done, failed or cancelled |
| `intention:completed` | `Intention` — its goal is `achieved`, unless the plan handed it on (`goal:continued`) |
| `intention:failed` | `{ intention, reason, details?, onPlanFailureError? }` — its plan failed; the goal failed too unless `goal:replanned` follows. `onPlanFailureError` is set when the plan's `onPlanFailure` hook threw |
| `intention:removed` | `Intention` — collected after it finished, at the end of that cycle |
| `cycle:failed` | `{ agentId, error }` — a cycle of the `start(tickIntervalMs)` loop rejected; the next cycle still runs |
| `message:received` | `Message` — point-to-point or on a subscribed topic, before it is processed |
| `message:sent` | `Message` — handed to the bus: from an action, a delegation, or the agent's own answers (`agree`, `refuse`, the terminal `inform`/`failure`, a `cancel`) |
| `message:rejected` | `{ agentId, reason, message }` — a delivered message dropped unread: its envelope failed validation, or it named a `language` or `ontology` outside `supportedLanguages` / `supportedOntologies`; answered `not-understood` when it named a sender |
| `belief:accepted` | `{ agentId, keys, status, message }` — an assertion the agent believed, the belief keys it was stored under, and the stance it was held with (`"negative"` for a `disconfirm`) |
| `belief:rejected` | `{ agentId, reason, message }` — an assertion the agent was told about and did not believe; `reason` is `middleware` or `middleware threw: …` |
| `goalAcknowledged` | `GoalAck` — an `agree` answering a request this agent sent |
| `goalRefused` | `GoalRefusal` — a `refuse` answering a request this agent sent |
| `reply:timeout` | `ReplyTimeout` — a directive this agent sent got no reply by its `reply-by` |
| `directive:expired` | `Message` — a directive arrived after its `reply-by` and was dropped unanswered |
| `call:opened` | `{ intention, call }` — this agent sent a `cfp`, from `calls` or as a plain message |
| `call:proposal` | `{ intention, call, proposal }` — a bid arrived on one of this agent's calls |
| `call:closed` | `{ intention, call }` — a call stopped taking bids: every invitee answered, a bid was about to expire, or its deadline passed |
| `proposal:sent` | `{ peer, goal, proposalId, terms }` — this agent bid on a `cfp` |
| `proposal:accepted` | `{ peer, goal, proposalId }` — a bid of this agent's was accepted, and the job admitted |
| `proposal:rejected` | `{ peer, goal, proposalId, reason?, details? }` — a bid of this agent's was rejected |
| `proposal:expired` | `{ peer, goal, proposalId }` — a bid of this agent's passed its `reply-by` unanswered |

## A monitor built on nothing but events

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

## Things to know about the payloads

- **Goals and intentions are live objects.** `goal`/`intention` are the very objects the queue and stack hold, mutated in place as work progresses (`setStatus`, `advance`, …), so a handler that keeps one sees later changes. Snapshot it — `{ ...goal }` — to hold the state you saw; every other field is plain data and safe to serialise.
- **Handlers run synchronously**, on the cycle that raised the event, so they must not block; hand slow work to a queue. A handler that throws fails that cycle: a manual `tick()` rejects with its error, and the `start(tickIntervalMs)` loop reports it on `cycle:failed` and carries on with the next cycle.
- **Finished items leave the stores.** A goal or intention is collected once it is terminal, at the end of the cycle that finished it, so `goal:removed` / `intention:removed` are the last event in a job's sequence. Within a cycle everything is still readable; across cycles, snapshot the stream rather than polling `all()`.

Goal events are delivered whether or not the agent is running, and survive `stop()`/`start()`. All of them cover only this agent's own work. A bus-wide view — or a view across processes — is the user's to build: map the events onto whatever channel you own (`agent.on("intention:failed", e => channel.publish(e))`), which is plumbing classic-agents deliberately does not dictate.

## Where each event is described

- Failure hooks and the goal lifecycle: [ARCHITECTURE.md](ARCHITECTURE.md).
- Wire traffic, acks and tracked exchanges: [MESSAGING.md](MESSAGING.md).
- Stance changes and `belief:rejected`: [BELIEFS.md](BELIEFS.md) and
  [MIDDLEWARE.md](MIDDLEWARE.md).
- Desires: [DESIRES.md](DESIRES.md).
- Delegations and calls: [DELEGATION.md](DELEGATION.md) and
  [CONTRACT-NET.md](CONTRACT-NET.md).
