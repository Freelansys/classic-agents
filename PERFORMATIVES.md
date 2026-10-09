# Performative Decisions

Working reference for how `Agent` reacts to each performative in the FIPA
Communicative Act Library — the 22 acts SC00037J §3 defines, and nothing else.

The vocabulary is exactly that list. `achieve` (a KQML act) and `query` were
once accepted as aliases, and `commit`, `declare`, `delegate`, `disagree`,
`invite`, `invoke`, `promise`, `query-if-known`, `sorry` and `unsubscribe` were
names no FIPA document defines; all are gone, so a message that still carries
one is answered `not-understood`, which is the correct answer to an act outside
the library. The four acts the vocabulary used to be missing — `cfp`, `propose`,
`inform-if`, `inform-ref` — are in it now, so this file covers the whole CAL.

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
| **Answer** | A directive the library answers from the receiver's own knowledge: the same `directiveMiddleware` chain, then a named proposition/expression is evaluated — no goal, no plan, no `agree`. |
| **Refuse** | A directive the library cannot honour: answered `refuse` with `verdict: "unsupported"`. |
| **Assert** | Propositional: content is offered to the belief base, filtered by the `middleware` chain. |
| **None** | Nothing. The act is about the conversation or the sender's state, not a fact to store or work to do. |

An act can be **Assert + Refuse** — the proposition is taken as believed while the
attached work is declined. `request-when` already behaves that way.

One combination is worth singling out because it *used to* be **Refuse by
default, Goal once the application opts in**. `query-if` and `query-ref` were
declined on sight, then tuned to become ordinary goals whose plans answered the
question. Now they are **Answer**: the receiver looks the named proposition
(`query-if`) or expression (`query-ref`) up in the library given at
construction, evaluates it against its own beliefs, and replies with a plain
`inform`. No goal, no plan, no middleware rewrite — the knowledge to answer is
owned by the receiver, and the wire carries only the name.

## Status

| Performative | Reaction | State |
| --- | --- | --- |
| `inform` | Assert | **Done** |
| `inform-if` | Assert | **Done** |
| `inform-ref` | Assert | **Done** |
| `confirm` | Assert | **Done** |
| `disconfirm` | Assert | **Done** |
| `query-if` | Answer (named proposition) | **Done** |
| `query-ref` | Answer (named expression) | **Done** |
| `subscribe` | Assert + Refuse | Not started |
| `request` | Goal | **Done** |
| `request-when` | Assert + Refuse | Not started |
| `request-whenever` | Assert + Refuse | Not started |
| `agree` | Assert | **Done** |
| `refuse` | None | **Done** |
| `cancel` | Assert | Not started |
| `cfp` | Refuse (`unsupported`) | Not started |
| `propose` | None | Not started |
| `accept-proposal` | None | Not started |
| `reject-proposal` | None | Not started |
| `failure` | Assert | **Done** |
| `not-understood` | Assert | **Done** |
| `proxy` | — | Not started |
| `propagate` | — | Not started |

`Not started` means no act-level decision has been agreed yet. The reaction
column still says what the vocabulary's classification alone already commits the
agent to, so a row is never blank: `subscribe` is Assert + Refuse, so its
asserted half reaches the belief base while the monitoring work is declined;
`propose` is commissive, so it is neither believed nor acted on; `cfp` is a
directive whose receiver takes on no work, so it is refused as `unsupported`
rather than read as a request. Each still owes its own section below.

---

## Correlation

How a message finds the message it answers, and how a sender tells its replies
apart. FIPA puts this on the envelope of every act — `reply-with`, `in-reply-to`
and `conversation-id` are message parameters, never content — so the framing is
shared by every performative in the file rather than owned by any of them. It
became a section of its own because two facts collided: two requests for the same
goal can end differently, and the old bookkeeping could not tell them apart.

### Decision

**The envelope, always; content, never.** `conversationId`, `replyWith` and
`inReplyTo` live on `Message` (see `MessageSchema` in `src/bus/types.ts`), and no
performative's content carries correlation. It once did: a `replyFields` object
was spread into the `agree` and `refuse` schemas so replies could echo the ids
back, and the content copies were the only ones anything read. Two homes for the
same fact is where this started failing — `Message.id` and the `messageId` inside
reply payloads were the same value under two names, and they had drifted. Content
describes what the act *means*; who is answering which message is not meaning.

**The library has an opinion; the type does not.** All three correlation
parameters are optional on `Message`, so a producer that already stamps its own
ids — or does its own thing entirely — is never forced to adopt one.
`Agent.sendMessage` and `Agent.publishMessage` nevertheless stamp `conversationId`
and `replyWith` for anything missing, so a message classic-agents sends is always
part of an exchange. Only absent values are filled in: a caller with ids that mean
something keeps them. A message that still arrives stamped with nothing works, and
simply participates in correlation only as far as it opted in.

**`reply-with` on every message we send.** Optional in FIPA, universal here.
Uniformity is the point: no code path asks whether a message is the kind that can
be replied to, and a reply can always name it back with `in-reply-to`.

**Replies inherit the exchange.** An `agree` or `refuse` answering a request
carries the request's `conversation-id` and sets `in-reply-to` to the request's
`reply-with`. So does a `not-understood` — it answers a message the sender needs
to pair, and a failing exchange needs its correlation more than a healthy one.
`GoalSource` records both on the goal, so every reply the goal produces — and
every failure and completion event whose payload carries that goal — is
correlated without the reply builder knowing which request it came from.

**`in-reply-to` only where a message was actually answered.** `in-reply-to`
names an earlier message, and it only means something to the agent that sent
that message (SC00061). So the two halves of the inherited envelope are treated
differently:

- `conversation-id` is inherited by everything a plan sends — point-to-point or
  topic, to the requester or to anyone else. It names the *thread*, not a
  message, and a decomposition stays one thread wherever it speaks: an
  announcement on a topic and a `request` to a third agent are both steps of
  the job the requester asked for, and a peer that holds the conversation can
  line them up. Each message still gets a fresh `reply-with`, so the legs stay
  distinguishable within it.
- `in-reply-to` is set only when the message answers the goal's requester —
  point-to-point to `goal.source.sender`, where it names the request's own
  `reply-with` exactly as `agree` does. To any other receiver, and to a topic,
  the hearer never sent the message being named, so it is left off rather than
  passed on as a claim about an exchange it was never part of. A topic message
  never answers the requester, even when it also names the requester as
  `receiver`: every subscriber hears it. Nor does a directive — a `request` or
  `query-if` back to the requester opens an exchange of its own instead of
  replying to the old one, so it keeps the conversation and names no message.
- An explicit `inReplyTo` on the `ActionResult` message wins over the inherited
  one. The plan may be answering something the goal's source never saw — a
  peer's earlier note, a correlation of its own — and it is the only party
  that knows.

**The sender names ids; nobody synthesizes for a peer.** Stamping is the library's
own send path filling in what its callers left blank. A receiver never invents a
referent and attributes it to a peer — that would put ids in a message the peer
did not write.

**Sender-side bookkeeping is scoped per exchange.** The beliefs a request creates —
`intent.<peer>.<goal>.<exchange>` and `infeasible.<peer>.<goal>.<exchange>`,
where `<exchange>` is the request's `reply-with` echoed back as `in-reply-to` —
are per exchange, not per goal, because a second request for the same goal can end
differently and must not rewrite the first one's record. Both are prefix-queryable
by peer and goal. A message with no ids at all degrades to the historical
goal-scoped key `intent.<peer>.<goal>`.

### Implementation

- `type Message<T>` is derived from `MessageSchema`, so the type and the
  vocabulary cannot drift, and the two-name failure is unrepresentable.
- Stamping happens in two places, `Agent.sendMessage` and `Agent.publishMessage`
  (topic traffic is stamped as much as point-to-point is), and both return the
  stamped message — a caller waiting on *this* exchange rather than the next one
  for the same goal needs the ids that were actually attached.
- `messageId` was retired as a name because it was two FIPA parameters pretending
  to be one: `reply-with` when a sender assigns it to its own message,
  `in-reply-to` when a reply echoes it back. Outgoing → `Message.replyWith`;
  provenance and events (`GoalSource`, `GoalAck`, `GoalRefusal`) → `inReplyTo`.
- `Agent.applyActionResult` builds that envelope per message from the goal's
  `source`: the conversation for all of them, `in-reply-to` only for the
  requester, and `msg.inReplyTo` last because the action's own value wins.

### Not decided here

- Nothing in correlation is left undecided. Beyond agreements and refusals,
  `not-understood` replies now inherit the conversation too: every reply names the
  message it answers (`in-reply-to`), and every notice a plan's `ActionResult`
  publishes inherits the conversation of the exchange that produced the goal
  rather than minting a fresh one — naming `in-reply-to` only when it goes to the
  requester. Failure and completion events need no ids: they carry the live goal
  with its `source`, so the consumer pairs the event to the exchange itself.

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
- **The sender may name the stance, and we check that we can map it.** The act's
  own default is what the write uses — `"positive"` for `inform`, `"negative"`
  for `disconfirm` — and a sender that wants something else says so with a
  `state` field on the content: `"positive" | "uncertain" | "negative"`, taken
  verbatim over the default. The field is validated against `BeliefStatus`
  *before* the write, and a value that is not one of the three is answered
  `not-understood`. That check is the point rather than the typing: a `state` we
  silently ignored would be indistinguishable on the receiver from one we
  honoured, so the sender would learn nothing from a message that was in fact
  malformed. `inform` can therefore carry `state: "negative"` and `disconfirm`
  can carry `state: "positive"` — the stated stance wins over the act.
  It does not widen what `middleware` gates: an explicit state rides the same
  chain, because a sender naming a negative stance is still making a claim the
  receiver is entitled to decline.
- **`state` is stored too, and that is a side effect worth knowing.** The write
  iterates the content's keys, so `state` lands in the belief base as
  `msg.state` alongside the fields it was describing:

  ```ts
  await bus.send("a1", {
    performative: "inform",
    sender: "peer",
    content: { temp: 22, state: "uncertain" },
    timestamp: Date.now(),
  });
  agent.beliefs.all();                // { "msg.temp": 22, "msg.state": "uncertain" }
  agent.beliefs.statusOf("msg.temp"); // "uncertain"
  ```

  It is harmless — one more key, holding the value the sender sent — but it
  means an assertion's own metadata is subject to the belief key function like
  everything else. `state` is not reserved against that.

---

## `inform-if` and `inform-ref`

### Spec

Both are macro acts, and SC00037J says so in as many words. `inform-if` is
defined as a disjunction:

`⟨i, inform-if(j, φ)⟩ ≡ ⟨i, inform(j, φ)⟩ | ⟨i, inform(j, ¬φ)⟩`

— two possible courses of action, informing φ or informing ¬φ — and
`inform-ref` the same over its referents:

`⟨i, inform-ref(j, Ref x δ(x))⟩ ≡ ⟨i, inform(j, Ref x δ(x) = r₁)⟩ | … | ⟨i,
inform(j, Ref x δ(x) = rₖ)⟩`.

The spec then draws the consequence itself: "macro acts can be planned and
requested, but not directly performed." There is no third wire message. The
content of an `inform-if` is just φ — the same φ a plain `inform` of φ carries
— and what distinguishes the family is which member of the disjunction the
sender chose, a fact about the sender rather than about the content.

### Decision

**The library never emits either; a received one is treated as the `inform` it
abbreviates.**

Never emits. No code path in classic-agents derives an `inform-if` or an
`inform-ref` as a message it sends, and the macro's own expansion rule is what
the result had to be: the plan that would "send inform-if" already knows which
side of φ it is on, and sends that `inform`. `queueOutcome` answers goals with
`inform` or `failure`, a query's answer is `inform`, and the refusal
and failure paths name their own acts. Nothing is left over wishing it were a
macro.

Treated as `inform` on receipt. They are assertives, so their content is
offered to the belief base under the `middleware` chain on exactly `inform`'s
terms — no goal, no refusal — and the optional `state` field is validated the
same way, an invalid one answered `not-understood` naming the performative that
carried it. That is the expansion, applied by the receiver: `inform-if`
received with content φ is φ's claim, believed or not on the same terms as any
other assertion. Declining a peer for choosing the abbreviated name instead
would discard the assertion it stands for while leaving the identical `inform`
untouched — a distinction with no referent on the wire.

An application may still author one directly through `sendMessage`; the
vocabulary accepts all 22 acts. The decision is about what the library itself
derives, and there the answer is nothing: a macro is planned and requested,
never performed, and this library performs acts.

### Implementation

- In the vocabulary as assertives, and `isPropositional` is true for both, so
  `reviseBeliefs` offers their content to the belief base with no special case.
- `hasAssertionSchema` covers both alongside `inform`, `confirm` and
  `disconfirm`: an explicit `state` that is not a `BeliefStatus` is answered
  `not-understood` with `assertionStateReason`, exactly as `inform`'s is.
- Perception is pinned by a test that believes both; the state path by one that
  not-understands both, over the same loop as every other schema-checked
  assertion.

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
  `"positive"`. `belief:accepted` reports the stance. These are *defaults*: a
  sender may override either with an explicit `state` on the content, which
  makes `disconfirm` able to arrive positive and `inform` able to arrive
  negative — see the `inform` section.
- A stance change still emits `beliefUpdated`, since "now held negatively" is a
  change to what the agent holds even though the value has not moved.
- Absence and a negative stance stay distinct: `statusOf` returning `undefined`
  is no position, `"negative"` is a position taken.
- Trust still gates it. A claim against a proposition is a claim, so the
  middleware chain applies unchanged.

Every status is a non-empty string and so is truthy, `"negative"` included.
Documented on the type, and pinned by a test, since the non-boolean names make
`if (statusOf(k))` look plausible when it is always true.

---

## `query-if` and `query-ref`

### Spec

`query-if` asks the receiver whether a proposition is true: `⟨i, query-if(j, x,
φ)⟩`, where x is referenced by a descriptive term and φ is a proposition about
it. SC00037J decomposes it as a request to perform `inform-if` — but its
rational effect, the act that actually occurs when the query is answered, is
`Done(⟨j, inform(i, φ)⟩ | ⟨j, inform(i, ¬φ)⟩)`: a plain `inform` of φ or of
its negation.

`query-ref` asks for the object matching a descriptor rather than a truth value:
`⟨i, query-ref(j, x, e)⟩` where e is the expression to be evaluated, likewise
decomposed as a request to perform `inform-ref`, with rational effect
`Done(⟨j, inform(i, e = r₁)⟩ | … | ⟨j, inform(i, e = rₖ)⟩)` — an `inform`
naming the referent.

Both are directives: the sender wants something done, and the receiver is free
to `refuse`. The difference from `request` is only in what was asked for.

### Current

A query is a directive **answered from the receiver's own knowledge**: `query-if`
names a **proposition**, `query-ref` names an **expression**, and the receiver
evaluates it against its own beliefs and the message that asked. The content is
a single name — the performative already says which library answers:

```ts
{ name: "raining" }        // query-if
{ name: "warmest-room" }   // query-ref
```

The name travels the bus; the implementation stays with the receiver, in the
`propositionLibrary` (`query-if`) or `expressionLibrary` (`query-ref`) chosen at
construction. `evaluate` may be sync or async, so a proposition is free to
consult a model or a service before answering.

### Question

The proposition φ and the expression e are opaque to the protocol layer.
Interpreting them needs an ontology this library does not own. The answer is to
name: the receiver owns the implementation behind the name, and the message
delivers the whole context the evaluation may need — its content carries the
particulars the condition ranges over, and the sender's identity and correlation
are on the envelope.

### Decision

**A query is answered, not worked.** It runs the same {@link DirectiveMiddleware}
chain as a request — an application may decline who gets to ask — and then the
named proposition or expression is evaluated against the agent's live beliefs.
No goal is created: nothing is agreed, nothing is queued, and the goal bound is
never consulted, because answering a question is not taking on work. It is also
never `capacity`-shed, and there is no plan lookup to fail.

The ontology objection is real but it answers itself: it is *why* the wire
carries a name, and why evaluating is the receiver's job. `request-when` fails
because its condition cannot cross a JSON bus as a predicate — there is nothing
a receiver could compute on. A query's name *can*: both agents agree what
"raining" means, the receiver keeps the computation, and the sender asks for it
by name. Nothing in classic-agents parses φ or e; everything routes the name to
a library entry the receiver owns.

**An unregistered name is `not-understood`.** "I do not know that condition" is
the honest answer, and it is how the sender tells a name the receiver cannot
read from one it read and found false — `not-understood`, not an `inform` with
`result: false`. Nothing is refused: a query the agent cannot *read* is not a
query it decided *not to answer*.

**The answer goes on the wire as an `inform`.** That is a decision, not an
accident of the current code. SC00037J makes the *requested* act
`inform-if`/`inform-ref` — the equivalence above is the request naming them —
but gives both queries the rational effect of a plain `inform`: φ or ¬φ for
`query-if`, the referent identity `e = r` for `query-ref`, and the CAL's worked
examples reply with `inform` accordingly. FIPA's query interaction protocol
draws the same reply, and JADE — whose responder answers `fipa-query` with the
same machinery as `fipa-request` — never produces `inform-if`/`inform-ref` at
all, though the constants sit in `ACLMessage`. The rational effect is what a
query is *for*; the requested act is how the request names it. This library
answers the question, and an `inform` carrying `{ name, result }` — the name
that was asked, and the value of the evaluation — says which one it answers.
This settles the reply act only; whether the macros themselves ever appear on
the wire is the `inform-if`/`inform-ref` decision, and it says they do not — not
from this library.

### Implementation

- In the vocabulary as directives, but **not** in `ACTION_DIRECTIVES`;
  `isQueryDirective` classifies them, `directivePriority` returns nothing for
  them (a priority promises a goal, and a query creates none).
- **`queryContentSchema` is `{ name: string }`** — one schema for both queries,
  checked by `hasContentSchema`, so a query with no name is answered
  `not-understood` as a schema violation.
- `reviseBeliefs` routes a query through `considerDirective`, so the
  `directiveMiddleware` chain runs; the terminal step then branches: a query is
  answered by {@link answerQuery}, only a request goes on to `admitDirective`.
- `answerQuery` awaits `propositionLibrary.evaluate` (`query-if`) or
  `expressionLibrary.evaluate` (`query-ref`) with the agent's live beliefs and
  the message itself, so an async body (a model, a service) is awaited like any
  other. An `undefined` result — an unregistered name — is `not-understood`;
  otherwise the `inform` inherits the exchange, `conversationId` and
  `inReplyTo` from the question, so the peer that asked can pair it up.

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
`intent.<receiver>.<goal>.<exchange>`, holding the full request content, where
`<exchange>` is the request's `replyWith` — the id the reply will name back as
its `inReplyTo`. Status starts at `"uncertain"`. An `agree` received later
promotes it to `"positive"`; a `refuse` sets it to `"negative"`. The same helper
is also called whenever an action result contains a request message, so
plan-delegated requests are tracked the same way as direct ones.

Scoping the record to the exchange keeps concurrent requests for the same goal
independent: a second request that is refused cannot rewrite the first one's
agreement. Every exchange for a peer and goal is readable with
`queryByPrefix("intent.<receiver>.<goal>.")`, and a message that names no ids at
all — a producer that opts out of correlation — degrades to the historical
goal-scoped key `intent.<receiver>.<goal>`.

### The terminal reply

`agree` is a commitment, and FIPA's request interaction protocol (SC00026) says
what discharges it: a receiver that sends `agree` must later send exactly one
`inform` (the action is done) or `failure`. Without that rule a requester whose
work failed — or whose plan reported nothing at all — waits on a silence it
cannot tell apart from a lost message.

So the reply is the *goal's* answer, not the plan's. It is taken from the goal's
terminal transition — `achieved`, `failed`, `dropped` — which is the one point
every way a goal can end passes through: an action returning `failure`, an
action throwing, a sub-goal failing and its parent failing with it, a goal
dropped because something it `dependsOn` failed. A plan is not required to know
the protocol, and a plan that throws has no chance to answer it.

Three rules keep one request to one reply:

- **Root goals only.** A sub-goal inherits `source` so it can be traced, but its
  requester is whoever asked for its parent, and a chain of decomposed work
  would otherwise put a reply on the wire per level. Only the goal the
  directive created answers.
- **Agreed goals only.** The reply is owed by `agree`, so a request declined
  before a goal existed — `no-plan`, `capacity`, a chain that said no — is
  answered by its `refuse`, and nothing follows it.
- **Once.** An exchange already answered terminally is not answered again. A
  plan can answer it itself through `ActionResult.messages`, with a message
  addressed to the requester that answers this request — its `inReplyTo` is
  the request's, which is what it inherits unless the plan names another
  message. A `failure` closes the exchange outright. An `inform` stands in for
  the automatic one only if the goal is achieved: which of a plan's messages
  was the outcome is only known once the goal ends, and a plan that reports
  progress and then fails still owes the requester its `failure`.
- **Removed goals answer too.** An agreed goal taken out of the queue before it
  finished, with `goals.remove()`, is answered `failure` with
  `reason: "goal removed before it finished"`: no terminal transition is coming
  that would answer it.

Stopping the agent is not an ending. `stop()` pauses: goals, intentions and the
requests agreed to are kept, and a restarted agent answers each when its goal
ends. An application stopping an agent for good owes those answers itself, for
example by removing the open goals and running one more tick.

The content is `{ goal, goalId, done: true }` for the `inform` and
`{ goal, reason }` for the `failure`, where `reason` is what the action threw or
reported, or `dropped: dependency "…" failed` for a goal that never ran.
Correlation comes from the goal's `source`: the reply carries the request's
`conversationId` and names the request as `inReplyTo`, so it pairs against
exactly the message the `agree` did.

Both are queued and sent from the tick, after the cycle's `agree` and `refuse`
have gone out, so a reply never leaves from inside an action or from inside the
sender's `publish`. Every agreed goal is worked: a plain request carries no
condition, so there is no "still waiting" state that would leave a commitment
open without an answer.

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
- **Closing the exchange.** `flushTerminalAnswers` sends the `inform` or
  `failure` owed for every agreed goal that reached a terminal status this
  cycle, from `openRequests` — the record of what this agent agreed to and has
  not yet answered. `openRequests` is opened with the `agree`, closed by the
  goal's terminal transition, by a refusal, or by a terminal reply the plan sent
  itself, and dropped with the goal, so it is bounded by the work in flight.

### Wiring `not-understood` for malformed content

A request naming no goal used to be dropped unanswered — the one remaining
silence in the library. A `refuse` must name the goal it is refusing and there
is none to name, so `declineDirective` declined to invent one. The honest answer
is FIPA's `not-understood` — the hearer was compelled but did not grasp the
content — and this library now sends it.

Schema validation runs after the `directiveMiddleware` chain has had a chance
to repair the content, so a middleware that rewrites a missing goal name still
works. If the content remains malformed after the chain, the agent publishes
`not-understood` back to the sender with a reason describing which field was
missing or wrong. The same validation applies to `agree` (requires `goalId`)
and `refuse` (requires `goal`).

Assertions (`inform`, `confirm`, `disconfirm`, etc.) have no required fields
and are not schema-checked: the belief base stores whatever content arrives,
filtered only by `middleware`.

---

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
stops. Folding it into beliefs would put a conversation fact into the belief
base, where plans read world state.

**On the sender**, it promotes the intention belief
`intent.<receiver>.<goal>.<exchange>` from `"uncertain"` to `"positive"`, where
`<exchange>` is the `replyWith` of the request being acknowledged and arrives
back as the reply's `inReplyTo`. The message itself is not stored — it is a
conversation fact, and an unrelated plan must not act on it. The promotion
replaces the `uncertain` stance that was created when the request was sent, so a
plan can query whether a peer intends to achieve something without polling the
bus or guessing ids.

**A condition is optional, and this library never has one.** "The agent sending
the agreement informs the receiver that it does intend to perform the action,
but not until the given precondition is true" — and the precondition may be
empty. The interesting content of φ is that deferring on it does not withdraw
the commitment. A plain `request` is the empty case: unconditional, so the action
begins on the next cycle and the `agree` carries nothing. A non-empty φ belongs
to `request-when`, whose *sender* names it.

### Why φ is never on the wire

The library has no φ to send. A `request` is unconditional, so its `agree` needs
none; and `request-when`, which does carry a condition, is not implemented — the
condition cannot cross a JSON bus as a predicate, so the library refuses it as
`unsupported` rather than guessing at one. When a plan gates its own work on a
belief, that is a deferral the *receiver* invented, not one the sender asked for,
so reporting it back would promise a condition the requester never named and
cannot bring about.

The other half of the mechanism is also absent: DC00040B's pragmatic note says
that when the recipient wants the action performed, it should bring the
precondition about itself, by performing the necessary CA. No protocol here does
that, so advertising a condition would promise a handshake that cannot be
completed. If `request-when` is ever implemented, the condition it carries must
be an explicit, serializable proposition the sender named — a declared promise,
with the enabling protocol built alongside it.

### Decided against

- **Canonicalising `accept-proposal` into `agree`.** FIPA gives the two identical
  content, FP and RE, differing only in which agent acts, so folding them
  together is tempting. Rejected: `accept-proposal` belongs to the contract-net
  conversation and its content genuinely differs from ours (a proposal's action,
  not a directive's goal), so canonicalising it would let a contract-net
  acceptance be read as a request acknowledgement. There is no synonym left to
  compare it with either: the library's own aliases, `achieve` and `query`, were
  retired with the rest of the non-FIPA vocabulary.
- **Emitting the inform explicitly.** As with every other derived act, the
  decomposition defines the act rather than dictating the encoding. One act stays
  one message, so one request keeps one reply to correlate against.

---

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
request keeps one reply, one `inReplyTo` and one `goalRefused` event to
correlate.
The cost is real and worth stating: a peer that wanted `¬I Done(a)` as a
proposition in its own belief base, a negative stance it could plan against, has
to build it from the refusal rather than read it off the wire. Emitting the pair
was the alternative, and it was declined for the correlation cost.

**Receiving it changes nothing on the receiver.** No belief, no goal, no intention — a
refusal is a decision about a conversation.

**Sent only for a root goal.** A sub-goal inherits its parent's `source`, so the
sender it would name is the one already holding an `agree` for the goal it did
ask for — and `refuse` declines a request that has *not* been agreed to, so
after `agree` the only negative ending left is `failure` (SC00026). A sub-goal
with no plan, or shed by the queue's bound, is therefore reported locally as
`goal:refused` / `goal:rejected` and fails its waiting parent; the cascade runs
up to the root goal, and that is what puts the requester's single `failure` on
the wire. A root goal refused at admission never had an `agree`, so it is
refused exactly as before.

**On the sender**, it updates two beliefs. The intention belief
`intent.<receiver>.<goal>.<exchange>` that was created when the request went out
is set to `"negative"` — the peer does not intend to do it. An
`infeasible.<receiver>.<goal>.<exchange>` belief is also stored (status
`"negative"`) carrying the refusal verdict and reason, so a plan can distinguish
"no room right now" from "never has a plan for this". Both are readable with
`statusOf` and `get`; absence means no request for that exchange was ever
answered.

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
completed. That is structural rather than conventional — a `failure` reports work
that exists as an intention or as an agreed goal, and a declined directive never
becomes either. It also means `refuse` is the correct act for the *other*
refusal paths the library has: when an `inform-if`/`inform-ref` finds its
condition false, and when a `request-when` is abandoned after the condition came
true. Both must answer `refuse` rather than `failure`, and both are unimplemented.

### Superseded naming

`reason` held the category and `detail` held the text. Renamed to `verdict` and
`reason`, and `RefusalReason` became `RefusalVerdict`, so that FIPA's φ lands on
the field the spec names.

---

## `failure`

### Decision

**Assert.** `failure` is an expressive in the CA taxonomy — the sender reports a
state of its own — but its rational
effect is `Bj α` — the same form as `inform`. The sender reports that it attempted
an action and did not succeed, and the content carries φ as the reason. The
receiver decides whether to believe it under its `middleware` chain, exactly as
for any other assertion.

Two things are stored on receipt:

- The standard assertion path runs, so the content fields land in the belief base
  under `msg.*` keys (or whatever `beliefKey` is configured to). Middleware and
  the `belief:accepted` / `belief:rejected` events fire as they do for every other
  inform.
- A semantic record is stored at `failed.<sender>.<goal>` (status `"positive"`)
  carrying the reason, so a plan can query what other agents have failed on and
  why without parsing raw message content. The key is namespaced under the sender
  so a monitor holding one belief per agent never overwrites another.

The `goal` field in the content is required for the semantic record; without it
the standard assertion path still runs and stores `msg.goal` and `msg.reason`.

### Sent by the reasoner, not only by the plan

A `failure` is also this library's own answer to a request it agreed to. FIPA's
request protocol requires exactly one terminal reply after `agree`, and a plan
that throws — or that fails deep inside a decomposition — cannot send one, so
the agent sends it from the goal's terminal transition instead:

- the content is `{ goal, reason }`, where `reason` is what the action threw or
  reported, what a parent said about the sub-goal that sank it, or
  `dropped: dependency "…" failed` for a goal that never ran because what it
  `dependsOn` failed;
- it is sent only for a **root** goal that came from a directive, so sub-goal
  outcomes stay local;
- it carries the request's `conversationId` and `inReplyTo`, so the requester
  pairs it with the request the `agree` named;
- it is not sent when the plan already answered the request with its own
  `failure` — a plan's own `inform` does not count, since the goal failed
  afterwards — and never for a request that was
  refused rather than agreed to — that one was already answered by `refuse`.

See `request` → *The terminal reply* for the whole contract.

### Side-effects on the receiver's belief base

```typescript
// On receiving a failure from "worker" about goal "deploy":
agent.beliefs.get("msg.reason");                          // "503 from registry"
agent.beliefs.get<{ reason?: string }>("failed.worker.deploy");
// { reason: "503 from registry" }
agent.beliefs.statusOf("failed.worker.deploy");           // "positive"
```

---

## `not-understood`

### Decision

**Assert.** Like `failure`, `not-understood` is an `inform` at heart: its
rational effect is `Bj α`, where α identifies an event j performed and claims i
perceived it but could not make sense of it. The content carries the offending
event and an explanatory reason φ.

Two things are stored on receipt:

- The standard assertion path runs, so the content fields land in the belief base
  under `msg.*` keys. Middleware and events fire as for any other inform.
- A semantic record is stored at `not-understood.<sender>.<event>` (status
  `"positive"`) carrying the reason, so a plan can query what messages or actions
  another agent could not interpret.

The `event` field in the content is required for the semantic record; without it
only the standard assertion path runs.

### Side-effects on the receiver's belief base

```typescript
// On receiving a not-understood from "peer" about event "query-if":
agent.beliefs.get("msg.reason");                          // "unknown ontology"
agent.beliefs.get<{ reason?: string }>("not-understood.peer.query-if");
// { reason: "unknown ontology" }
agent.beliefs.statusOf("not-understood.peer.query-if");   // "positive"
```

---

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
