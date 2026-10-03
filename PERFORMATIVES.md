# Performative Decisions

Working reference for how `Agent` reacts to each performative in the FIPA-ACL 97
vocabulary.

One act at a time. Each is discussed and agreed before it is implemented, and the
decision is recorded here so it survives the conversation. Nothing in this file is
implemented yet unless its row says **Done**.

## How to read a section

- **Spec** — paraphrased from SC00037J, the FIPA Communicative Act Library.
- **Current** — what the library does today, derived from the Searle
  communicative-act classes in `src/bus/performatives.ts`.
- **Question** — the thing actually worth deciding.
- **Decision** — filled in once agreed, with the reason.

## The reactions available

The agent has four reactions today, and every act resolves to one or a combination:

| Reaction | Meaning |
| --- | --- |
| **Goal** | A directive the library turns into a goal: `directiveMiddleware`, plan lookup, `agree`, then work. |
| **Refuse** | A directive the library cannot honour: answered `refuse` with `verdict: "unsupported"`. |
| **Assert** | Propositional: content is offered to the belief base, filtered by the `middleware` chain. |
| **None** | Nothing. The act is about the conversation or the sender's state, not a fact to store or work to do. |

An act can be **Assert + Refuse** — the proposition is taken as believed while the
attached work is declined. `request-when` already behaves that way.

## Status

| Performative | Reaction | State |
| --- | --- | --- |
| `inform` | Assert | **Done** |
| `inform-if` | — | Not started |
| `inform-ref` | — | Not started |
| `confirm` | Assert | **Done** |
| `disconfirm` | Assert | **Done** |
| `query-if` | — | Not started |
| `query-ref` | — | Not started |
| `subscribe` | Assert + Refuse | Not started |
| `request` | Goal | **Done** |
| `request-when` | Assert + Refuse | Not started |
| `request-whenever` | Assert + Refuse | Not started |
| `agree` | Assert | **Done** |
| `refuse` | None | **Done** |
| `cancel` | Assert | Not started |
| `cfp` | — | Not started |
| `propose` | — | Not started |
| `accept-proposal` | None | Not started |
| `reject-proposal` | None | Not started |
| `failure` | None | Not started |
| `not-understood` | — | Not started |
| `proxy` | — | Not started |
| `propagate` | — | Not started |

Also in the vocabulary but not given a formal model in SC00037 §3 — kept for
compatibility with FIPA ACL message types, not discussed as acts:

| Performative | Reaction | State |
| --- | --- | --- |
| `commit` | None | Not modelled |
| `declare` | Assert | Not modelled |
| `disagree` | Assert | Not modelled |
| `promise` | None | Not modelled |
| `query-if-known` | Assert | Not modelled |
| `sorry` | None | Not modelled |
| `invite` | None | Not modelled |
| `invoke` | None | Not modelled |
| `unsubscribe` | None | Not modelled |

---

## `inform`

### Spec

i tells j that a proposition is true, assuming i doesn't already believe j knows
its truth value. It is the basic way to pass information, and most other acts are
defined in terms of it.

SC00037 gives it a formal model whose rational effect is of the form `B_j p` — the
receiver comes to believe `p`. Unlike an assertion in Searle's taxonomy, FIPA's
own semantics here does put an effect on the hearer.

### Current

**Assert.** `isPropositional("inform")` is `true`; it has no hearer effect, creates
no goal and is never refused. Content is passed to the belief base, where the
`middleware` chain decides. The chain is empty by default, so in practice an
unconfigured agent believes everything it is told.

`inform` is the hub the rest of the vocabulary hangs off: SC00037 defines
`agree`, `accept-proposal`, `cancel`, `inform-if`, `inform-ref` and `refuse` in
terms of it, and `query-if`/`query-ref` are shorthand for a `request` to perform
`inform-if`/`inform-ref`. So this decision propagates to most of the table.

### Question

FIPA's rational effect for `inform` is that the hearer ends up believing `p`. But
the library treats every assertion as compelling nothing and puts belief behind a
user-supplied gate. Those cannot both hold: if the gate rejects an
`inform`, the receiver does not come to believe `p` and FIPA's RE simply is not
achieved.

What should an `inform` actually do to the receiver's beliefs?

### Decision

**Assert, by default, under a named trust assumption — and interruptible.**

Three separate claims, deliberately not collapsed into one:

1. **`inform` is not guaranteed to produce a belief.** The ACL does not carry
   that obligation. `B_j p` is FIPA's *rational effect* — what happens when the
   receiver is a cooperative peer — not a guarantee about what any receiver will
   do. No library can make the second true about a remote agent.
2. **classic-agents assumes agents are trustworthy and cooperative**, so in the
   default configuration an `inform` *does* become a belief. This is an
   assumption of the library's social model, not a property of FIPA.
3. **The assumption is interruptible.** The user is entitled to withdraw it, and
   to do so at the point where the belief is written, not only by pre-filtering
   every message that might carry one.

So the default stands (accept), and the override has to be a real interception
point on the belief write — not just a predicate that decides, in advance,
whether to consult it.

This propagates: `agree`, `accept-proposal`, `cancel`, `inform-if`, `inform-ref`
and `refuse` are all defined by SC00037 in terms of `inform`, so they inherit
whatever we build here.

### Implementation

Done. The default is unchanged and now reachable from the outside.

```ts
export type BeliefMiddleware = (
  msg: Message,
  next: () => Promise<void>,
) => void | Promise<void>;
```

Express-shaped: call `next` to continue, return without calling it to cancel.
Per message rather than per belief key, so a middleware sees the whole
assertion. Async, because real authorization is — a capability service or an
external policy means I/O, and a synchronous chain pushes every caller into
blocking or fire-and-forget.

The terminal step is the write; the chain is what stands in front of it. That
is the whole design: nothing about storing moved, so withdrawing the assumption
never means reimplementing the storing.

```ts
const agent = new Agent({
  id: "qualifier",
  bus,
  planLibrary,
  middleware: [
    async (msg, next) => {
      if (!(await acl.may(msg.sender, "assert", msg.content))) return;
      await next();
    },
  ],
});
```

Decisions taken along the way, and why:

- **Express-shaped, not named `authorization`.** The point is that the user can
  interrupt the act, not that the library has an opinion about why. Naming it
  would have made a naming choice load-bearing.
- **`request` is not guarded by this.** It is a different primitive — work, not
  a proposition — and goes through `directiveMiddleware` and the refusal reasons.
  Trust in a peer's claims and willingness to do its asks are separate decisions
  and stay separate.
- **The middleware chain is the only gate.** An earlier design also carried a
  class-level `informs` policy deciding eligibility of a whole class of message.
  That was a second way to say the same thing, and it is gone: the chain
  expresses a class-level rule as one entry with the test hoisted out, so there is
  one mechanism to understand rather than two that overlap. *Superseded — see
  the `request` section for why the two chains now differ in shape.*
- **A throwing middleware cancels.** A chain that failed partway has not
  established that the rest of it should be trusted. The error is reported and
  the message dropped, rather than escaping and ending the tick.
- **Both outcomes are observable, one event per assertion.**
  `belief:accepted` carries the keys stored, `belief:rejected` the reason not
  to, so a monitor can account for what the agent was told without watching the
  belief base. Both are events rather than messages on the bus. "This assertion
  was dropped" is exactly the fact that is invisible until it matters. It is an
  event and not a message on the bus: a rejection is about *this agent's*
  reasoning and has no hearer, so publishing it as an `inform` would make it
  something a peer could subscribe to and believe — an agent holding a belief
  about its own bookkeeping, governed by the same trust assumption it applies to
  strangers. Observability goes through events; the bus is for communication.

### Next

`inform-if` and `inform-ref` are defined by SC00037 in terms of `inform`, so
they inherit everything above and should be discussed next.

---

## `confirm`

### Decision

**Assert — and that is the whole of it, because FIPA says so.**

`confirm` is one of only four primitive acts (XC00037H §5.4, alongside `inform`,
`request`, `disconfirm`). Its formal model is `<i, confirm(j, φ)> FP: Bi φ ∧
Bi(Uj φ)  RE: Bj φ`.

Compare `inform`: `FP: Bi φ ∧ ¬Bi(Uj φ)  RE: Bj φ`.

**Same rational effect.** The two differ in exactly one place, and it is a
precondition about the *sender's* belief about the *receiver's* uncertainty:
`inform` requires the sender to believe the receiver is not uncertain about φ,
`confirm` requires it to believe the receiver is. A receiver cannot verify
either claim about itself. From this side, `confirm` and `inform` are the same
act.

So `confirm` is believed as an assertion, through the same
middleware chain, and needs no branch of its own. That is not an approximation
of the specification — it is the specification, and a separate code path would
have been the inaccuracy.

DC00043B also states that whether the receiver *actually* changes its attitude
is a function of its trust in the sender, which is the `inform` decision again
by another name.

### Implementation

None required. `confirm` was already `isPropositional`, and the `inform` path
was already exact for it. Tests pin the behaviour so it cannot drift silently.

---

## `disconfirm`

### Decision

**Assert, with the polarity held false.**

*Superseded.* The first decision here was to refuse the act, on the grounds that
`Bj ¬φ` needs negation of the content and this library has no content language.
That was right about the problem and wrong about the answer: the negation does
not have to be computed, it only has to be recorded. `BeliefBase` now keeps a
`BeliefStatus` beside each value, so the sender's stance toward the content is
storable without knowing what the content means. The user owns the language;
classic-agents owns the stance. No lossy substitute — retraction — is needed.

The values are `"positive"` / `"uncertain"` / `"negative"`, **not**
`"true"` / `"false"`. The boolean-sounding names would assert that the content is
a truth-apt proposition with a truth value, which is a claim about the user's
ontology that this library has no standing to make. A key and value may denote a
proposition, a measurement, or a reading that is simply wrong. What the store
records is the stance a performative established: `inform` and `confirm` assert
their content, `disconfirm` asserts its negation. Interpreting "negative" as
*not p* needs an ontology and stays with the user.

The reasoning that led there is kept below, because it is the part worth
relearning: refusal was the fallback, not the goal.

The formal model is `<i, disconfirm(j, φ)> FP: Bi ¬φ ∧ Bi(Uj φ ∨ Bj φ)  RE:
Bj ¬φ`.

The rational effect is `Bj ¬φ`. Read that carefully: the receiver comes to
**believe the negation**. It is not `¬Bj φ` — FIPA does not say the receiver
should stop believing φ. DC00044B's example: `i` believes `j` thinks a shark is
a mammal, so `i` sends `disconfirm :content (mammal shark)` and `j` ends up
believing sharks are not mammals. A belief, formed, of the opposite thing.

Acting on this requires negating the content. `temp: 22` negated is `temp ≠ 22`,
and that needs an ontology and a proposition logic. This library has neither, and
has decided not to own them: it is a protocol layer, and `BeliefBase` is a
key/value store in which negating a value has no defined meaning.

Both available substitutes are wrong, and the second is wrong *subtly*:

- **Assert it as an ordinary proposition.** This is what the code did before.
  A peer that said "this is false" installed `msg.temp = 22` — the receiver
  believed exactly what it was told not to believe. Unambiguously broken.
- **Retract the key.** `BeliefBase.remove` exists, so this is expressible, and
  it is what people expect from the word. But it is `¬Bj φ`, a different
  proposition from the one specified. Doing it silently would claim a fidelity
  the implementation does not have, in the one place where being wrong is
  hardest to notice.

So the act is refused rather than approximated. The refusal is reported, because
an act that is understood and declined must not look like one that was never
received.

### Implementation

- `BeliefStatus = "positive" | "uncertain" | "negative"`, held beside the value
  in an envelope **inside** the store. `get`, `all()` and existing
  two-argument query predicates are unchanged, so nothing that read a belief
  before changes.
- `statusOf(key)` reads it; `set(key, value, status?)` writes it, defaulting to
  `"positive"` so every existing call site keeps its meaning; `setStatus(key, s)`
  changes it without a new claim, which is how `"uncertain"` is reachable.
- Query results carry `status`, and query predicates take it as a third
  argument — a purely additive change to the signature.
- `disconfirm` writes `status: "negative"`. Everything else propositional writes
  `"positive"`. `belief:accepted` reports the stance.
- A stance change still emits `beliefUpdated`, since "now held negatively" is a
  change to what the agent holds even though the value has not moved.
- Absence and a negative stance stay distinct: `statusOf` returning `undefined`
  is no position, `"negative"` is a position taken.
- Trust still gates it. A claim against a proposition is a claim, so the
  middleware chain applies unchanged.

Every status is a non-empty string and so is truthy, `"negative"` included.
Documented on the type, and pinned by a test, since the non-boolean names make
`if (statusOf(k))` look plausible when it is always true.

### Next

`inform-if` and `inform-ref`.

---

## `request`

### Decision

SC00037 gives `request` a compelled hearer effect but does not make it an
obligation: the receiver may decline. So the default is the cooperative one, and
it is the same default `inform` uses, applied to work instead of claims — agree
to every well-formed request the agent has a plan and capacity for, decline
otherwise. FIPA supplies no reason to be pickier, and a default agent that
refuses by default would be an agent nobody can talk to.

What the receiver may *not* assume is that the request worked. OC00018A states
the general position on rational effects, and it is the same assumption the
assertion path is built on:

> the recipient is not bound to ensure that the expected effect comes about […]
> an agent may use its knowledge of the rational effect in order to plan an
> action, but it is **not entitled to believe that the rational effect
> necessarily holds having performed the act**

So `request` gets the same treatment as `inform` — a user-supplied chain that can
interrupt — but **not the same shape**. The belief chain is `(msg, next)`; the
directive chain is `(req, res, next)`. The asymmetry follows from what each act
compels. An assertion that is not believed needs no reply, so declining is simply
not continuing and there is nothing to shape. A directive compels a hearer
effect, so declining it *is* a communicative act, and "no" without a reason is
worse than silence: the sender learns that nothing will happen but not whether the
agent could not, would not, or has no room. Hence `res`, and hence `res.refuse(verdict?, reason?)`.

`canAccept` is gone, merged into this chain. It was a second way to say "will not",
with a weaker version of what `res.refuse` now does: it could decline and carry a
reason string, but it could not rewrite the content it was judging, and it could
not be part of an ordered chain. Removing it also removed `"predicate"` from
`RefusalVerdict` — a verdict nothing produces any more is one that only makes
the vocabulary harder to read.

Two refusals are worth naming, because they are what make the default honest.
`no-plan` is asked *before* the goal is created: a request the agent could never
have served should not take a `maxGoals` slot, since with nothing able to select
a plan it would never reach a terminal status and the agent would slowly brick
itself. `capacity` is backpressure rather than a judgement, and is recoverable —
the same request offered later may be agreed.

### Side-effects on the sender's belief base

When an agent sends a `request`, it creates an `uncertain` intention belief so
it can track the job through to a verdict without guessing ids. The key is
`intent.<receiver>.<goal>`, holding the full request content, and its status
starts at `"uncertain"`. An `agree` received later promotes it to `"positive"`;
a `refuse` sets it to `"negative"`. The same helper is also called whenever an
action result contains a request message, so plan-delegated requests are tracked
the same way as direct ones.

### Implementation

- `directiveMiddleware?: DirectiveMiddleware[]`, default `[]`, runs before the
  content is parsed, before the plan check, the goal bound and the `agree`, so a
  handler can rewrite `req.content` or decline outright and short-circuit the rest
  of admission.
- `DirectiveResponse` exposes exactly one method, `refuse(verdict?, reason?)`.
  `verdict` defaults to `"middleware"`; `reason` is free text forwarded to the
  sender verbatim. It is an argument rather than a return value because the chain
  is async and ordered, and a middleware cannot hand a verdict back through
  `next()` without either wrapping the rest of the chain or giving up on it.
- `refuse` is terminal and first-reason-wins. Calling `next()` afterwards cannot
  admit the goal, so a handler that declines and then falls through by mistake
  does not quietly take the work on. Keeping the *first* reason is right because
  the handler closest to the request has the most specific view of it.
- `considerDirective` became async and is now only the chain runner; the
  admission rules moved to `admitDirective`, so the interruption point is one
  function instead of interleaved with the rules it can pre-empt. Its decision
  answers, so the runner's post-chain fallback only fires when the chain ended
  early — otherwise one request would get two refusals.
- `handleUnsupportedDirective` became `Promise<void>`, because a subclass that
  hands a performative to ordinary admission calls `considerDirective`, and that
  has to be awaited before the tick treats the message as done.
- `RefusalVerdict` is `"no-plan" | "capacity" | "unsupported" | "middleware"`.
  `"middleware"` is the one that is not a fact about the agent but a decision the
  application took, which the type's own doc says rather than leaving the app-level
  case to be inferred from the rest.
- **Cancelling answers rather than dropping.** An assertion nobody believes needs
  no reply, but a request the agent will not take is refused with
  `reason: "middleware"` and reported as `goal:refused`. A middleware that throws
  declines the same way, with the error text as the reason.

### Known gap

A request naming no goal is dropped unanswered. This is the one remaining
silence, and it is not for want of the machinery: a `refuse` must name the goal
it is refusing and there is none to name, so `declineDirective` declines to
invent one. The honest answer is FIPA's `not-understood` — the hearer was
compelled but did not grasp the content — and this library has no such act.

**When `not-understood` is implemented it must be wired into this path**, not
just added to the vocabulary: a `request` (and every other directive) whose
content the agent cannot read should be answered `not-understood` rather than
silently dropped, so the sender can always tell "not heard yet" from "heard and
not understood". A `directiveMiddleware` chain can paper over it today by
rewriting the content, but that is a per-application workaround for a library
gap, and the default path should not need it.
## `agree`

### Decision

**Assert, with no condition on the wire.**

The act is a KQML performative rather than a FIPA one — FIPA calls it
`agree :content ⟨action, φ⟩` — and the user read it as a conditional commitment,
which is right: the formal model is `⟨i, agree(j, ⟨i, act⟩, φ)⟩ ≡ ⟨i, inform(j,
Ii Done(⟨i, act⟩, φ))⟩`, FP `Bi α ∧ ¬Bi(Bifj α ∨ Uifj α)`, RE `Bj α`, where
α = `Ii Done(⟨i, act⟩, φ)`. The whole of the act is in that φ: it means *I
intend to act, but not until this holds*.

Three things follow from the formal model, and all three are honoured.

**The performer is the speaker.** The action in the tuple is `⟨i, act⟩`, not
`⟨j, act⟩` — the agent is agreeing to do the thing itself, which is what
distinguishes it from `accept-proposal`. DC00040B says so outright: "the formal
difference between the semantics of agree and the semantics of accept-proposal
rests on which agent is performing the action."

**It is an inform, so nothing is compelled.** RE is `Bj α` — the receiver comes
to *believe* `Ii Done(...)`. It does not create a goal or an intention on the
receiver, and it cannot. So receiving an `agree` must not touch the belief base
either, which is why `agree` is one of the two class-assertive performatives this
library special-cases out of assertion handling: it emits `goalAcknowledged` and
stops. Folding it into beliefs would let an unrelated plan act on a bookkeeping
message about a conversation.

**On the sender**, it promotes the intention belief `intent.<receiver>.<goal>`
from `"uncertain"` to `"positive"`. The message itself is not stored — it is a
conversation fact, and an unrelated plan must not act on it. The promotion
replaces the `uncertain` stance that was created when the request was sent, so a
plan can query whether a peer intends to achieve something without polling the
bus or guessing ids.

**A condition is optional, and the mechanism is the deferral.** "The agent
sending the agreement informs the receiver that it does intend to perform the
action, but not until the given precondition is true" — and the precondition may
be empty. The interesting content of φ is that deferring on it does not withdraw
the commitment. That is exactly what `Plan.trigger` returning `false` already
means here: not yet, re-evaluated every cycle, with the agreement already sent.

### Why φ is not on the wire

The only thing this agent defers on is its own plan's trigger, and that is
receiver-owned state re-evaluated per cycle. There is no stable proposition to
advertise, and a message carrying a snapshot of a trigger that was false at
admission would promise something the agent is not bound by. FIPA's φ is
meaningful precisely because the *sender* intends to defer on it; ours would be a
report of a fact, not a commitment.

The other half of the mechanism is also absent: DC00040B's pragmatic note says
that when the recipient wants the action performed, it should bring the
precondition about itself, by performing the necessary CA. No protocol here does
that, so advertising a condition would promise a handshake that cannot be
completed. If a plan-level *advertised* condition is ever added, it must be a
declared promise kept separate from the trigger, and the enabling protocol has to
be built with it.

### Decided against

- **Canonicalising `accept-proposal` into `agree`.** FIPA gives the two identical
  content, FP and RE, differing only in which agent acts, so folding them
  together is tempting. Rejected: `accept-proposal` belongs to the contract-net
  conversation and its content genuinely differs from ours (a proposal's action,
  not a directive's goal), so canonicalising it would let a contract-net
  acceptance be read as a request acknowledgement. That is unlike `achieve` →
  `request`, a pure legacy synonym with identical content, which is canonicalised.
- **Emitting the inform explicitly.** As with every other derived act, the
  decomposition defines the act rather than dictating the encoding. One act stays
  one message, so one request keeps one reply to correlate against.

## `refuse`

### Decision

**None: about the conversation, not the world. One message, `verdict` plus FIPA's φ.**

FIPA defines `refuse` as a composition — `⟨i, refuse(j, a, φ)⟩` disconfirms
`Feasible(⟨i, a⟩)` and informs that the action was not done and that `i` does not
intend it — and the second element is defined as "a proposition giving the reason
for the refusal", to be treated as a causal explanation. The whole act is a
permanent claim: the action is not feasible, was not done, and will not be done
because the agent does not intend to do it.

**The two wire fields follow the spec's two elements.** `verdict` is the library
addition, a closed vocabulary saying which kind of decline this is; `reason` is
φ, free text carrying the causal account. Naming them the other way round — which
is what the code did at first, with `reason` holding the category and `detail`
holding the text — puts `"capacity"` where the spec means a proposition about the
world, and makes the field named `reason` the one FIPA does not mean. `RefusalReason`
became `RefusalVerdict` and `detail` became `reason`.

**Emitted as one message, not two.** The decomposition *defines* the act; it is not
a requirement that the encoding spell it out — the same reasoning that sends
`agree` as one `agree` and not an `inform`. One act stays one message, so one
request keeps one reply, one `messageId` and one `goalRefused` event to correlate.
The cost is real and worth stating: a peer that wanted `¬I Done(a)` as a
proposition in its own belief base, a negative stance it could plan against, has
to build it from the refusal rather than read it off the wire. Emitting the pair
was the alternative, and it was declined for the correlation cost.

**Receiving it changes nothing on the receiver.** No belief, no goal, no intention — a
refusal is a decision about a conversation.

**On the sender**, it updates two beliefs. The intention belief
`intent.<receiver>.<goal>` that was created when the request went out is set to
`"negative"` — the peer does not intend to do it. An `infeasible.<receiver>.<goal>`
belief is also stored (status `"negative"`) carrying the refusal verdict and
reason, so a plan can distinguish "no room right now" from "never has a plan for
this". Both are readable with `statusOf` and `get`; absence means no request was
ever sent for that goal.

### `capacity` over-claims, and that is documented rather than fixed

FIPA's `refuse` disconfirms feasibility. `"capacity"` is not that: the action is
perfectly feasible, there is simply no room for it right now, and this agent
would agree to the same offer later. FIPA has no act for "not today", and its own
request protocol answers an unanswerable request with `refuse`, so reusing the act
is protocol-conformant — but the over-claim is genuine and a sender must read
`"capacity"` as transient while `"no-plan"` and `"unsupported"` are settled.

That split is what the vocabulary is for, and it reaches the wire: only the two
transient verdicts are reported back across it. `no-plan` and `unsupported` are
permanent facts about the *receiver*, so a peer reporting one after the fact would
be reporting a state we could not have watched change. The refusal itself is
always reported — only the verdict is filtered, never the fact of the refusal, and
a peer that names no verdict still gets one recorded for it.

### Distinct from `failure`

FIPA separates declining from failing, and so does this library: a `refuse` says
the work was never started, a `failure` says it was undertaken and could not be
completed. That is structural rather than conventional — a `failure` can only
come from an action's own return value inside an executing intention, and a
declined directive never becomes an intention. It also means `refuse` is the
correct act for the *other* refusal paths the library has: when an
`inform-if`/`inform-ref` finds its condition false, and when a `request-when` is
abandoned after the condition came true. Both must answer `refuse` rather than
`failure`, and both are unimplemented.

### Superseded naming

`reason` held the category and `detail` held the text. Renamed to `verdict` and
`reason`, and `RefusalReason` became `RefusalVerdict`, so that FIPA's φ lands on
the field the spec names.

## Noted, not decided: `cancel` is a `disconfirm`

Found while checking `refuse` against SC00037, and worth recording before
`cancel` is discussed rather than rediscovering then. Its formal model is
`⟨i, cancel(j, a)⟩ ≡ ⟨i, disconfirm(j, Ii Done(a))⟩` — the agent withdraws its
*own* intention by disconfirming the proposition that it has one.

Two consequences for the decisions above:

- It needs no primitive of its own. The stance machinery that `disconfirm`
  motivated already stores it: a withdrawn commitment is a proposition held
  **negatively**, so `BeliefStatus` is not incidental to `cancel` but load-bearing.
- It is the third act here that is a composition rather than a primitive act,
  which is why the encoding question came up for `refuse` and will come up again.
  Whether "one act, one message" holds is now decided twice consistently; the
  reasoning to reuse is the `refuse` section's, not to re-derive.
