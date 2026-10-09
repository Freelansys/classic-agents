# Contract Net: `cfp`, `propose`, `accept-proposal`, `reject-proposal`

The plan for the last four performatives of the FIPA Contract Net Interaction
Protocol (SC00029). An agent can call for proposals on a job, collect bids,
award it to one or more bidders and wait for the outcome. Another agent can bid
on such a call and, once its bid is accepted, do the job.

[DELEGATION.md](DELEGATION.md) draws the line this file picks up. A race
(`waitFor: "any"`) suits interchangeable, idempotent work, where every delegate
does the whole job. Choosing among providers by what they *offer*, where only
the chosen one should act, is Contract Net's job.

Nothing in this file is implemented yet. The decisions in
[Decisions to agree](#decisions-to-agree) still need agreeing, one act at a
time, in PERFORMATIVES.md, as the other acts were.

## The protocol

```
initiator                                participant
    │ cfp { goal, ...view }                    │   reply-by = bidding deadline
    │ ───────────────────────────────────────▶ │
    │      refuse { goal, verdict, reason }    │   (or not-understood)
    │ ◀─────────────────────────────────────── │
    │      propose { goal, terms }             │   reply-by = how long the bid is valid
    │ ◀─────────────────────────────────────── │
    │ reject-proposal { goal }                 │   to every bid not chosen
    │ ───────────────────────────────────────▶ │
    │ accept-proposal { goal, terms }          │   to the chosen bid(s)
    │ ───────────────────────────────────────▶ │
    │      inform { goal, goalId, done, result }   (or failure)
    │ ◀─────────────────────────────────────── │
```

The participant sends no `agree` after `accept-proposal`. Proposing was the
commitment (`propose` is commissive), and the protocol goes straight to the
final `inform` or `failure`.

## Reassessment: what the framework already provides

The first assessment found one blocking gap. A plan had no way to wait for
something another agent does, so an initiator could send a `cfp` but had no
way to act on the bids. Delegation has since closed that gap, and it covers
much more of the protocol than the waiting alone:

| Contract Net needs | Already in place |
| --- | --- |
| A plan that hands work off and waits for it | `ActionResult.delegations`, `Delegation`, `isAwaitingWork`, `resumeIntention` |
| Waiting for the winner's `inform`/`failure` | `endSentRequest` → `settleDelegation`, fed by `settleRequestInform`, `handleFailureMessage`, `handleRefusalMessage` and `handleNotUnderstoodMessage` |
| Returning the job's answer | `ActionResult.result` → `inform { done: true, result }` → `Delegation.result` |
| Progress notes from the winner | `Delegation.progress`, `delegation:progress` |
| A deadline on the awarded work | `Delegation.deadline`, `delegationTimeoutMs`, `expireDelegations` |
| Several awards, or a fallback | `waitFor` and per-delegation `onFailure` |
| Stopping the winner when nobody waits any more | `abandonDelegations` → `cancelDelegation`, which the participant handles with `handleCancel` → `cancelRequest` → `withdraw` (`cancellable`, `onCancel`) |
| The participant's final reply after acceptance | `openRequests` and `queueOutcome`/`flushTerminalAnswers` |
| Checks before a bid: middleware, plan, capacity | `considerDirective`, `planLibrary.declares`, the goal queue's bound |
| Computing a bid without blocking the cycle | `startEvaluation` with `evaluationTimeoutMs` and `maxConcurrentEvaluations` |
| A bidding deadline | `reply-by`, which `sendMessage` already stamps on a `cfp` because it is a directive. A `cfp` received after its deadline is already dropped as `directive:expired` |
| Correlation | `conversationId` / `replyWith` / `inReplyTo` stamping, and `GoalSource` |

**The key reuse: an award is a delegation.** Once the initiator sends
`accept-proposal`, everything that follows is a request in all but name. The
participant owes one final reply, the initiator waits for it with a deadline,
and either side may cancel. So the plan is to record each award as a
`Delegation` with:

- `receiver`: the bidder;
- `exchange`: the `accept-proposal`'s `replyWith`;
- `status: "agreed"`, because the bid was the commitment.

The participant admits the accepted job as a goal whose `source.inReplyTo` is
that same `replyWith`. Every existing path then lines up with no change:

- the final `inform`/`failure` names the accept;
- `cancelDelegation` names the accept;
- `handleCancel` finds the goal in `openRequests` by that id.

**What is genuinely new** is the bidding round:

- **Participant:** a way to compute a bid, a table of bids made and not yet
  answered, and admission of an accepted bid without an `agree`.
- **Initiator:** a call record the intention waits on until bidding closes,
  and the award step that turns chosen bids into delegations and rejects the
  rest.

### Feasibility

Both sides are now feasible with no new mechanism beyond the call itself:

- The **participant** side is about as large as the standing directives were.
- The **initiator** side needs one new kind of thing an intention can wait on,
  the open call. The award step reuses delegation almost wholesale.

The remaining risks are organisational, not technical; see [Risks](#risks).

## Participant side

### Receiving a `cfp`

Content: `{ goal, ...view }`, the same shape as a `request`, so a schema shared
with `requestContentSchema` fits.

1. **Middleware.** It runs `directiveMiddleware` through `considerDirective`,
   like every other honoured directive. A veto is answered
   `refuse { verdict: "middleware" }`.
2. **Schema.** Malformed content after the middleware is answered
   `not-understood`.
3. **Plan.** No plan serves `goal`: `refuse { verdict: "no-plan" }`.
4. **Opt-in.** The plan has no `bid`: `refuse { verdict: "unsupported" }`. This
   keeps today's behaviour for every agent that has not opted in.
5. **Room.** The goal queue is full, or `canEvaluate()` is false:
   `refuse { verdict: "capacity" }`. This is transient, as it is everywhere
   else.
6. **Bid.** Evaluate the plan's `bid`, which names an expression in the
   agent's `expressionLibrary`, with `startEvaluation` and the `cfp` as its
   message. The outcome decides the reply:
   - a value (not `null`/`undefined`): `propose { goal, terms: <value> }`;
   - `null` or `undefined`: `refuse { verdict: "declined" }` (see D2);
   - an error or timeout: `refuse { verdict: "declined", reason: "bid failed: …" }`.
     SC00029 allows only `propose`, `refuse` or `not-understood` here, so
     `failure` is not an option.

The `propose` inherits the `cfp`'s conversation and names it with `inReplyTo`.
It goes to `replyAddress(cfp)`. Its own `reply-by` is how long the bid is valid
(`proposalTimeoutMs`, see D4). Its `replyWith` keys the new **pending
proposal**.

### `Plan.bid`

```ts
{
  name: "ship",
  bid: "quote-ship",   // an Expression in the agent's expressionLibrary
  cancellable: true,
  body: [ /* does the job, on the terms in goal.data.terms */ ],
}

expressionLibrary.register({
  name: "quote-ship",
  evaluate: (beliefs, cfp) => {
    const rate = beliefs.get("rate.per-kg") as number | undefined;
    const kg = (cfp.content as { kg?: number }).kg;
    return rate && kg ? { price: rate * kg, days: 2 } : null; // null = no bid
  },
});
```

The bid is a named expression, not a callback on the plan. This keeps the
library's existing rule: the wire carries names, and the receiver owns what is
behind them. It also gets evaluation limits and non-blocking evaluation for
free. An `Expression` must be a quick read, which suits a bid computed from
pricing beliefs. A bid that takes real work, such as calling a quoting
service, is out of scope (see [Not covered](#not-covered)).

### Pending proposals

`pendingProposals: Map<proposeReplyWith, PendingProposal>`, where a
`PendingProposal` holds `{ cfp, peer, plan, terms, expiresAt }`. An entry
leaves the map when:

- **`accept-proposal` arrives** naming it (`inReplyTo`), from the `cfp`'s
  sender. Only the agent that called may accept, which is the same identity
  rule as `cancel`. The job is admitted as a goal:
  - `data` is `{ ...cfp.content, terms }`, so the plan works on the agreed
    terms;
  - `source` is the accept's sender, `replyTo`, `conversationId`, and
    `inReplyTo` = the accept's `replyWith`.

  The job opens an `openRequests` entry without queuing an `agree`. From here
  it is an ordinary agreed request: one final `inform`/`failure`, and
  cancellable on its plan's terms. If the queue is full now, the reply is
  `failure { reason: "no capacity" }`; see D3.
- **`reject-proposal` arrives** naming it. It is dropped and
  `proposal:rejected` is emitted. No reply is sent.
- **Its `reply-by` passes.** It is dropped and `proposal:expired` is emitted.
  An accept that arrives later gets `failure { reason: "proposal expired" }`.
- **`cancel` arrives** naming the `cfp`. The bid is withdrawn and answered
  `inform { cancelled: "cfp", goal }`. A `cfp` whose bid is still being
  evaluated is handled the same way: the evaluation's outcome is discarded.

An `accept-proposal` that names nothing pending is answered
`failure { reason: "no such proposal" }`. A `reject-proposal` that names
nothing is ignored.

## Initiator side

### Calling: `ActionResult.calls`

```ts
{
  name: "ship-order",
  body: [
    {
      name: "call",
      execute: async () => ({
        calls: [{
          goal: "ship",
          receivers: ["fedex", "ups", "dhl"],  // or: topic: "carriers"
          view: { orderId: "o-1", kg: 12 },
          deadlineMs: 5_000,                   // the cfp's reply-by
        }],
      }),
    },
    {
      name: "award",
      execute: async (intention) => {
        const call = intention.calls.at(-1)!;
        const best = cheapest(call.proposals);
        if (!best) return { failure: { reason: "no carrier bid" } };
        // Every bid not awarded here is rejected automatically.
        return { awards: [{ proposal: best.id }] };
      },
    },
    {
      name: "record",
      execute: async (intention) => ({
        result: intention.delegations.at(-1)?.result,  // the winner's answer
      }),
    },
  ],
}
```

A call sends one `cfp` per receiver. A message has a single receiver (issue
12), so each `cfp` is its own exchange within the goal's conversation. For a
`topic`, one `cfp` is published. The call is recorded on the new field
`intention.calls`:

```ts
interface Call {
  id: string;
  goal: string;
  status: "open" | "closed" | "cancelled";
  invited?: string[];           // absent for a topic call
  exchanges: string[];          // the cfps' replyWith
  deadline: number;             // epoch ms
  proposals: Proposal[];        // { id: proposeReplyWith, sender, terms, expiresAt?, status }
  refusals: Array<{ sender: string; verdict?: RefusalVerdict; reason?: string }>;
}
```

The intention is `waiting` while any call is open. `isAwaitingWork` grows a
third clause for open calls. A call **closes** when one of these happens:

- every invited agent has answered (`propose`, `refuse` or `not-understood`);
- the deadline passes. This is the only way a topic call closes.

Closing emits `call:closed`. If nothing else is open, the intention resumes
with its next action, which reads `call.proposals`.

A `propose` that arrives after its call closed, or that names no open call, is
answered `reject-proposal { reason: "call closed" }`. The bidder gets an answer
rather than holding a bid open.

### Awarding: `ActionResult.awards`

```ts
awards?: Array<{
  proposal: string;              // Proposal.id from one of this intention's closed calls
  onFailure?: ChildFailurePolicy;
  timeoutMs?: number | null;     // the work deadline, as for a delegation
}>;
```

Each award sends `accept-proposal { goal, terms }` to the bidder. The message
names the bid with `inReplyTo` and stays in the call's conversation. Each award
is recorded as a `Delegation` with `status: "agreed"` and `exchange` set to the
accept's `replyWith`. It is registered in `sentRequests` and
`remoteDelegations`, exactly as `delegate()` does for a `request`. From there,
`waitFor`, `onFailure`, deadlines, results, progress and cancellation behave as
they do for any delegation. Awards and delegations from the same action form
one batch.

**Every bid the action does not award is rejected** with `reject-proposal`
once the action has run, whatever it returned, including a `failure`. An award
that names an unknown bid, or a bid from a call still open, fails the action.

Awarding several bids (`waitFor: "all"`) splits a job. Awarding several with
`waitFor: "any"` turns the award into a race, with the race's caveats.

### When the intention stops early

An intention can fail or be cancelled while a call is open, or before it has
awarded. In either case:

- the call is marked `cancelled`;
- every bid received gets `reject-proposal`;
- invited agents that have not answered get nothing, because their bid, if one
  comes, is rejected as "call closed".

This hooks into the same places `abandonDelegations` is called from.

### Calls a plan does not wait for

A `cfp` sent through `ActionResult.messages` is not waited for, just as a raw
`request` is not. It is still tracked, so its bids are correlated rather than
rejected as unsolicited: `call:proposal` is emitted, and accepting or rejecting
is left to the application. No automatic rejection applies.

### Beliefs

Bids are kept on the call record, not in the belief base. A bid is a
conditional commitment about the conversation, not a fact about the world. The
reaction table already says commissives are neither believed nor acted on, and
the plan that reads them has the record. The existing handlers still write
what they write today: `infeasible.*` for a refusal, and `done.*`/`failed.*`
for the awarded work.

## Decisions to agree

Record each one in PERFORMATIVES.md before implementing it. Each has a
recommendation.

- **D1. How a bid is computed.** *Recommend:* `Plan.bid` names an expression
  in `expressionLibrary`, with no bid meaning `refuse unsupported`.
  *Alternative:* a callback on the plan. That is more flexible, but it breaks
  the evaluation limits and the names-not-code rule.
- **D2. The verdict when an agent decides not to bid.** The four verdicts
  don't fit: the agent has the plan and the room, and simply won't offer.
  *Recommend:* add `"declined"` to `RefusalVerdict` as a settled verdict, "not
  on these terms". *Alternative:* reuse `"unsupported"`. That is wrong,
  because it says "never ask", which a later call with other terms disproves.
- **D3. Holding capacity while a bid is pending.** *Recommend:* don't. Check
  room again on accept, and answer `failure` if there is none. SC00029 allows
  `failure` after acceptance. Document the over-commit beside the `capacity`
  note. *Alternative:* reserve a queue slot per pending bid. That is honest,
  but many open bids could starve plain requests.
- **D4. How long a bid is valid.** *Recommend:* a new `proposalTimeoutMs`
  setting (default: `replyTimeoutMs`), stamped as the `propose`'s `reply-by`.
  The bid expression could later override it with `{ terms, validForMs }`.
- **D5. A `propose` nobody asked for** (the FIPA Propose protocol, SC00036).
  *Recommend:* answer `reject-proposal { reason: "no call open" }`, so the
  sender gets closure, and leave the Propose protocol itself out of scope.
  *Alternative:* `not-understood`. That is wrong, because the act is
  understood.
- **D6. Where the bids live.** *Recommend:* only on `intention.calls`, with no
  `proposal.*` beliefs (see above).
- **D7. Who chooses the winner.** *Recommend:* the plan's next action, using
  `awards`. Plan bodies stay the only place plan logic lives, and choosing is
  a step of the plan. *Alternative:* a `select` callback on the call.
- **D8. Bids and the belief middleware.** Bids are not assertions, so the
  belief middleware does not see them. *Recommend:* no gate at receipt. The
  award action filters on what it trusts. Revisit if a use case needs it.

## Phases

### 0. Make room in `reasoning.ts` (recommended first)

`reasoning.ts` is now 5,064 lines, and this plan adds two state tables and
three tick steps. The first step is to extract outbound-exchange tracking into
its own module with no behaviour change: `sentRequests`, `awaitingReply`,
`pendingQueries`, `pendingCancels`, `remoteDelegations`, `delegationBatches`
and the delegation helpers. Calls then go in a module of their own beside it.

### 1. Vocabulary

- **`performatives.ts`:**
  - add a `isCallForProposals` predicate;
  - take `cfp` out of `isUnsupportedDirective`, which then returns `false` for
    every act. Keep it as the extension point it documents;
  - update the module docs.
- **`schemas.ts`:**
  - `cfpContentSchema` (`requestContentSchema`);
  - `proposeContentSchema` (`{ goal, terms }`);
  - `acceptProposalContentSchema` (`{ goal, terms? }`);
  - `rejectProposalContentSchema` (`{ goal, reason? }`).
- **`plans.ts`:** `Plan.bid`, `ActionResult.calls`, `ActionResult.awards`, and
  `"declined"` in `RefusalVerdict` (D2).
- **`intentions.ts`:** `Call`, `Proposal`, `Intention.calls`, and an
  open-calls clause in `isAwaitingWork`.

### 2. Participant

- `considerDirective`'s final step sends a `cfp` to a new `answerCfp`.
- `pendingProposals`, and `expireProposals` in the tick next to
  `expireReplies`.
- `reviseBeliefs` cases for `accept-proposal` and `reject-proposal`. An accepted
  bid is admitted through a variant of `goalFromMessage` that opens
  `openRequests` without an `agree`.
- `handleCancel` finds a pending bid, or a bid still being evaluated, by the
  `cfp`'s `replyWith`.
- Events: `proposal:sent`, `proposal:accepted`, `proposal:rejected`,
  `proposal:expired`.

### 3. Initiator

- `applyActionResult` handles `calls`: one `cfp` per receiver through
  `sendMessage`, or a publish, plus a call registry keyed by each `cfp`'s
  `replyWith`.
- `reviseBeliefs` files `propose`, `refuse` and `not-understood` that name a
  call's `cfp` against the call. This comes before the generic refusal path,
  which still runs for its beliefs.
- A new `closeCalls` tick step after `expireReplies`. **Closing resumes the
  intention only when nothing else is open.** `resumeIntention`, which
  `reviewDelegations` reaches, must also stop resuming while a call is open.
- `applyActionResult` handles `awards`: `accept-proposal` plus a delegation
  record, then automatic `reject-proposal` for the rest.
- `sendMessage` tracks `accept-proposal` the way it tracks a request
  (`sentRequests`, with `intent.*` held positive from the start).
- Tie the early-stop clean-up into `failIntention` and `withdraw`.
- Events: `call:opened`, `call:proposal`, `call:closed`.

### 4. Docs and examples

- PERFORMATIVES.md: a section per act, and the four status rows set to
  **Done**.
- FIPA-COMPLIANCE.md: issue 10 shrinks to `proxy` and `propagate`.
- README.
- `src/examples/contract-net.ts`: three carriers bid, the cheapest ships, and
  one carrier declines.
- DELEGATION.md: link the race caveat here.

Phases 1–2 can ship as one PR: a participant is useful on its own to an
initiator that is not a classic-agents agent. Phase 3 is the second PR.

## Tests

Participant:

- `cfp` → `propose` with the bid's terms, correlated: `inReplyTo` = the
  `cfp`'s `replyWith`, the conversation inherited, and `reply-by` stamped.
- `refuse` for each case: `no-plan`, `unsupported` (no `bid`), `capacity`
  (full queue, evaluation limit), `middleware`, and `declined` (a `null` bid,
  an error, a timeout).
- `accept-proposal` → the goal is admitted with the terms in `data`, no
  `agree` is sent, and the plan's `result` comes back in
  `inform { done: true }`. A plan failure gives `failure`.
- An accept from a third agent, one after expiry, one naming nothing, and one
  with no room each get `failure`.
- `reject-proposal`, expiry and `cancel` of the `cfp` each drop the pending
  bid. `cancel` gets `inform { cancelled: "cfp" }`.
- A `cancel` naming the accept withdraws the job under `cancellable` rules.

Initiator:

- Three invited, two bid, one refuses: the call closes as soon as all three
  have answered, before the deadline.
- One stays silent: the call closes at the deadline with what it has.
- A topic call closes only at the deadline.
- Award one bid: the others get `reject-proposal`, the intention waits on the
  award as a delegation, and resumes with `Delegation.result`.
- The winner sends `failure`: `onFailure: "fail"` fails the parent, and
  `"continue"` resumes it with `childFailures`.
- The award passes its `timeoutMs`: the winner is sent a `cancel` that names
  the accept.
- No bids, then `failure` from the award action: no stray messages.
- The intention is cancelled mid-call: the bids received are rejected, and a
  late bid gets "call closed".
- A raw `cfp` through `messages`: bids are tracked and `call:proposal` is
  emitted, with no automatic rejection.
- End to end with two classic-agents agents.

## Risks

- **Size of `reasoning.ts`.** Phase 0 exists for this.
- **Resuming while a call is open.** Today `resumeIntention` assumes
  delegations are the only thing an intention waits on. Every resume path
  (`reviewDelegations`, `releaseWaitingParents`, call closing) must check
  `isAwaitingWork` with calls included.
- **Bidding without reserving (D3).** Bidding on many calls at once can mean
  winning more than the agent can take. The `failure` it then sends is
  allowed, but costly for the initiator. The documentation must say so.
- **Single receiver per message (issue 12).** A call to N agents is N
  exchanges. The call groups them, so nothing correlates by conversation
  alone. That matters, because the goal's conversation may hold several calls.

## Not covered

- **Iterated Contract Net** (SC00030): rounds where rejected bidders bid
  again. A plan can approximate it by issuing another call from a later
  action. Native support would mean keeping bidders across rounds.
- **The Propose protocol** (SC00036): a `propose` nobody asked for is
  rejected (D5).
- **Bids that take real work.** A bid that needs a service call or a model
  breaks the `Expression` contract. A later extension could let `bid` name a
  goal whose plan's `result` is the bid. That reuses self-delegation, and it
  is the reason `bid` is a name rather than a function.
- **Peers that are not classic-agents.** These are the same wire conventions
  and the same caveat as delegation: `{ goal, ...view }` content and
  `done: true` completion, with no SL. Translate in a wrapping `MessageBus`.
- **`proxy` and `propagate`.** Untouched.
