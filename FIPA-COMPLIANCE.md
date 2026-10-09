# FIPA Compliance Issues

Tracks the gaps found in a FIPA-ACL compliance review of the `FIPA-faithful`
branch at commit `d41192d`. Each issue below is written to be pasted into GitHub
as-is: the heading is the title, and everything under it down to the next `---`
is the body. Code links are permalinks to that commit, so they stay correct as
the code moves.

Spec references:
- **SC00037** — FIPA Communicative Act Library Specification
- **SC00061** — FIPA ACL Message Structure Specification
- **SC00026** — FIPA Request Interaction Protocol (also defines the cancel meta-protocol)

## Tracker

Fill in the GitHub number once each issue is filed, and update the status as fixes land.

**Status as of 2026-10-09, verified against `main` @ `5d41a91`** (after
raminb-dls/classic-agents PRs #1–#6). Each issue's own section has a
**Status** note with the detail and the commit that changed it.

| Status | Count | Issues |
| --- | --- | --- |
| Fixed | 12 | 1–9, 11, 14, 15 (with the follow-ups of 1 and 3) |
| Partly fixed | 2 | 10, 13 |
| Open | 1 | 12 |

| # | Issue | Severity | Area | GitHub | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Agreed requests never get a terminal `inform`/`failure` | Critical | Protocol | #24 | **Fixed** in Freelansys/classic-agents#31 (`c719216`); follow-ups 1a–1c in raminb-dls/classic-agents#1 (`236c34d`) |
| 2 | A sub-goal can make the agent `refuse` after it already sent `agree` | Critical | Protocol | | **Fixed** in `e9090da` |
| 3 | Every plan-sent message is stamped `in-reply-to` the original request | High | Correlation | #26 | **Fixed** in Freelansys/classic-agents#33 (`57050c5`); follow-ups 3a–3c in raminb-dls/classic-agents#1 (`236c34d`) |
| 4 | `cancel` is stored as a positive belief and cancels nothing | High | Protocol | | **Fixed** in raminb-dls/classic-agents#5 (`ae3c6a2`) and on branch `cancel-running-requests`: standing commitments, unstarted requests, and started requests whose plans are `cancellable`, with `onCancel` clean-up |
| 5 | Acts that are not assertions are written into the belief base | High | Semantics | | **Fixed** in `d2f2290` (non-FIPA acts removed) and raminb-dls/classic-agents#5 (`ae3c6a2`) |
| 6 | Receiving `failure` does not close the sender's exchange record | Medium | Semantics | | **Fixed** on branch `failure-and-refusal-verdicts` |
| 7 | The `reply-to` parameter is ignored | Medium | Envelope | | **Fixed** in raminb-dls/classic-agents#6 (`ac141b8`) |
| 8 | `no-plan`/`unsupported` refusal verdicts are dropped on receipt | Medium | Semantics | | **Fixed** on branch `failure-and-refusal-verdicts` |
| 9 | The "FIPA-ACL 97" vocabulary does not match the FIPA act library | Medium | Vocabulary | | **Fixed** in `d2f2290` (no changelog entry: the repo has no CHANGELOG) |
| 10 | Recognised but unhandled performatives are dropped without a reply | Low | Protocol | | **Partly fixed**: the list shrank to `propose`, `accept-proposal`, `reject-proposal`, `proxy`, `propagate` |
| 11 | Request tracking only covers the literal `request` performative | Low | Correlation | | **Fixed** in raminb-dls/classic-agents#3 (`754313d`) and #5 (`ae3c6a2`) |
| 12 | Envelope deviations: single receiver, non-`X-` extensions, no ingress validation | Low | Envelope | | **Open** |
| 13 | `protocol`, `language`, `ontology` and `reply-by` are carried but never used | Low | Envelope | | **Partly fixed**: `reply-by` in raminb-dls/classic-agents#6 (`ac141b8`); `protocol`, `language`, `ontology` still unused |
| 14 | Act classes are misattributed to FIPA, and the module docs contradict the table | Low | Docs | | **Fixed** on branch `docs-fipa-classes-and-spec`: the classes are documented as the library's, and assertives' rational effect is stated correctly |
| 15 | Spec errors in PERFORMATIVES.md and the query section of README | Low | Docs | | **Fixed** on branch `docs-fipa-classes-and-spec`: all six items corrected, and README states the query limitation |

Suggested order for what remains: 10, then 12 and 13.

Suggested labels: `fipa-compliance` on all of them, plus `bug` (1–8, 10–12) or
`documentation` (14, 15). Issues 9 and 13 can be either, depending on whether
the code or only the docs change.

---

## 1. Agreed requests never get a terminal `inform`/`failure`

**Severity:** Critical · **Area:** Request protocol · **Labels:** `fipa-compliance`, `bug`

### Summary
Once an agent has sent `agree` for a request, it never sends the reply that
should end the exchange. If the plan doesn't send an `inform` itself, or if the
work fails in any way, the requester waits forever.

### What FIPA requires
In the FIPA Request Interaction Protocol (SC00026), a participant that sends
`agree` must later send exactly one of:
- `inform-done` (an `inform` that the action was done), or `inform-result`
- `failure`

### Current behaviour
- [`completeIntention`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L2131-L2135)
  marks the goal `achieved` and emits a local event. Nothing goes on the wire.
- [`failIntention`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L2137-L2149)
  emits `intention:failed` locally. Nothing goes on the wire.
- These failure paths all end silently:
  - an action returns `failure`
  - an action throws
  - a sub-goal fails and the parent fails with it
  - a goal is dropped by [`dropDependentGoals`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L2289-L2295)
- The only terminal reply that ever goes out is one the plan author sends
  explicitly through `ActionResult.messages`. A plan that throws can't do that.

### Steps to reproduce
1. Agent B has a plan for goal `work` whose only action throws.
2. Agent A sends B `request { goal: "work" }`.
3. A receives `agree`, and then nothing else. `intent.B.work.<exchange>` stays `positive` forever.

### Expected behaviour
For any goal whose `source.sender` is another agent and that was agreed:
- **Goal achieved:** send an `inform` (done) to the requester, unless the plan
  has already sent a terminal reply for this exchange.
- **Goal failed or dropped:** send `failure` with `{ goal, reason }`.
- Either reply carries the request's `conversationId` and
  `inReplyTo = source.inReplyTo`.

### Suggested approach
- Send the reply from the goal's terminal transition: a `goal:status` change to
  `achieved`, `failed` or `dropped`. Restrict it to **root** goals that came from
  a directive (`!goal.parentGoalId`), so sub-goals don't each produce a reply.
- Track which exchanges have already been answered terminally, so a plan that
  sends its own `inform` with a result isn't followed by a second, automatic one.
  Alternatively, make the automatic reply opt-out per plan.
- Queue the replies and send them from the tick, the same way `agree` and
  `refuse` go out through `flushDirectiveAnswers`.

### Acceptance criteria
- [x] A request whose action throws ends with exactly one `failure`, correctly correlated.
- [x] A request whose plan completes without messaging ends with exactly one `inform`.
- [x] A plan that sends its own result `inform` doesn't trigger a duplicate.
- [x] Sub-goal completion and failure don't produce wire messages. Only the root goal's outcome does.
- [x] A goal dropped through `dependsOn` sends `failure`.
- [x] PERFORMATIVES.md (`request`, `failure`) and DELEGATION.md §4 updated to describe the new contract.

### Verification (2026-10-09, `main` @ `820daa7`)

PR #31 (`c719216`) adds `openRequests`, `queueOutcome`, `flushTerminalAnswers`
and `closeAnsweredExchange`. The reply is sent from the goal's terminal status
transition, only for root goals that were agreed to, at most once. All six
acceptance criteria above hold, and they're covered by the "Request protocol
terminal replies" tests. The full suite passes (390/390).

Three gaps were reproduced with a throwaway test. Each could be filed as a follow-up issue:

- **1a. A progress `inform` suppresses the `failure`.**
  `closeAnsweredExchange` treats *any* `inform` a plan sends to the requester as
  the final reply. A plan that sends `inform { progress: 50 }` and then throws
  leaves the requester with `agree` and `inform { progress: 50 }`, and no
  `failure`. Sub-goal messages close the root exchange the same way.
  Suggested fix: only close the exchange on an explicit terminal marker (for
  example `done: true`, or a dedicated `ActionResult` field), or when the goal
  has actually reached a terminal status.
- **1b. `agent.goals.remove(id)` on an agreed, unfinished goal sends nothing.**
  `onGoalRemoved` deletes the `openRequests` entry without answering, so the
  requester gets only `agree`. Removing a goal that hasn't finished should send
  `failure` (for example "goal removed").
- **1c. `agent.stop()` leaves open requests unanswered.** It's arguable whether
  this needs fixing. Either send `failure` ("agent stopped") for every open
  request on stop, or document that stopping abandons them.

**Follow-up status (merged in raminb-dls/classic-agents#1, `236c34d`):**
- [x] 1a: a plan's `inform` no longer closes the exchange. It only marks it
  as `informed`, which suppresses the automatic `inform` if the goal is
  achieved. A goal that fails afterwards still sends `failure`. A plan's own
  `failure` still closes the exchange.
- [x] 1b: `onGoalRemoved` answers an agreed goal still open at removal with
  `failure { reason: "goal removed before it finished" }`.
- [x] 1c: resolved by documentation. `stop()` is a pause: goals and agreed
  requests survive a restart and are answered when they end. Sending
  `failure` on stop would be wrong for a paused agent. Documented on `stop()`
  and in PERFORMATIVES.md › The terminal reply.

---

## 2. A sub-goal can make the agent `refuse` after it already sent `agree`

**Severity:** Critical · **Area:** Request protocol · **Labels:** `fipa-compliance`, `bug`

### Summary
Sub-goals inherit the parent goal's `source`. If a sub-goal has no plan, or is
shed for capacity, the agent sends a `refuse` to the original requester. That
requester has already received `agree` for the same exchange, and the `refuse`
names a goal it never asked for.

### What FIPA requires
`refuse` declines a request that has **not** been agreed to. After `agree`, the
only valid negative ending is `failure` (SC00026).

### Current behaviour
- Children are created with the parent's `source`:
  [`applyActionResult`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L2227-L2238).
- **No plan for the child:**
  [`meansEndsReasoning`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1981-L1984)
  calls [`declineGoal`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L2037-L2048),
  which queues a `refuse` to `goal.source.sender`.
- **Child shed for capacity:**
  [`reportRejections`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L904-L913)
  sends a `refuse` to `goal.source.sender`.

### Steps to reproduce
1. Agent B's plan for `ship` spawns `newGoals: [{ name: "package" }]`, and B has no plan for `package`.
2. A sends `request { goal: "ship" }`.
3. A receives `agree { goal: "ship" }`, then `refuse { goal: "package", verdict: "no-plan" }`. Both carry the same `inReplyTo`.

### Expected behaviour
- A goal with a `parentGoalId` never sends `refuse` on the wire. Its failure goes
  to the waiting parent only, through `failWaitingParents`.
- If that failure brings the root goal down, the requester gets a single
  `failure` (see #1).
- The local `goal:refused` event can stay as it is.

### Acceptance criteria
- [x] No-plan sub-goal: the requester sees `agree` then `failure`, never `refuse`.
- [x] Capacity-shed sub-goal: same.
- [x] Root-goal refusals at admission are unchanged.
- [x] Tests cover both paths.

---

## 3. Every plan-sent message is stamped `in-reply-to` the original request

**Severity:** High · **Area:** Correlation · **Labels:** `fipa-compliance`, `bug`

### Summary
`applyActionResult` copies `conversationId` **and** `inReplyTo` from
`goal.source` onto every message a plan sends. That includes topic broadcasts
and new requests to unrelated agents. Those agents receive a message claiming to
reply to a message they never saw.

### What FIPA requires
`in-reply-to` names the earlier message that *this* message answers (SC00061).
It only means something to the agent that sent that earlier message.

### Current behaviour
[`applyActionResult`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L2246-L2284)
applies both fields unconditionally, for topic publishes and for point-to-point sends.

### Expected behaviour
- **Point-to-point to `goal.source.sender`:** inherit both `conversationId` and `inReplyTo`. Unchanged.
- **Point-to-point to anyone else:** don't set `inReplyTo`. Whether to inherit
  `conversationId` is an open decision; DELEGATION.md §3 recommends inheriting it.
  The new message also gets a fresh `replyWith`, which already happens.
- **Topic publish:** don't set `inReplyTo`.
- An explicit `inReplyTo` on the `ActionResult` message should win. Today the
  action-result message type can't carry one at all.

### Acceptance criteria
- [x] A plan that sends a `request` to a third agent doesn't put the requester's `replyWith` in `inReplyTo`.
- [x] A plan's reply to the requester is still correlated.
- [x] Decide and document the conversation-id rule in PERFORMATIVES.md › Correlation.

### Verification (2026-10-09, `main` @ `820daa7`)

PR #33 (`57050c5`) builds the envelope per message in `applyActionResult`:
- `conversationId` is inherited by every message, point-to-point or topic.
- `inReplyTo` is inherited only when `msg.receiver === goal.source.sender`.
- An explicit `ActionResult` message `inReplyTo` wins over the inherited one.

The decision is documented in PERFORMATIVES.md › Correlation and DELEGATION.md.
The four "Action-result message correlation" tests pass, and so does the full suite.

Three edge cases were reproduced with a throwaway test. Each could be filed as a follow-up:

- **3a. Explicit `inReplyTo` to the requester swallows the terminal reply (interacts with #1).**
  A plan sends `inform { unrelated: true }` to the requester with
  `inReplyTo: "other-msg"`. `closeAnsweredExchange` checks only the receiver
  and the performative, so it closes the original exchange anyway. The
  requester receives `agree` (for `m1`) and an `inform` for `other-msg`, and
  never gets the `inform`/`failure` for `m1`.
  Fix: only close the exchange when the message actually answers it, i.e. its
  resulting `inReplyTo` equals `goal.source.inReplyTo`. Best done together with 1a.
- **3b. A topic message with `receiver` set leaks `inReplyTo` to subscribers.**
  `answersRequester` is computed before the topic/point-to-point branch, so a
  message with `topic: "news", receiver: <requester>` is published to the topic
  carrying `inReplyTo: m1`. Fix: require `msg.topic === undefined` in
  `answersRequester`, or reject messages that set both fields.
- **3c. A new directive back to the requester is stamped as a reply.**
  A plan that sends the requester a `query-if` or `request` (for example, to ask
  for missing input) gets `inReplyTo: m1`. A new directive isn't a reply to the
  original request (SC00061). This is low impact, but consider inheriting
  `inReplyTo` only for reply-type acts (`inform`, `failure`, `not-understood`,
  and so on), not directives.

**Follow-up status (merged in raminb-dls/classic-agents#1, `236c34d`):**
- [x] 3a: a plan message only counts as answering the request when its
  resulting `inReplyTo` equals `goal.source.inReplyTo`.
- [x] 3b: a message with `topic` set never counts as answering the requester,
  even when it also names the requester as `receiver`.
- [x] 3c: directives (`hasHearerEffect`) to the requester keep the
  `conversationId` but don't inherit `inReplyTo`.

---

## 4. `cancel` is stored as a positive belief and cancels nothing

**Severity:** High · **Area:** Protocol · **Labels:** `fipa-compliance`, `bug`

> **Status (2026-10-09): Fixed.** In raminb-dls/classic-agents#5 (`ae3c6a2`):
> `cancel` never writes beliefs and ends standing commitments. On branch
> `cancel-running-requests`, a request in progress can be cancelled:
> - **Not started yet:** always cancellable.
> - **Started:** cancellable only if every started plan is
>   `cancellable: true`. It stops between actions and runs each plan's
>   `onCancel` clean-up.
> - **Otherwise:** answered `failure`, not `refuse`, as FIPA's cancel
>   meta-protocol requires.
>
> On the asking side, the reply to a `cancel` this agent sent is filed against
> the request it named: `inform` removes `intent.*` and records `cancelled.*`;
> anything else keeps the request tracked and records `cancel-failed.*`.
> Delegated work is cancelled the same way: on branch `delegation-protocol`, a
> delegating agent sends `cancel` to every delegate it stops waiting for.

### Summary
`cancel` is classed as `declarative`, so `isPropositional("cancel")` is true.
Its content goes into the belief base with a **positive** stance, and the goal
the sender wanted cancelled keeps running.

### What FIPA requires
`cancel(j, a)` ≡ `disconfirm(j, I_i Done(a))`: the sender no longer intends that
the receiver perform `a` (SC00037). The cancel meta-protocol (SC00026) expects
the receiver to stop the action and reply `inform` (cancelled) or `failure`
(couldn't cancel).

### Current behaviour
- Classified at [performatives.ts:53](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/performatives.ts#L53).
- Ingested at [reasoning.ts:1163-1175](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1163-L1175),
  so `cancel { goal: "x" }` writes `msg.goal = "x"` as positive.

### Expected behaviour
**Minimum (do now):** don't ingest `cancel` as an assertion. Answer it with
`refuse { verdict: "unsupported" }` or `not-understood` until cancellation is
implemented.

**Full fix:**
1. Find the goal by exchange: the cancel's `conversationId`/`inReplyTo`, matched
   against `goal.source`. Only accept a cancel from the goal's own `source.sender`.
2. Drop the goal, and its sub-goals and intention.
3. Reply `inform` (done) on success, or `failure` if there's no matching goal or
   it has already finished.
4. On the sender side, set `intent.<peer>.<goal>.<exchange>` to `negative`.

### Acceptance criteria
- [x] A `cancel` never writes beliefs on the receiver.
- [x] Full fix: an in-flight goal is dropped, its intention is cleaned up, and the canceller gets a correlated reply. *(For a started request, only when its plans are marked `cancellable: true`; otherwise `failure`.)*
- [x] A cancel from an agent other than the requester is not honoured.
- [x] Update the "`cancel` is a `disconfirm`" note in PERFORMATIVES.md. *(Replaced by a `cancel` section.)*

---

## 5. Acts that are not assertions are written into the belief base

**Severity:** High · **Area:** Semantics · **Labels:** `fipa-compliance`, `bug`

> **Status (2026-10-09): Fixed.** `query-if-known`, the legacy `query` and
> `disagree` left the vocabulary in `d2f2290` and are answered
> `not-understood`. In raminb-dls/classic-agents#5 (`ae3c6a2`), no directive's
> content reaches the belief base (`reviseBeliefs` skips ingestion when
> `hasHearerEffect`), which covers `request-when`, `request-whenever` and
> `subscribe`; `cancel` is handled separately and never ingested.

### Summary
`reviseBeliefs` writes the content of every act classed as "assertive" into the
belief base with a positive stance. For several performatives the content isn't
a proposition the sender believes, so the receiver ends up believing the wrong thing.

### Affected performatives

| Performative | What gets stored | Why it's wrong |
| --- | --- | --- |
| `request-when`, `request-whenever` | the action and the condition | SC00037 defines these as an `inform` about the sender's **intention** that the receiver act once φ holds. They don't assert φ, which is usually false when the message is sent. |
| `subscribe` | a referential expression | Not a proposition. |
| `query-if-known`, legacy `query` | the question | A question stored as a fact. |
| `disagree` | the content, as positive | The polarity is inverted, the same bug `disconfirm` had before stance support. |

### Current behaviour
- Classes come from [`PERFORMATIVE_CLASSES`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/performatives.ts#L50-L79).
- Ingestion happens at [reasoning.ts:1163](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1163).
- The comment at [reasoning.ts:1151-1153](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1151-L1153)
  and the "Assert + Refuse" rows in PERFORMATIVES.md describe this as intended.

### Expected behaviour
Restrict belief ingestion to acts whose content is a proposition the sender
asserts: `inform`, `confirm`, `disconfirm`, and the semantic handlers for
`failure` and `not-understood`.
- `request-when`, `request-whenever` and `subscribe` are refused (as today) with no belief write.
- `query-if-known` and `query` are refused or answered `not-understood`, with no belief write.
- `disagree` is either removed from the vocabulary (see #9) or given a reply
  role like `refuse`. It must not be stored as positive.

Consider replacing the class-derived `isPropositional` with an explicit
allow-list, the same way `ACTION_DIRECTIVES` is explicit.

### Acceptance criteria
- [x] Tests show none of the listed performatives change the receiver's belief base.
- [x] `inform`, `confirm` and `disconfirm` behaviour is unchanged.
- [x] Remove the "Assert + Refuse" reaction from PERFORMATIVES.md, or re-justify it against SC00037.

---

## 6. Receiving `failure` does not close the sender's exchange record

**Severity:** Medium · **Area:** Semantics · **Labels:** `fipa-compliance`, `bug`

> **Status (2026-10-09): Fixed** on branch `failure-and-refusal-verdicts`. A
> `failure` naming a goal now runs the trust chain and is filed under its
> exchange: `intent.<peer>.<goal>.<exchange>` goes `negative` (FIPA's
> `¬I_i Done(a)`, the same fact a `refuse` states) and
> `failed.<peer>.<goal>.<exchange>` records the reason, one record per
> exchange. It no longer also lands as `msg.goal`/`msg.reason`. A failure
> with no goal stays an ordinary claim on the `msg.*` path.
> The success path got the same treatment: an `inform` with `done: true`
> removes `intent.*` and records `done.<peer>.<goal>.<exchange>`; other informs
> in the exchange are notes at `result.*`. A plan inform no longer stands in for
> the automatic final one unless it is marked `done: true`.

### Summary
The FIPA meaning of `failure` includes `¬Done(a) ∧ ¬I_i Done(a)`: the action
wasn't done, and the agent no longer intends to do it. The receiving agent
doesn't record that against the exchange.

### Current behaviour
In [`handleFailureMessage`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1706-L1732):
- `intent.<peer>.<goal>.<exchange>` stays `positive` after a `failure`.
- `failed.<sender>.<goal>` isn't scoped to the exchange, unlike `intent.*` and
  `infeasible.*`. A second failure for the same goal overwrites the first, which
  is exactly the problem the Correlation decision in PERFORMATIVES.md set out to remove.
- The generic assertion path also writes `msg.goal` and `msg.reason` as ordinary positive beliefs.

### Expected behaviour
- Set `intent.<peer>.<goal>.<exchange>` to `negative`, with the exchange taken
  from `inReplyTo ?? conversationId`.
- Store `failed.<peer>.<goal>.<exchange>`, falling back to the goal-scoped key
  when there are no ids, as `exchangeKey` already does.
- Reconsider whether the content should also go through the generic `msg.*`
  path. If it should, document why.

### Acceptance criteria
- [x] After `agree` then `failure`, `statusOf(intent…)` is `negative`.
- [x] Two failures for the same goal on different exchanges produce two records.
- [x] Update the PERFORMATIVES.md `failure` section.

---

## 7. The `reply-to` parameter is ignored

**Severity:** Medium · **Area:** Envelope · **Labels:** `fipa-compliance`, `bug`

> **Status (2026-10-09): Fixed** in raminb-dls/classic-agents#6 (`ac141b8`).
> Every reply goes to `replyTo ?? sender`, and `GoalSource.replyTo` carries it
> to a goal's later replies. `sender` stays the identity, so only the original
> sender may cancel. Plans can set `replyTo` per message.

### Summary
`replyTo` is in `MessageSchema`, but every reply goes to `msg.sender`.

### What FIPA requires
SC00061: when `reply-to` is set, later messages in the conversation go to that
agent instead of the sender.

### Current behaviour
- [`sendNotUnderstood`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L968-L976),
  [`declineDirective`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1446-L1453)
  and [`goalFromMessage`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1792-L1834)
  all address `msg.sender`.
- `GoalSource` records `sender` only, so later replies (capacity refusals, and
  the terminal reply from #1) can't honour it either.

### Expected behaviour
- Add `replyTo?: string` to `GoalSource`.
- Address every reply to `msg.replyTo ?? msg.sender`, including `agree`,
  `refuse`, `not-understood` and the terminal replies.
- Keep belief keys tied to the agent that actually performs the work, not the `replyTo` address.
- The self-reply guards (`!== this.id`) should check the resolved address.

### Acceptance criteria
- [x] A request with `replyTo: "monitor"` gets its `agree`, `refuse` or `not-understood` delivered to `monitor`.
- [x] Without `replyTo`, behaviour is unchanged.

---

## 8. `no-plan`/`unsupported` refusal verdicts are dropped on receipt

**Severity:** Medium · **Area:** Semantics · **Labels:** `fipa-compliance`, `bug`

> **Status (2026-10-09): Fixed** on branch `failure-and-refusal-verdicts`.
> `handleRefusalMessage` keeps every `RefusalVerdict` (`no-plan`, `capacity`,
> `unsupported`, `middleware`) in `goalRefused` and the `infeasible.*` record.
> Only a word outside the vocabulary is dropped. The comment, PERFORMATIVES.md
> › `refuse` and README now say so.

### Summary
[`handleRefusalMessage`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1658-L1667)
keeps only the `capacity` and `middleware` verdicts. A peer's `no-plan` or
`unsupported` is dropped, so `infeasible.<peer>.<goal>.<exchange>` has
`verdict: undefined` for exactly the permanent refusals.

### Why it matters
- PERFORMATIVES.md › `refuse` promises that the infeasible record lets "a plan
  … distinguish 'no room right now' from 'never has a plan for this'". With the
  current filter it can't.
- FIPA's `refuse` disconfirms feasibility, so the permanent verdicts are the ones
  that match the spec most closely.
- The code comment's reason ("permanent facts about the requester") reads as garbled: they're facts about the **refusing** peer.

### Expected behaviour
- Accept every value in `RefusalVerdict`.
- Keep a value outside the vocabulary as `undefined`, or store it raw under a separate field.

### Acceptance criteria
- [x] A received `refuse { verdict: "no-plan" }` is stored with `verdict: "no-plan"`, both in the event and in the infeasible record.
- [x] The comment and the PERFORMATIVES.md text agree with the code.

---

## 9. The "FIPA-ACL 97" vocabulary does not match the FIPA act library

**Severity:** Medium · **Area:** Vocabulary · **Labels:** `fipa-compliance`

> **Status (2026-10-09): Fixed** in `d2f2290` ("add missing FIPA performatives
> and remove legacy ones"). `FIPA_PERFORMATIVES` is exactly the 22 SC00037J
> acts, with `cfp`, `propose`, `inform-if` and `inform-ref` added and
> `achieve`, `query` and the invented acts removed. Names outside the list are
> answered `not-understood`, and a test pins the list. `cfp` is refused
> `unsupported`; `inform-if`/`inform-ref` are received as `inform`.

### Summary
[`PERFORMATIVE_CLASSES`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/performatives.ts#L50-L79)
is presented as "every FIPA-ACL performative", but it doesn't match the 22
communicative acts in SC00037.

- **Missing FIPA acts:** `cfp`, `propose`, `inform-if`, `inform-ref`.
- **Included acts that aren't in FIPA:** `delegate`, `commit`, `declare`,
  `disagree`, `promise`, `query-if-known`, `sorry`, `invite`, `invoke`, `unsubscribe`.

### Consequence
- A standards-compliant peer (for example JADE) starting a contract net with
  `cfp` gets `not-understood: unknown performative`.
- An invented `invite` is treated as "known" and silently dropped (see #10).
- PERFORMATIVES.md's status table lists `cfp`, `propose`, `inform-if` and
  `inform-ref` as acts, but `isKnownPerformative` rejects them.

### Expected behaviour
- `FIPA_PERFORMATIVES` contains exactly the 22 SC00037 acts.
- Non-FIPA acts move to a separate, clearly named extension or legacy map (next
  to `LEGACY_PERFORMATIVES`), or are removed. Each one keeps its handling
  explicit; for `disagree` and `query-if-known`, see #5.
- `cfp`, `propose`, `inform-if` and `inform-ref` are recognised. Until they're
  implemented, answer them with `refuse { verdict: "unsupported" }` (for the
  directive-like `cfp`) or `not-understood`, rather than "unknown performative".

### Acceptance criteria
- [x] A test asserts `FIPA_PERFORMATIVES` equals the SC00037 list.
- [x] Extensions are documented as extensions in README › Messaging Protocol. *(None remain; README says the vocabulary is exactly the 22 acts.)*
- [ ] Note any breaking change to the `Performative` type in the changelog. *(The repo has no CHANGELOG.)*

---

## 10. Recognised but unhandled performatives are dropped without a reply

**Severity:** Low · **Area:** Protocol · **Labels:** `fipa-compliance`, `bug`

> **Status (2026-10-09): Partly fixed.** The non-FIPA acts on the original list
> (`invite`, `invoke`, `sorry`, `commit`, `promise`, `unsubscribe`) are gone
> from the vocabulary and now get `not-understood`. **Still silent:**
> `propose`, `accept-proposal`, `reject-proposal`, `proxy` and `propagate`
> produce no reply and no record.

### Summary
These are recognised performatives with no CA class, or a class that has no
handler. They fall through `reviseBeliefs` and nothing is sent back:
`accept-proposal`, `reject-proposal`, `proxy`, `propagate`, `unsubscribe`,
`invite`, `invoke`, `sorry`, `commit`, `promise`.

An unknown performative gets `not-understood`
([reasoning.ts:1099-1107](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1099-L1107)),
so a peer gets a better answer for an act the agent has never heard of than for
one it recognises.

### Expected behaviour
- **Directive-like acts** (`proxy`, `propagate`): `refuse { verdict: "unsupported" }`.
- **Replies to a negotiation this agent never started** (`accept-proposal`,
  `reject-proposal`): `not-understood` with a reason such as `"no matching proposal"`.
- **Everything else:** `not-understood`, or document explicitly why silence is acceptable.

### Acceptance criteria
- [ ] Each listed performative has a test pinning its reply, or its documented silence.

---

## 11. Request tracking only covers the literal `request` performative

**Severity:** Low · **Area:** Correlation · **Labels:** `fipa-compliance`, `bug`

> **Status (2026-10-09): Fixed.** `request-when` and `request-whenever` open
> `intent.*` like a request (raminb-dls/classic-agents#5, `ae3c6a2`). Queries
> are tracked at `answer.<peer>.<name>.<exchange>` instead of `intent.*`
> (raminb-dls/classic-agents#3, `754313d`), and subscriptions at
> `subscription.*` (#5). `delegate` and `achieve` no longer exist.

### Summary
[`sendMessage`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1013-L1019)
calls `markRequestIntention` only when `performative === "request"`. A
`query-if`, `query-ref`, `delegate` or `achieve` the agent sends gets no
`intent.*` record. Then the `agree` or `refuse` that comes back calls
`setStatus` on a key that doesn't exist.

### Expected behaviour
- Use `directsAction(stamped.performative)` instead of the string comparison.
- Check `BeliefBase.setStatus` on a missing key: it should either be a documented no-op or create the key.

### Acceptance criteria
- [x] Sending a `query-if` creates `intent.<peer>.<goal>.<exchange>` as `uncertain`, and it moves to `positive` on `agree`. *(Superseded: a query opens `answer.<peer>.<name>.<exchange>` as `uncertain`, settled by its answer.)*

---

## 12. Envelope deviations: single receiver, non-`X-` extensions, no ingress validation

**Severity:** Low · **Area:** Envelope · **Labels:** `fipa-compliance`

> **Status (2026-10-09): Open.** `receiver` is still a single string,
> `timestamp` is still required by `MessageSchema`, and incoming envelopes are
> still not validated. The library no longer ships `RedisMessageBus`, where
> the cast below lived; a transport is now the user's own, so validating in
> the agent matters more, not less.

### Summary
[`MessageSchema`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/types.ts#L20-L99)
differs from SC00061 in ways that matter for interoperating with other FIPA
platforms.

1. **`receiver` is a single string.** FIPA defines `receiver` as a *set* of agent identifiers.
2. **Non-FIPA parameters aren't marked as extensions.** `topic` and `timestamp`
   (which is required) aren't FIPA parameters. SC00061's convention for
   user-defined parameters is an `X-` prefix. A message from a FIPA peer has no
   `timestamp`, so the type is violated as soon as it arrives.
3. **Incoming envelopes are never validated.**
   [`redis.ts:123`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/redis.ts#L123)
   and [`redis.ts:197`](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/redis.ts#L197)
   cast `JSON.parse` straight to `Message`. A message with no `sender` or
   `performative` is silently skipped, and wrong types aren't detected.

### Expected behaviour
- Decide whether to support multiple receivers. If not, document the restriction in README.
- Make `timestamp` optional on receipt (the library can still stamp it on send),
  and document `topic`/`timestamp` as library extensions. Renaming them on the
  wire is optional.
- Validate incoming envelopes against `MessageSchema` in the agent, so every
  transport benefits. A message that fails validation but has a `sender` is
  answered `not-understood`.

### Acceptance criteria
- [ ] A message with no `timestamp` is processed normally.
- [ ] A message with a malformed envelope gets `not-understood` when it has a sender, and a local event otherwise.

---

## 13. `protocol`, `language`, `ontology` and `reply-by` are carried but never used

**Severity:** Low · **Area:** Envelope · **Labels:** `fipa-compliance`, `enhancement`

> **Status (2026-10-09): Partly fixed.** `reply-by` is done in
> raminb-dls/classic-agents#6 (`ac141b8`): stamped on every directive by
> default (`replyTimeoutMs`, 30 s), overridable per message, enforced on the
> asking side (`reply:timeout`, `unanswered.*`) and the receiving side
> (`directive:expired`). **Still unused:** `protocol`, `language`, `ontology`.

### Summary
These SC00061 parameters are in the schema, but nothing sets or reads them.

### Expected behaviour
- **`protocol`:** the request admission path (`agree`, `refuse`, terminal reply)
  sets `protocol: "fipa-request"` on replies. Replies to a message that already
  names a protocol echo it back.
- **`language` / `ontology`:** add an optional config list of supported values.
  A message naming one that isn't listed is answered `not-understood` with a
  reason. If the list isn't configured, keep accepting everything (today's behaviour).
- **`reply-by`:** at minimum, when sending a request with `replyBy`, the sender
  can treat a missing reply by that deadline as a failure. This fits the
  timeout question already open in DELEGATION.md §3. Receivers may ignore it, but
  that should be documented.

### Acceptance criteria
- [ ] `agree` and `refuse` replies carry `protocol: "fipa-request"`.
- [ ] With `supportedOntologies` configured, an unknown ontology gets `not-understood`.
- [ ] README documents which parameters are honoured. *(`reply-to` and `reply-by` are; `protocol`, `language` and `ontology` aren't mentioned.)*

---

## 14. Act classes are misattributed to FIPA, and the module docs contradict the table

**Severity:** Low · **Area:** Docs · **Labels:** `fipa-compliance`, `documentation`

> **Status (2026-10-09): Fixed** on branch `docs-fipa-classes-and-spec`,
> checked against the text of SC00037J. The spec has **no** class table: its
> "Table 1" is a table of the symbols used in the formal models, and it uses
> "assertive" and "directive" only informally (§5.4 calls `inform` an
> assertive and `request` a directive). So this issue's own suggestion, that
> FIPA's table groups acts by purpose, was also wrong. The module doc in
> `src/bus/performatives.ts`, the README table and the `reviseBeliefs` comments
> now present the five classes as Searle's, applied by this library. They state
> that an assertive's rational effect *is* on the hearer (`B_j p`, "most of the
> assertives", §5.4.3), which is the sender's aim and not the receiver's duty.
> `hasHearerEffect`'s doc says it means "asks the hearer to act". Test names
> that credited FIPA with the classes are reworded.

### Summary
- **The classes aren't FIPA's.** [performatives.ts](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/performatives.ts#L30-L42)
  says the assertive/directive/declarative/expressive/commissive classes "follow
  FIPA-ACL 97 Table 1". Those are Searle's speech-act classes. FIPA's table
  groups acts by purpose: information passing, requesting information,
  negotiation, action performing, error handling. (Please verify the exact table
  against the spec before rewording.) Assignments such as `refuse` → expressive
  and `failure` → assertive+expressive are the library's own.
- **The module doc contradicts FIPA's `inform`.**
  [Line 10](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/performatives.ts#L10)
  says assertives have "Effects on the hearer: *none*". FIPA's `inform` has the
  rational effect `B_j p`, as PERFORMATIVES.md › `inform` itself acknowledges.
- **A JSDoc example contradicts the table.**
  [Line 201](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/bus/performatives.ts#L201)
  says `isPropositional("failure"); // false`, but the table makes it `true`.
- **A comment describes behaviour that doesn't exist.** The `reviseBeliefs` doc
  ([reasoning.ts:1087-1091](https://github.com/Freelansys/classic-agents/blob/d41192d89b752cfbf3fca610a358e400c3d771b8/src/core/reasoning.ts#L1087-L1091))
  says `request-when` "becomes a goal". It's refused.

### Expected behaviour
- Describe the classes as the library's Searle-based classification, used to derive its reactions, not as FIPA's.
- Fix the hearer-effect wording and the JSDoc example.
- Update the stale comment, together with #5.

---

## 15. Spec errors in PERFORMATIVES.md and the query section of README

**Severity:** Low · **Area:** Docs · **Labels:** `fipa-compliance`, `documentation`

> **Status (2026-10-09): Fixed** on branch `docs-fipa-classes-and-spec`, checked
> against SC00037J. Items 3, 5 and 6 were corrected earlier (raminb-dls/classic-agents#5).
> Now also:
> - **Item 1:** `query-if` is `⟨i, query-if(j, φ)⟩ ≡ ⟨i, request(j, ⟨j, inform-if(i, φ)⟩)⟩`.
> - **Item 2:** `query-ref` is `⟨i, query-ref(j, Ref x δ(x))⟩`, with `Ref` one of ι, any, all.
> - **Item 4:** `agree` is a FIPA act (§3.2), not KQML.
>
> README states that queries carry a registered name rather than an SL
> proposition or descriptor, so they only work between agents that share
> names.

### Corrections needed in PERFORMATIVES.md
1. **`query-if` › Spec (around line 451).**
   - The act is `⟨i, query-if(j, φ)⟩`. There is no descriptor `x`; that belongs to `query-ref`.
   - SC00037 defines it as `⟨i, request(j, ⟨j, inform-if(i, φ)⟩)⟩`.
   - The answer is `inform(φ)` or `inform(¬φ)`. It is **not** "`inform-if` when φ holds and `inform-ref` when it does not".
2. **`query-ref` › Spec.** The form is `query-ref(j, ιx δ(x))`, answered by an
   `inform` that identifies the referent.
3. **`agree` › Decision (around line 659).** It says `agree` is "a KQML
   performative rather than a FIPA one". `agree` is a FIPA communicative act in SC00037.
4. **`refuse` › Distinct from `failure` (around line 796).** It says an
   `inform-if`/`inform-ref` with a false condition must answer `refuse`.
   `inform-if` with φ false is `inform(¬φ)`; nothing is refused.
5. **`failure` › Decision.** It says "`failure` is an expressive in FIPA-ACL 97
   Table 1". That classification is the library's (see #14).
6. **The `cancel` note.** It says the agent "withdraws its *own* intention". In
   `cancel(j, a)`, `a` is the **receiver's** action: the sender withdraws its
   intention that j perform `a`. Reword it so it isn't read as the speaker
   cancelling its own commitment.

### README
- In the query section, state plainly that queries need a classic-agents `goal`
  name in their content. A standard FIPA peer's `query-if` is answered
  `not-understood`, so queries only work between classic-agents agents. That's a
  reasonable design given there's no content language, but it should be stated
  as a known limitation.

### Acceptance criteria
- [x] Each numbered item corrected.
- [x] README states the query interoperability limitation.
