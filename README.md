# classic-agents

A classical Belief-Desire-Intention (BDI) agent framework for TypeScript.

classic-agents enables agent-oriented programming where agents maintain an explicit belief base, select among desires/goals, and execute intentions via a plan library. The reasoning cycle is deterministic and inspectable.

## Install

```bash
npm install classic-agents
```

## Architecture

### The BDI Reasoning Cycle

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

### Package Layout

The code is organized into namespaced modules, exposed as subpath exports:

```
src/
├── index.ts         classic-agents              — main entry: core + bus
├── bus/             classic-agents/bus          — MessageBus interface + InMemoryMessageBus
├── core/            classic-agents/core         — Belief base, goals, plans, intentions, reasoning cycle
├── testing/         classic-agents/testing      — helpers for unit-testing your own plans
└── examples/        (not exported) — runnable demo agents
tests/                                         — all unit + integration tests
```

Import styles:

```typescript
import { Agent, InMemoryMessageBus } from "classic-agents"; // main entry (core + bus)
import { GoalQueue } from "classic-agents/core"; // core only
import { InMemoryMessageBus } from "classic-agents/bus"; // transport layer
import { runAction } from "classic-agents/testing"; // test helpers
```

### `classic-agents/bus`

Transport-agnostic message bus interface. Supports both point-to-point (`send`/`registerAgent`) and pub/sub (`publish`/`subscribe`) patterns. Ships with `InMemoryMessageBus`, for agents in one process. A transport across processes — Redis, NATS, a message broker — is yours to own: implement the `MessageBus` interface (four methods) over whatever your infrastructure already runs. The library deliberately ships none, so it carries no client dependency you may not use.

An agent can subscribe to topics with `agent.subscribe(topic)`. Published messages are drained into the agent's mailbox on the next `tick()` and processed identically to point-to-point messages. The returned function unsubscribes; subscriptions survive `stop()`/`start()` restarts.

Actions publish by setting `topic` on an entry in their result's `messages` (routed via `bus.publish`); point-to-point delivery uses `receiver` (routed via `bus.send`). `src/examples/` holds runnable demos — see [Quick Start](#quick-start).

#### Messaging Protocol (FIPA-ACL)

Messages carry a performative: a speech act typing what the sender is doing to
the conversation. The library groups performatives into **communicative-act
classes** to decide how an agent reacts. The classes are Searle's
illocutionary classes as this library applies them, not a FIPA table:
SC00037J defines each act by its own formal model and only calls `inform` an
"assertive" and `request` a "directive" in passing.

| Class | Performatives | What the receiver is asked for |
|-------|---------------|---------------|
| **Assertive** | `inform`, `inform-if`, `inform-ref`, `confirm`, `disconfirm`, `failure`, `not-understood`, `agree`, `subscribe`, `request-when`, `request-whenever` | nothing — FIPA's rational effect is that it believes the content, but that is the sender's aim; the receiver decides |
| **Directive** | `request`, `query-if`, `query-ref`, `request-when`, `request-whenever`, `subscribe`, `cfp`, `proxy`, `propagate` | the receiver is asked to act — or, for the queries, to answer from its own knowledge |
| **Declarative** | `cancel` | the sender brings the proposition about |
| **Expressive** | `refuse`, `reject-proposal`, `agree`, `cancel`, `disconfirm`, `failure` | *none* — the sender reports a state of mind |
| **Commissive** | `accept-proposal`, `propose` | *none* — the sender commits to a future action |

`propagate` and `proxy` are directives too — each asks the receiver to forward
a message — but this release implements no forwarding. Following JADE and
SPADE, which carry the two acts without implementing them, the base agent
answers `refuse { verdict: "unsupported" }` rather than forwarding. The plan
for supporting `proxy` is in [PROXY.md](PROXY.md).

This is the complete [FIPA Communicative Act
Library](https://www.fipa.org/specs/fipa00037/) — all 22 acts, in the order the
spec gives them. Nothing outside it is accepted: the vocabulary once also
carried `achieve` (a KQML act) and `query` as aliases, plus a tail of names no
FIPA document defines. All are gone, and a message that still uses one is
answered `not-understood`. The performatives are typed, so a name outside the
list is a compile error rather than a runtime surprise. What a receiver *does*
about a given class is the library's reaction — see
[Standing Directives](#standing-directives-request-when-request-whenever-subscribe)
and [Directives the Agent Cannot Act On](#directives-the-agent-cannot-act-on).

**The distinction that matters: an assertion compels nothing.** FIPA's rational
effect for `inform` is that the receiver comes to believe it, but a rational
effect is what the sender intends, not a duty on the receiver, so becoming a
belief is the receiver's decision. The default is to accept: content keys land in the belief
base under `msg.<key>`, and no configuration is required to get it. A user who
wants something else says so with `middleware`, below — there is no second knob
for the same decision.

**Trust is the default, and it is interruptible.** classic-agents assumes agents
are trustworthy and cooperative, so an unconfigured agent believes what it is
told. That is an assumption about the social world, not a guarantee FIPA makes:
`inform` compels nothing, and the cooperative peer who *would* update is a
presupposition rather than a rule. A user who does not hold it needs an
interruption point on the write itself, not a filter bolted on the front — which
is what `middleware` is:

```typescript
const agent = new Agent({
  id: "qualifier",
  bus,
  planLibrary,

  middleware: [
    // Express-shaped: call next() to continue, or return without calling it to
    // cancel. Runs per message, so it sees the whole assertion.
    async (msg, next) => {
      if (!(await acl.may(msg.sender, "assert", msg.content))) {
        return; // no belief is written
      }
      await next();
    },
  ],
});
```

Empty by default, which means the write happens. The chain is async because real
authorization is: checking a capability service is I/O, and a synchronous chain
would push every caller into blocking or fire-and-forget. The chain is the only
gate: a class-level rule is just the same entry with the test hoisted out, and a
message stopped anywhere in it is reported as a `belief:rejected` event.

The assertion chain and the directive chain are separate lists, and the split
is deliberate. Trusting a peer's *claims* and agreeing to its *work* are
different decisions, and an application frequently wants one without the other —
see [`directiveMiddleware`](#work-is-guarded-too) for the second.

A write stopped by either is reported as a `belief:rejected` event:

```typescript
agent.on("belief:rejected", ({ agentId, reason, message }) => {
  logger.warn({ agentId, reason, from: message.sender }, "assertion not believed");
});
```

It is an event rather than a message on the bus deliberately. A rejection is a
fact about *this* agent's reasoning, not anything communicated to anyone: there
is no hearer and no performative in it. Publishing it as an `inform` would have
made it something a peer could subscribe to and believe — and an agent that did
would then hold a belief about its own bookkeeping, governed by the same trust
assumption it applies to strangers. Observability goes through events; the bus is
for communication and nothing else.

A directive asks the receiver to act rather than to believe, so its content
never becomes a belief. A `request` becomes a goal: it expects
`{ goal: "goalName" }` in content, and an `agree` goes back to the sender naming
the id actually assigned. Queries and standing directives take their own paths,
described below.

### Work is guarded too

A `request` is not obliged, only compelled to be noticed, and the agent's default
is the cooperative one: agree to every well-formed request it has a plan for and
capacity to take. `directiveMiddleware` is where a user withdraws that.

Note the **three** arguments. The belief chain takes `(msg, next)` because an
assertion that is not believed needs no reply — declining is just not continuing.
A directive compels a hearer effect, so declining it is itself a communicative
act, and "no" without a reason is worse than silence: the sender learns that
nothing will happen but not whether the agent *could not*, *would not*, or *has
no room*. Hence `res`:

```typescript
const agent = new Agent({
  id: "worker",
  bus,
  planLibrary,

  directiveMiddleware: [
    async (req, res, next) => {
      if (!(await acl.may(req.sender, "request", req.content))) {
        res.refuse("middleware", "sender not permitted to direct me");
        return;
      }
      await next();
    },
  ],
});
```

`res.refuse(verdict?, reason?)` sets the answer. `verdict` is from the fixed
`RefusalVerdict` vocabulary and defaults to `"middleware"`, meaning the
application declined rather than the agent lacking something; `reason` is FIPA's
φ, free text forwarded to the sender verbatim, and is where the explanation a user
actually wants to read goes. Name a different verdict when the chain knows more —
`res.refuse("capacity", …)` to shed load before the queue is consulted.

It is terminal: once called the goal is not admitted, whatever the rest of the
chain does, so calling `next()` afterwards is harmless but will not admit the
work. The first reason given is kept, since the handler closest to the request
has the most specific view of it.

The chain runs before the content is parsed — so a handler can rewrite
`req.content`, including to supply a goal name a malformed request omitted — and
before the plan check, the goal bound and the `agree`, so a decline short-circuits
all of them.

Cancelling without calling `next` also answers, with `verdict: "middleware"` and
`reason: "cancelled by middleware"` — no verdict is available, because a handler
that simply stops said nothing about why, but the text still is what separates a
deliberate cancel from a chain that fell off the end. A middleware that throws
declines the same way, with the error text as the reason. Either way it is
reported as `goal:refused`.

A directive whose content is still malformed once the chain has had its chance —
most commonly a request that names no goal — is answered `not-understood`, with
the schema violation as the reason. This is FIPA's own answer for "the hearer was
compelled but did not grasp the content", and it is distinct from a `refuse`,
which says the content was understood and declined.

```typescript
// What each performative does, in one table.
import { directsAction, isPropositional } from "classic-agents/bus";

directsAction("request");        // true   → becomes a goal
directsAction("subscribe");      // false  → asks you to monitor, not to act
isPropositional("inform");       // true   → eligible for the belief base
isPropositional("failure");      // true   → a claim about what happened; filed under its exchange when it answers a request
isPropositional("inform-if");    // true   → the conditional is still an assertion
```

A performative can be both classes at once. `request-when`, `request-whenever`
and `subscribe` are directives, and assertives too, since SC00037J defines them
as an `inform` of the sender's intention. But what
they assert is the sender's *intention* that the receiver act or report, not
their content, so a directive's content never reaches the belief base. They are
honoured as directives; see
[Standing Directives](#standing-directives-request-when-request-whenever-subscribe)
below.

An `agree` or `refuse` answering a directive is the one special case. An
`agree` is class-assertive, so on class alone it would be propositional and
believed like any other assertion. But both are bookkeeping — facts about a
conversation, not about the world. An `agree` emits `goalAcknowledged` and a `refuse` emits
`goalRefused`, and neither creates a belief, goal or intention, since folding
them into beliefs would let an unrelated plan act on a bookkeeping message. A
`confirm` that is *not* an answer to a directive is an ordinary assertion, and
is believed as one — see below for why that is exact rather than approximate.

### `confirm` and `disconfirm`

FIPA has exactly four *primitive* communicative acts: `inform`, `request`,
`confirm` and `disconfirm`. Everything else in the 22 is derived from them.

`confirm` needs no special handling, and that is worth being precise about
rather than leaving as a coincidence. SC00037 gives it the rational effect
`Bj φ` — the receiver comes to believe φ — which is **identical** to `inform`'s.
The acts differ only in a sender-side precondition: `inform` requires the sender
to believe the receiver is *not* uncertain about φ, `confirm` requires it to
believe the receiver *is*. A receiver cannot check either claim about itself, so
from this side the two are the same act. `confirm` is therefore believed
exactly as `inform` is, and goes through the same `middleware` chain.

`disconfirm` is implemented, and it took a change to the belief store to do it.

SC00037 gives it the rational effect `Bj ¬φ` — the receiver comes to *believe
the negation*. Not `¬Bj φ`; it does not say the receiver should stop believing
φ. DC00044B's example: `i` believes `j` thinks a shark is a mammal, so `i`
sends `disconfirm :content (mammal shark)` and `j` ends up believing sharks are
not mammals. A belief, formed, of the opposite thing.

Representing that means negating the content, and negation lives in an ontology
and a proposition logic — which this library deliberately does not own. It is a
protocol layer. So the split is drawn where it can be drawn honestly:

- **The user owns the language.** Which key and value denote which proposition
  is theirs; `beliefKey` already lets them choose the naming.
- **classic-agents owns the stance.** Alongside each value the store keeps a
  `BeliefStatus`: `"positive"`, `"uncertain"` or `"negative"`.

The words are deliberately not `"true"`/`"false"`. Those would assert that the
content is a truth-apt proposition with a truth value — a claim about your
ontology that this library has no standing to make. A key and value might denote
a proposition, or a measurement, or a reading that is simply wrong; the store
holds all three identically. What it records is the *stance* the performative
established: `inform` and `confirm` assert their content, so it is held
positively; `disconfirm` asserts its negation, so it is held negatively.

Reading "negative" as *not p* needs an ontology, and that stays with you.
classic-agents knows the sender took the opposite stance, not what the opposite
of `temp: 22` happens to be.

`disconfirm` is then a write held negatively — the key is still there, still
named the same content, with the sender's stance recorded against it:

```typescript
agent.beliefs.statusOf("msg.temp");        // "negative"
agent.beliefs.get("msg.temp");            // 22 — the value is untouched
agent.beliefs.query((_k, _v, status) => status === "uncertain");
```

Two things follow from keeping the envelope inside the store rather than in the
value:

- `get` and `all()` still return bare values, so nothing that read a belief
  before changes. Polarity is asked for separately, or filtered in a query — a
  query predicate gained a third argument, and two-argument predicates still
  work.
- **Absence and a negative stance are different.** `statusOf` returning
  `undefined` means no position is held at all; `"negative"` is a position
  taken. A `disconfirm` leaves the key in place, and a later `inform` flips it
  back to positive.

Two caveats worth stating. `"negative"` is a non-empty string and therefore
truthy, so `if (statusOf(k))` is always true — compare against the value and let
the union type's exhaustiveness catch the rest. The non-boolean names make that
easier to get wrong rather than harder, since nothing about
`"positive"`/`"negative"` suggests falsiness. And no message carries a stance:
FIPA's `inform` requires its sender to believe what it says, so the receiver
derives the stance from the act, and nothing on the wire produces
`"uncertain"`. It is the agent's own mark for what it does not yet know: a
request not yet agreed to, or a query not yet answered.

**Questions this agent asks.** Every `query-if` or `query-ref` an agent sends
opens `answer.<peer>.<name>.<exchange>` as `"uncertain"`, where `<exchange>` is
the query's `replyWith`. The answer settles it with the result, held positive:
a `query-if` answered `false` is `false`, held positive, meaning "it does not
hold". A refusal, failure or `not-understood` removes it and records why at
`unanswered.<peer>.<name>.<exchange>`. See PERFORMATIVES.md › *Stance and the
answers to queries*.

**A query reads; a request computes.** A proposition or expression must be a quick read of what the agent already knows. It may be async because the belief store may live in a database or a file, not so it can do work. That is what lets queries be answered outside the goal queue, so a busy agent stays queryable. An answer that takes real work — a service, a model, another agent, several steps — belongs in a plan the asker invokes with a `request`; the plan sets `ActionResult.result`, and the final `inform { goal, goalId, done: true, result }` carries it back. Evaluations are still bounded as a safety net: `evaluationTimeoutMs` each, and `maxConcurrentEvaluations` at once, past which a query is refused with `verdict: "capacity"`.

**Queries only work between agents that share names.** FIPA's `query-if`
carries a proposition as its content (in SL, say), and `query-ref` a
referential expression. This library has no content language, so a query names
a proposition or expression the receiver has registered: `{ name: "raining" }`.
A standard FIPA peer that sends a proposition or descriptor as content is
answered `not-understood`, and a classic-agents query sent to such a peer will
not be understood either. Both sides must agree on the names, which is the
price of not owning an ontology.

Keys stay value-independent, so `msg.temp` is "whatever is currently claimed
about temp". A `disconfirm` therefore negates whatever stands there now, and a
later `inform` replaces it — last write wins, consistently with the rest of the
store.

### Answering a directive: `agree` and `refuse`

A directive is a request, not an order. FIPA gives it a compelled hearer
effect — the receiver must notice it — but not an obligation to comply, so an
agent may decline. This library makes that explicit: a received directive is
answered with exactly one of

- **`agree`** — the goal exists and will be worked on. The content names the id
  actually assigned, so a sender whose requested `goalId` lost a race to an
  existing goal can follow the right one. The agreement is sent on admission,
  because by that point every question that can be answered "no" has been:
  the middleware chain admitted it, the plan library said it is able, and the
  queue said there is room. A plain request carries no condition, so the work
  begins on the agent's next cycle.

  FIPA's `agree` content is a tuple of an action expression and a condition φ:
  *I will act, but not until this holds*, formally `agree(j, ⟨i, act⟩, φ) ≡
  inform(j, Ii Done(⟨i, act⟩, φ))`. A plain `request` is unconditional, so its
  agreement carries no φ. A condition belongs to `request-when` and
  `request-whenever`, where the *sender* names it, and their `agree` carries it
  back as `when` — see
  [Standing Directives](#standing-directives-request-when-request-whenever-subscribe).
- **`refuse`** — declined, so no goal was created. Content carries
  `verdict: "no-plan" | "capacity" | "unsupported" | "declined" | "middleware"`
  and, where the agent supplied one, its own `reason` as free text. `no-plan` is
  no plan serving the goal; `capacity` is the goal queue having no room (or, for
  a query or a `cfp`, the evaluation limit); `unsupported` is a performative
  asking for something the agent does not honour — a `proxy` or `propagate`, or
  a `cfp` for a plan that does not bid — see
  [Directives the Agent Cannot Act On](#directives-the-agent-cannot-act-on);
  `declined` is a `cfp` the agent could bid on and chose not to, on these terms;
  `middleware` is the application's own chain declining, where the agent would
  otherwise have agreed.

The split between the two fields is FIPA's. Its `refuse` carries a single extra
element, φ, which gives *the reason for the refusal* as a causal account of why
the agent will not act — so `reason` holds that, and `verdict` is a library
addition that says which kind of decline this is. Naming them the other way round
would put `"capacity"` where the spec means a proposition about the world.

`verdict` is also what makes the answer actionable. FIPA's `refuse` disconfirms
that the action is feasible and informs that the agent has no intention to perform
it, so read literally it says the work will never happen. That is true of
`"no-plan"` and `"unsupported"`, true only of the call at hand for `"declined"`,
and false of `"capacity"`, which is backpressure
the same offer may be agreed to later. A sender must read the two apart, so every
verdict in the vocabulary is kept when a refusal is received, in `goalRefused`
and in the `infeasible.<peer>.<goal>.<exchange>` record. A received `failure`
closes its exchange the same way: `intent.*` goes negative and
`failed.<peer>.<goal>.<exchange>` records why.

Never both, and never an `agree` naming a goal the receiver dropped: a sender is
told what actually happened.

`refuse` is not `failure`. A refusal means the work was never started, and it
is only ever sent before an `agree`. A failure means work was *undertaken and
could not be completed*: an action threw or returned `failure: { reason }`, a
sub-goal or delegation brought the goal down, a dependency failed, or the goal
was removed before it finished. The agent sends that `failure` itself, from the
goal's own terminal transition, so no path ends an agreed request silently; a
declined directive never becomes one. See PERFORMATIVES.md › `request` › *The
terminal reply*.

Neither act is emitted as the primitives FIPA derives it from. `agree` is an
`inform`, and `refuse` is a `disconfirm` of feasibility followed by an `inform`
that the action was not done and the agent does not intend it — but the
decomposition defines the act rather than dictating the encoding, so one act
stays one message and one request keeps one reply to correlate against. The cost
is that a peer wanting `¬I Done(a)` as a proposition in its own belief base has
to build it from the refusal rather than read it off the wire.

`accept-proposal` is *not* folded into `agree`, even though FIPA gives the two
identical content, precondition and rational effect, differing only in which agent
performs the action. It belongs to the contract-net conversation and its content
genuinely differs from ours, so canonicalising it would let a contract-net
acceptance be read as a request acknowledgement. There is no synonym left to
compare it with either: the library's own aliases were retired with the rest of
the non-FIPA vocabulary.

The goal queue's own bound is answered as a `refuse` with
`verdict: "capacity"`, since shedding load is declining rather than failing. The
`reason` names the limit, so a caller can still distinguish backpressure from a
broken job.

To decline on your own terms, add a `directiveMiddleware` entry — see
[Work is guarded too](#work-is-guarded-too). There is no separate predicate any
more; the chain is the one place a request is judged, which is why it can both
decline *and* say why in the same step.

### Perception

Message structure:

```typescript
interface Message<T = unknown> {
  performative: Performative;  // any FIPA-ACL performative
  sender: string;
  receiver?: string | string[];  // point-to-point target(s); a set is fanned out on send
  topic?: string;          // pub/sub topic
  replyTo?: string;        // FIPA reply-to: where replies go instead of the sender
  content: T;              // message payload
  language?: string;       // checked against supportedLanguages, when configured
  encoding?: string;       // carried, not acted on
  ontology?: string;       // checked against supportedOntologies, when configured
  protocol?: string;       // stamped on what this agent sends; echoed on replies
  conversationId?: string; // the conversation; stamped when absent
  replyWith?: string;      // this message's id, echoed back as inReplyTo; stamped when absent
  inReplyTo?: string;      // the message this one answers
  replyBy?: string;        // FIPA reply-by (ISO 8601); stamped on directives by default
  timestamp?: number;      // library extension, not FIPA; optional on receipt
}
```

`:receiver` names one agent or a set of them, as FIPA defines it. A bus
delivers to one mailbox, so the library fans a set out: one message per
receiver, each addressed to a single agent, all sharing the conversation and
opening an exchange of their own — exactly how a `cfp` call's legs work, so
every reply pairs with the leg it belongs to and each peer is tracked under
its own `intent.<peer>.<goal>.<exchange>`. Duplicates are sent once. A plan
expresses this from an action result: `messages: [{ performative, receiver:
["a", "b"], content }]`. `topic` and `timestamp` are library extensions, not
FIPA parameters; `timestamp` is optional, so a peer speaking only the standard
is still understood.

Every incoming message is validated against `MessageSchema` before it is
reasoned about, whatever transport delivered it — a bus carries bytes, and a
decoding transport can hand over a message missing its `sender`, with a field
of the wrong type, or not a message at all. A malformed message with a usable
`sender` is answered `not-understood`; with none there is nobody to answer, so
it is reported locally and dropped. Either way `message:rejected` fires (see
[Events You Can Listen To](#events-you-can-listen-to)).

Which FIPA envelope parameters (SC00061) the agent acts on:

| Parameter | Honoured | How |
| --- | --- | --- |
| `performative`, `sender`, `receiver`, `content` | yes | the act, the peer, the address (a set is fanned out) and what it carries |
| `conversation-id`, `reply-with`, `in-reply-to` | yes | stamped when absent; every reply names the message it answers |
| `reply-to` | yes | every reply goes there instead of to the `sender` |
| `reply-by` | yes | stamped on directives (`replyTimeoutMs`); a directive past it is dropped, and a reply that misses it closes the exchange as unanswered |
| `protocol` | yes | see below |
| `language`, `ontology` | when configured | a message naming one outside `supportedLanguages` / `supportedOntologies` is answered `not-understood`; unset or empty accepts everything, and a message naming none is always accepted |
| `encoding` | no | carried, not acted on |

**`protocol`.** Every message this agent sends carries the interaction
protocol it belongs to. A reply carries the protocol of the message it answers,
so a peer that names its own protocol is answered in it. A message that opens an
exchange carries the FIPA protocol its act starts: `fipa-request` for a
`request`, `fipa-query` for `query-if`/`query-ref`, `fipa-request-when` for
`request-when`/`request-whenever`, `fipa-subscribe` for `subscribe`,
`fipa-contract-net` for a `cfp`, and `fipa-propose` for a `propose` that
answers no call. Anything else, such as an `inform` that answers nothing, goes
out with no `protocol`, as does a reply to an exchange older than the last
`MAX_REMEMBERED_PROTOCOLS` (10,000) the agent has seen. The agent does not
check an incoming message's `protocol` against its act: the act decides the
reaction, and the protocol is only carried forward.

### The Inbox

An agent's inbox holds what the bus has delivered but the cycle has not
perceived. It is separate from the belief base on purpose — a message is an
event, a belief is state — and reading it is a decision the reasoning loop
makes rather than one the bus makes for it.

```typescript
agent.inbox.size();      // delivered, not yet perceived
agent.inbox.peek();      // readable without draining
agent.inbox.dropped;     // shed on overflow
```

It is bounded (`maxInboxSize`, default `DEFAULT_MAX_INBOX_ENTRIES`) so an agent
that stops ticking sheds load rather than growing without limit. On overflow
the **oldest** message is dropped, since a newer assertion supersedes an older
one about the same proposition, and `dropped` counts it so a gap is never
mistaken for quiet delivery.

Sending a `request` to an agent:

```typescript
await bus.send("agent-id", {
  performative: "request",
  sender: "user",
  receiver: "agent-id",
  content: { goal: "deploy" },
  timestamp: Date.now(),
});
```

Publishing to a topic (all subscribers receive it):

```typescript
await bus.publish("events", {
  performative: "inform",
  sender: "sensor",
  topic: "events",
  content: { temperature: 42, location: "server-room" },
  timestamp: Date.now(),
});
```

#### Following a Request You Sent

A goal that came from a directive keeps a `source` recording the message it came from, and that `source` is inherited by every sub-goal the plan delegates to its own agent (goals it `spawn`s are independent and carry none) — so the sender can follow its own job through arbitrary decomposition and all the way to a failure event, without guessing ids.

```typescript
// The goal the agent creates:
{
  id: "goal-8f3c…",            // assigned by the agent
  name: "deploy",
  status: "pending",
  source: { sender: "ui", conversationId: "chat-42" },
  parentGoalId: undefined,      // sub-goals inherit `source` from their parent
  rootGoalId: undefined,
}
```

A sender that pins the id up front (below) knows it before the `agree` arrives, so it can also pre-register dependent goals by id (`dependsOn: ["job-7"]`).

**Goal ids.** A caller may pin the id with `content.goalId`; the agent honours it only while that id is free, since reusing a taken id would overwrite a live goal. Either way the sender is told which id was actually assigned, so it never has to guess:

```typescript
// Sender registers an inbox (or subscribes to the bus directly):
bus.registerAgent("ui", (msg) => {
  if (msg.performative === "agree") {
    // content: { goal: "deploy", goalId: "goal-8f3c…" }; msg.conversationId: "chat-42"
    track(msg.content.goalId, msg.conversationId);
  } else if (msg.performative === "refuse") {
    // { goal: "deploy", goalId: "goal-…", verdict: "capacity", reason: "rejected: goal queue is full (limit 4)" }
    offerLater(msg.content.goal, msg.content.reason);
  } else if (msg.performative === "inform" && msg.content.done === true) {
    // { goal: "deploy", goalId: "goal-8f3c…", done: true }: the work is done
    finished(msg.content.goalId);
  } else if (msg.performative === "failure") {
    // { goal: "deploy", reason: "…" }: it was undertaken and could not be completed
    failed(msg.content.goal, msg.content.reason);
  }
});
```

When the sender is itself an `Agent`, use the `goalAcknowledged` and
`goalRefused` events instead of a raw inbox (see
[Events You Can Listen To](#events-you-can-listen-to)). Both are bookkeeping, not
world state, so they deliberately create no belief, goal or intention — folding
them into beliefs would put protocol bookkeeping into the belief base, where only
world state belongs:

```typescript
const caller = new Agent({ id: "caller", bus, planLibrary: lib });

const unsubscribe = caller.on("goalAcknowledged", (ack) => {
  // { agentId, goal, goalId, conversationId?, inReplyTo? }
  track(ack.goalId, ack.conversationId);
});
```

That is also how a coordinator notices a lost race on a pinned id: it asked for `goalId: "job-7"`, and `ack.goalId` comes back as something else.

Acks are queued when the request is processed and sent on the agent's next `tick()`, so a `MessageHandler` stays synchronous. A `replyWith` you stamp on the request is echoed back as `inReplyTo` on the ack, and on the terminal `inform`/`failure` that ends the request. Requests the agent sent to itself are not acked.

An `Agent` that sent the request files those replies itself, under the request's exchange: `intent.<peer>.<goal>.<exchange>` goes `positive` on `agree`; `done.*` records the final `inform`, `failed.*` a `failure`, `infeasible.*` a `refuse`, and `unanswered.*` no reply by `reply-by`. To wait for work rather than track it, delegate it — see [Goal Decomposition and Delegation](#goal-decomposition-and-delegation).

### `classic-agents/core`

The BDI engine:

- **BeliefBase** — pluggable typed key-value belief store, holding a `BeliefStatus` (`"positive"`/`"uncertain"`/`"negative"`) beside each value so a `disconfirm` can record the sender's stance against the content it names. The `BeliefBase` interface defines the contract (`get`/`set`/`setStatus`/`statusOf`/`compareAndSet`/`remove`, prefix and predicate queries, `beliefAdded`/`beliefUpdated`/`beliefRemoved` events); the default backend is `InMemoryBeliefBase`. Inject any implementation via `Agent` config (`beliefs`) — one backed by Redis, say — just like swapping message-bus transports.

`compareAndSet(key, expected, next)` performs an atomic, compare-and-swap update and resolves to `true`/`false`. `expected: undefined` means "the key is absent". Comparison is deep (structural), so object beliefs round-tripped through the bus compare correctly. In-memory it's a synchronous map check-and-set (atomic within the event loop); Redis implementations can back it with a Lua script so read-compare-write stays atomic across processes.

For convenience, `update(key, reducer)` runs the optimistic read → `reducer(current)` → write loop for you via `casUpdate` (the shared retry helper — `reducer` is re-invoked on contention, and the update counts as failed after 100 attempts). Use `set()` for blind single-writer / newest-fact-wins writes (e.g. applying inbound messages); use `compareAndSet`/`update` whenever the new value depends on the current one.

- **GoalQueue** — priority-based goal queue with pluggable selection strategy. Goals have statuses: `pending → active → achieved | failed | dropped`. Goals can declare dependencies on other goals via `dependsOn: string[]` — a goal is only selected when all its dependencies have achieved. Failed goals cause dependent goals to be dropped. Sub-goals an action delegates to its own agent (`delegations` with no `receiver`) record where they came from: `parentGoalId` is the goal whose plan created them, and `rootGoalId` is the top of that chain (the parent's `rootGoalId`, or the parent's own id), so lineage survives the creating intention. The default selection never activates two goals of one name at once, except a sub-goal under a waiting ancestor of that name, so a plan may delegate its own goal (bounded recursion) without deadlocking. The queue emits `goalAdded`, `goalStatusChanged`, `goalRejected` and `goalRemoved` for everything that happens to it (see [Events You Can Listen To](#events-you-can-listen-to)).

  Because an achieved goal is collected at the end of the cycle that finished it, the queue keeps a small separate record of achievements that something still depends on — `goals.achievedIds()`, or `goals.dependenciesMet(goal)` for the check itself. It is reference-counted against the goals that declare `dependsOn`, so the record is retained only while there is work waiting on it: an agent that never uses `dependsOn` retains nothing, and a goal that is waiting on a dependency nobody has achieved yet simply stays `pending`.

  Goals are **bounded, not rotated**. An agent holds at most `maxGoals` unfinished goals (`pending` + `active`, sub-goals included; default `1000`, `0` or `Infinity` for unbounded). A goal offered once the bound is reached is admitted and immediately failed rather than queued — the queue is full, so backpressure is the honest answer. Nothing is ever evicted to make room: a goal leaves the queue only after reaching `achieved`, `failed` or `dropped`, at the end of the cycle that finished it. So `goals.all()` is the agent's *current* work, not its history; read history off the event stream (see [Working Set and History](#working-set-and-history)).

- **PlanLibrary** — registers plans, each a `{ goal, name?, body, context? }` where `goal` is the goal it serves, `name` the plan's own unique name (defaulting to the goal's, so a goal's second plan needs one), `body` the actions it runs, and `context` an optional condition choosing among several plans for the same goal. Registering a plan that serves a goal is the agent saying it can do it. `declares(goalName)` is the static check that lets a directive be refused as `no-plan` before a goal exists; `applicable(beliefs, goal, exclude?)` returns the plans that serve a goal and whose context holds, in registration order; `serving(goalName)` returns every plan that serves a goal, ignoring context; `match(goal)` returns the first plan that serves a goal by name, ignoring context.

- **DesireLibrary** — registers the desires an agent holds, each a `{ name, intend, trigger?, retryAfterMs?, onRetract? }` rule. `intend(beliefs)` is a pure, synchronous function returning the goal descriptor (`{ goal, priority?, data?, dependsOn? }`) to pursue now, or `undefined` for "not asking" — the same descriptor an action `spawn`s, so it is goal-driven rather than action-shaped. The generated `goal` is treated as any other, save that it has no `source` and so owes no reply. A desire with a goal already in flight does not fire again; `trigger` (`"edge"`, the default, or `"level"`) decides whether it fires again once that goal finishes — the same `Trigger` rule standing `request-when*` directives follow. `declares(name)` and `all()` round it out. Inject via `Agent` config (`desires`); see [Desires: goals the agent starts itself](#desires-goals-the-agent-starts-itself).

- **Trigger** — the firing rule shared by desires and standing `request-when` / `request-whenever` directives: watch a condition cycle by cycle (`observe(holds)`), decide when a goal is due — on a rising edge (`"edge"`) or while it holds (`"level"`) — and hold the firing until the goal queue has room (`ready(goals)`). Optionally allows only one goal in flight (`oneInFlight`) and waits `retryAfterMs` after a goal it fired failed. The caller creates the goal and reports it with `fired(goal)`. An evaluation that errored is simply not observed, so it never counts as an edge.

- **IntentionStack** — tracks active intentions with states: `pending → executing | waiting → completed | failed`. Intentions enter `waiting` when their action delegates work (`delegations`) — sub-goals of this agent's, or requests to other agents — and resume once all of it is done; work delegated by the last action is waited for too, and the intention completes then. A delegation that *fails* also releases the parent, which fails with it (see [Sub-goal Failures](#sub-goal-failures)). Goals an action `spawn`s are independent and never waited for. A last action that hands its goal on with `continueWith` completes the intention without achieving the goal; see [Handing On: `continueWith`](#handing-on-continuewith). See [Goal Decomposition and Delegation](#goal-decomposition-and-delegation).

- **Agent** — orchestrates the full BDI cycle. Configurable for `maxConcurrentIntentions` (10), `maxGoals`, `maxInboxSize`, the `middleware` and `directiveMiddleware` chains, `propositionLibrary`, `expressionLibrary` and `desires`, `replyTimeoutMs` (the default FIPA `reply-by` stamped on every directive it sends, 30 s), `evaluationTimeoutMs` (how long a proposition or expression may run before it is answered `failure`, 10 s), `maxConcurrentEvaluations` (how many may run at once before a query is refused `capacity`, 100), `delegationTimeoutMs` (how long a remote delegation's work may take before it fails and its receiver is sent a `cancel`, 5 min), `proposalTimeoutMs` (how long a bid it makes stays valid, defaulting to `replyTimeoutMs`), and `supportedLanguages` / `supportedOntologies` (the content languages and ontologies it can read; unset accepts all). Replies always go to a message's `reply-to` when it names one; evaluations never block the reasoning cycle. See PERFORMATIVES.md › *`reply-to` and `reply-by`* and *Evaluating propositions and expressions*.

#### Working Set and History

Finished goals and intentions are **collected**, not retained: once a goal reaches `achieved`, `failed` or `dropped` it leaves the queue at the end of the cycle that finished it, and an intention in `completed` or `failed` leaves the stack the same way. Neither store is a log. A long-running agent that completes a million jobs holds roughly a million jobs' worth of *nothing* — just its current working set — because both stores are indexed by status and only the unfinished entries are ever walked by the reasoning cycle.

The practical consequence: `goals.all()` and `intentions.getAll()` answer "what is the agent working on now?", not "what has it ever done?". Anything that needs history should subscribe to the event stream, which is the same thing a monitor does.

Collection is deliberately deferred to the end of the cycle rather than done at the transition, so a job's whole event sequence arrives with the store objects still present. A listener on `intention:completed` can still read its goal as `achieved`, because the goal is collected after that event fires, not before.

```typescript
// A monitor keeps the history the stores deliberately do not.
const history: Goal[] = [];
agent.on("goal:status", ({ goal }) => history.push({ ...goal }));
agent.on("goal:removed", (goal) => history.push({ ...goal }));
```

#### Refusing Work Past the Bound

A goal the queue could not take fails immediately, which means the same two things a failed job does: an answer to whoever asked for it, and a failed child for the parent waiting on that sub-goal. The answer differs by lineage. A **root** goal gets a `refuse`, since no `agree` went out for it. A **sub-goal** gets none: it carries its parent's `source`, so its requester is the one already holding an `agree` for the goal it did ask for, and FIPA allows no `refuse` after `agree` — the shed sub-goal fails its parent, and the requester hears the root goal's single `failure` instead. What sets the shed apart either way is the event that reports it: a goal shed for capacity is declined, never attempted, so it fires `goal:rejected` rather than `intention:failed`, and the `reason` names the limit:

```typescript
agent.on("goal:rejected", ({ goal, reason }) => {
  console.warn(`${goal.name} shed for capacity: ${reason}`);
  scheduleRetry(goal.id); // backpressure, not a fault
});
```

Refusal releases room as soon as earlier work finishes, so a queue at its bound still drains.

#### Events You Can Listen To

Everything an agent does is observable without polling it. The stores emit their own events, and `Agent` re-emits the reasoning cycle as a typed event stream, so a monitor can follow an agent live instead of diffing `intentions.getAll()` between ticks or wrapping the bus.

The stores keep their own events:

| Store | Event | Payload |
|-------|-------|---------|
| `agent.beliefs` (`BeliefBase`) | `beliefAdded`, `beliefUpdated`, `beliefRemoved` | `{ key, value?, previousValue?, status?, previousStatus? }` — a stance change is reported even though the value did not move |
| `agent.goals` (`GoalQueue`) | `goalAdded` | `Goal` — the stored goal, at the status it was added with |
| `agent.goals` (`GoalQueue`) | `goalStatusChanged` | `Goal` — as it now stands, so the previous status is not in the payload |
| `agent.goals` (`GoalQueue`) | `goalRejected` | `Goal` — refused for room, at the status it was admitted with, before the `goalStatusChanged` that fails it |
| `agent.goals` (`GoalQueue`) | `goalRemoved` | `Goal` — a finished goal left the queue |
| `agent.intentions` (`IntentionStack`) | `intentionRemoved` | `Intention` — a finished intention left the stack |

`agent.on(event, handler)` covers the rest. Every handler is typed for its event, and `on` returns an unsubscribe function:

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
| `goal:replanned` | `{ goal, failed, reason, intention }` — a plan failed and the next applicable plan took the goal over; the goal stays `active`. Emitted between the failed plan's `intention:failed` and the next plan's `intention:started` |
| `goal:failed` | `{ goal, reason, attempts, onGoalFailureError? }` — the goal reached `failed`: its last applicable plan failed, no plan was applicable, or it was declined or rejected for room. Once per goal, after its `goal:status`; `reason` as `onGoalFailure` left it. A cancelled goal, or one dropped for a failed dependency, is `dropped` instead |
| `goal:removed` | `Goal` — collected after it finished, at the end of that cycle |
| `intention:started` | `Intention` |
| `intention:advanced` | `{ intention, action, result }` — the action that just ran, and what it returned |
| `intention:delegated` | `{ intention, delegations }` — the delegations an action just made |
| `intention:waiting` | `{ intention, children, delegations }` — the sub-goal ids and the delegations it is waiting for |
| `delegation:progress` | `{ intention, delegation }` — a remote delegate sent a progress note, now on `delegation.progress` |
| `delegation:settled` | `{ intention, delegation }` — a delegation was done, failed or cancelled |
| `intention:completed` | `Intention` — its goal is `achieved`, unless the plan handed it on (`goal:continued`) |
| `intention:failed` | `{ intention, reason, onPlanFailureError? }` — its plan failed; the goal failed too unless `goal:replanned` follows. `onPlanFailureError` is set when the plan's `onPlanFailure` hook threw |
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
| `proposal:rejected` | `{ peer, goal, proposalId, reason? }` — a bid of this agent's was rejected |
| `proposal:expired` | `{ peer, goal, proposalId }` — a bid of this agent's passed its `reply-by` unanswered |

A monitor built on nothing but events:

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

Things to know about the payloads:

- **Goals and intentions are live objects.** `goal`/`intention` are the very objects the queue and stack hold, mutated in place as work progresses (`setStatus`, `advance`, …), so a handler that keeps one sees later changes. Snapshot it — `{ ...goal }` — to hold the state you saw; every other field is plain data and safe to serialise.
- **Handlers run synchronously**, on the cycle that raised the event, so they must not block; hand slow work to a queue. A handler that throws fails that cycle: a manual `tick()` rejects with its error, and the `start(tickIntervalMs)` loop reports it on `cycle:failed` and carries on with the next cycle.
- **Finished items leave the stores.** A goal or intention is collected once it is terminal, at the end of the cycle that finished it, so `goal:removed` / `intention:removed` are the last event in a job's sequence. Within a cycle everything is still readable; across cycles, snapshot the stream rather than polling `all()`.

Goal events are delivered whether or not the agent is running, and survive `stop()`/`start()`. All of them cover only this agent's own work. A bus-wide view — or a view across processes — is the user's to build: map the events onto whatever channel you own (`agent.on("intention:failed", e => channel.publish(e))`), which is plumbing classic-agents deliberately does not dictate.

#### Action Failures

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

#### Sub-goal Failures

An intention waiting on its delegations is released when one of them fails — a parent can never sit in `waiting` forever (which would also keep holding a `maxConcurrentIntentions` slot). By default the waiting parent fails too, with a reason naming the sub-goal or the delegate, and the failure keeps cascading to *its* waiting parents until the top-level goal fails:

```
sub-goal "build" failed: 503 from registry
delegation of "pick" to warehouse failed: refused (no-plan): no plan serves "pick"
```

Every intention that fails this way reports the same `intention:failed` event as any other failure.

#### Goal Achieved

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

A plan that wants to send the reply itself can: an `inform` it sends to the requester marked `done: true` replaces the automatic one, and any other `inform` is a progress note. See PERFORMATIVES.md › `request` › *The terminal reply*.

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

With `"continue"` the failed delegation is no longer awaited, the reason is recorded in `intention.childFailures`, and the parent resumes with its next action once nothing is left outstanding — the remaining delegations are still awaited rather than abandoned.

#### Plans Serve Goals by Name

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
declare — see
[Standing Directives](#standing-directives-request-when-request-whenever-subscribe).

`declares()` reports whether some plan serves a goal name. It is checked against
a plan library that is fixed for the agent's lifetime, so a plan registered
*after* a request was refused will not retroactively rescue it. That is the
trade for answering honestly at admission instead of agreeing and stalling: an
unservable request can never occupy a `maxGoals` slot.

#### Alternative Plans: `context`

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

#### When a Plan Fails: `onPlanFailure`

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

#### When a Goal Fails: `onGoalFailure` and `goal:failed`

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

#### Standing Directives: `request-when`, `request-whenever`, `subscribe`

Three FIPA directives ask the receiver to *watch* something on the sender's
behalf. A predicate cannot cross a JSON bus, but a name can, so the sender names
a proposition or expression the receiver has registered, and the receiver owns
the implementation:

| Performative | Content | The agent… |
| --- | --- | --- |
| `request-when` | `{ goal, when }` | agrees, then creates the goal the first time the proposition `when` holds |
| `request-whenever` | `{ goal, when }` | agrees, then creates a goal each time `when` turns true, until cancelled |
| `subscribe` | `{ name }` | agrees, sends the expression's value now, then again on every change, until cancelled |

```typescript
const propositions = new PropositionLibrary();
propositions.register({
  name: "raining",
  evaluate: (beliefs) => beliefs.get("weather.rain") === true,
});
const agent = new Agent({ id: "home", bus, planLibrary, propositionLibrary: propositions });

// A peer sends:   request-when { goal: "close-window", when: "raining" }
// The agent replies agree { goal: "close-window", goalId: "goal-…", when: "raining" },
// and once it rains, runs close-window and replies inform { goal, goalId, done: true }.
```

- **Admission** works as it does for a request: the `directiveMiddleware` chain,
  then `refuse no-plan` when no plan serves the goal, and `not-understood` when
  the proposition or expression isn't registered.
- **Every tick**, each commitment is evaluated against the agent's beliefs and
  the original message, so arguments sent beside the name still apply. A
  condition that already holds fires at once.
- **A firing is an ordinary request**, ending in one `inform` or `failure`. If
  the goal queue is full, the firing waits for room rather than being refused
  after the `agree`.
- **The firing rule is a `Trigger`** in `"edge"` mode, the same rule a
  [desire](#desires-goals-the-agent-starts-itself) follows by default, so the
  two fire, wait for room and hold a missed edge alike.
- **An evaluation that throws** ends the commitment with `failure`.
- **`cancel`** with `inReplyTo` naming the directive ends it, and is answered
  `inform`. Only the sender may cancel. A plain request can be cancelled too:
  always if it has not started, and once started only if its plans are marked
  `cancellable: true`, between actions, after running each plan's `onCancel`
  clean-up. Otherwise the cancel is answered `failure`. See PERFORMATIVES.md ›
  `cancel`.
- The sending agent tracks a subscription it sent at
  `subscription.<peer>.<name>.<exchange>`, which each update replaces.

The `subscribe` method on `Agent` is unrelated: it subscribes *this* agent's
inbox to a bus topic.

#### Directives the Agent Cannot Act On

The two acts in the CAL vocabulary the base agent declines are `proxy` and
`propagate`, the forwarding directives. Each asks the receiver to relay a
message on the sender's behalf, which this release does not do, and neither has
a plan a goal could be served by, so a message carrying one is answered
`refuse { verdict: "unsupported" }`. This follows JADE and SPADE, which carry
both acts without implementing forwarding; `PROXY.md` holds the plan for
supporting `proxy`. `isUnsupportedDirective()` is exported if you want to ask
the same question, and a subclass that can honour such an act overrides
`handleUnsupportedDirective`. Every other directive in the CAL vocabulary —
including `cfp`, which is bid on or declined rather than treated as a request —
is honoured by the base agent.

A `cfp` a plan does not bid on is answered `refuse` with a `RefusalVerdict` the
sender already understands: `unsupported` when the plan does not bid, `no-plan`
when nothing serves the goal, `capacity` when the queue is full, and `declined`
when the bid expression answers no bid.

#### Goal Decomposition and Delegation

A plan hands work off with `delegations` and waits for it, whether this agent does it or another one. The only difference is where the work runs:

- **No `receiver`** (or this agent's own id) — a **sub-goal**. It records the delegating goal as `parentGoalId`, the top of the chain as `rootGoalId`, and inherits the request's `source`, so it is cancelled with that request. Its failure — including having no plan or no room in the queue — is the parent's child failure.
- **A `receiver`** — a FIPA `request` for `goal` to that agent, with `view` as the rest of its content. It is part of the delegating goal's conversation and opens an exchange of its own, so every reply pairs with it. The receiver's `inform { done: true }` completes it; its `refuse`, `failure` or `not-understood`, no reply by the request's `reply-by`, or a result the belief middleware will not believe, fails it.

```typescript
lib.register({
  goal: "ship",
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
      }),
    },
    // Waits for all three...
    {
      name: "confirm",
      // ...then reads how each one went.
      execute: async (intention) => {
        const pick = intention.delegations.find((d) => d.goal === "pick");
        return { beliefUpdates: [{ key: "picked", value: pick?.result }] };
      },
    },
  ],
});
```

Every delegation is recorded on `intention.delegations`, open or settled: its `receiver`, `goal`, `status` (`sent → agreed → done | failed | cancelled`), the `exchange` of a remote one, the `goalId` the work runs under, the latest `progress` note a remote delegate sent (an `inform` that is not its `done`, also reported on `delegation:progress`), and the `result` (the answer the work's plan set as `ActionResult.result`, carried in the `done` reply when remote) or the `reason` it failed. Two settings decide how much of the work is needed. `waitFor`, on the action, says how many of its delegations must succeed: `"all"` (the default), `"any"` (a race: the first answer wins and the rest are cancelled; only for interchangeable, idempotent work, see below), or a number. `onFailure`, on each delegation, says whether its failure is tolerated (`"fail"`, the default, or `"continue"`). Every failure lands in `intention.childFailures`, with the `receiver` and `exchange` that failed. The intention fails only once the target can no longer be met and a failure it does not tolerate is among them. See DELEGATION.md › *Failure handling*.

```typescript
// Ask three mirrors for the same rate, take the first answer; fail only if all three fail.
execute: async () => ({
  delegations: ["mirror-a", "mirror-b", "mirror-c"].map((receiver) => ({
    receiver,
    goal: "rate",
    view: { pair: "EUR/USD" },
  })),
  waitFor: "any",
}),
```

`"any"` is for **interchangeable, idempotent work**: every delegate does the
whole job, so it is worth it only when doing it twice is harmless, and the
first answer is as good as any. A losing delegate is sent a `cancel`, but it
may refuse (its plan may not be `cancellable`) or finish before the cancel
reaches it, so its work may still take effect. Choosing among providers by
what they *offer* (a price, a delivery date), where only the chosen one
should do the work, is the FIPA Contract Net's job (`cfp`, `propose`,
`accept-proposal`), not a race.

A remote delegation also has a deadline on the work, since `reply-by` bounds only the first reply: `timeoutMs` on the delegation, or the agent's `delegationTimeoutMs` (5 min; `null` or `0` for none). When it passes, the delegation fails and the receiver is sent a `cancel`. The same `cancel` goes to every open remote delegation of an intention that fails or whose request is cancelled, so a delegate does not go on working for nobody. A sub-goal has a deadline only when its `timeoutMs` sets one, and is otherwise treated the same: once nobody waits for it, it is withdrawn under the rules a receiver applies to a `cancel` — dropped if it has not started, stopped at the next action boundary with its `onCancel` clean-up if every started plan is `cancellable`, and otherwise left to run, as a delegate that answered the `cancel` with `failure` would.

**Delegating to agents that are not classic-agents.** The request (`{ goal, ...view }`) and its completion (`inform { done: true, result }`) are this library's JSON conventions, not a FIPA content language. A standard FIPA peer, such as JADE, expects SL and reports completion as `inform` of `Done(action)`, so a delegation to it is not understood, or never completes and fails at `delegationTimeoutMs`. Neither middleware chain can bridge it, since the completion check runs before the belief `middleware` and no chain sees outgoing messages. Translate at the transport instead: a `MessageBus` that wraps the real one can map requests into the peer's content language in `send`, and map its replies back in the handler it passes to `registerAgent`. This is the same limitation queries have.

Work an action hands off is part of the plan's outcome, so an intention waits for it even when the delegating action is its last: the goal is achieved, and the requester told `done`, only once the delegated work is.

##### Handing On: `continueWith`

A plan that loops — paging, polling, retrying — should not delegate its next step from its last action: every step would nest one level deeper and hold a `maxConcurrentIntentions` slot while it waits. The last action hands the goal on instead:

```typescript
lib.register({
  goal: "fetch-page",
  body: [
    {
      execute: async (intention) => {
        const { page } = intention.goal.data as { page: number };
        const more = await fetchPage(page);
        return more
          ? { continueWith: { goal: "fetch-page", data: { page: page + 1 } } }
          : { result: { pages: page } };
      },
    },
  ],
});
```

The goal keeps its id, `parentGoalId`, `rootGoalId`, `source` and `dependsOn`; it takes the new name, `data` and (optionally) `priority`, and goes back to `pending` to be planned afresh. Whoever waits on it — a parent intention, the requester, a goal that `dependsOn` it, a `cancel` — now waits on the continuation, and a request is answered once, `inform` or `failure`, when the chain ends. A `result` set along the way carries over until a later action replaces it. `continueWith` is valid only from a plan's last action and not together with `delegations`, `calls` or `awards`; anywhere else the intention fails with a reason saying so.

For independent work the plan does *not* wait for, `spawn` new root goals instead. A spawned goal has no parent and no `source`: it is not dropped when the spawning goal fails, not withdrawn by a `cancel` of its request, and not answered to anyone.

```typescript
// Sequential goals — the parent completes, and setupProfile runs on its own:
lib.register({
  goal: "onboard",
  body: [
    {
      execute: async () => ({
        beliefUpdates: [{ key: "accountCreated", value: true }],
        spawn: [{ name: "setupProfile", priority: 10 }],
      }),
    },
  ],
});

// Goal dependencies — user-specified prerequisites:
agent.goals.add({
  id: "g-deploy",
  name: "deploy",
  priority: 10,
  status: "pending",
  dependsOn: ["g-build", "g-test"], // won't be selected until both achieve
});

// The achievement outlives the goal that made it, so a dependent goal added
// later — or selected on a later cycle — still sees the dependency as met:
agent.goals.achievedIds(); // => Set { "g-build", "g-test" }
agent.goals.dependenciesMet({ id: "x", name: "deploy", priority: 1, status: "pending", dependsOn: ["g-build"] }); // => true
```

#### Calling for Proposals (Contract Net)

Where a delegation picks the receiver up front, a **call for proposals** asks
several and lets the answers decide. A plan action opens calls with `calls`,
the intention waits until every call has closed, and the next action reads the
bids and awards them with `awards`:

```typescript
lib.register({
  goal: "pave",
  body: [
    {
      name: "call",
      // One `cfp` per invitee, or a single published one for a `topic`.
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

A participant opts in by naming a `bid` on the plan — an `Expression`, computed
against the `cfp` as its message, whose result becomes the `propose`'s `terms`:

```typescript
agent.expressionLibrary.register({
  name: "quote",
  evaluate: (beliefs, cfp) =>
    beliefs.get(`stock.${cfp.content.goal}`) > 0 ? { price: 40 } : null,
});
lib.register({ goal: "dig", bid: "quote", body: [/* ... */] });
```

A `cfp` for a plan that does not bid is declined `unsupported`; a bid that
answers `null` is declined `declined`. The winner is sent `accept-proposal`
carrying its `terms`, the job is admitted as an ordinary request that owes the
caller a final `inform`/`failure`, and its outcome settles the initiator's
award as a delegation would.

A few rules worth knowing on the calling side:

- **A call closes** when every invitee has answered, when its deadline
  (`deadlineMs`, default `replyTimeoutMs`) passes, or when a bid it holds is
  about to expire. A bid is valid for the bidder's `proposalTimeoutMs` from when
  it was sent, so a call with a silent invitee closes early rather than outlive
  its first bid. A topic call has no invitee list, so only the last two apply.
- **Awards are delegations.** An action's `awards` and `delegations` form one
  batch, counted by its `waitFor`, and each award has the same `onFailure` and
  `timeoutMs` a delegation has.
- **An action that fails awards nothing**, even if it also lists `awards`, so a
  winner is never accepted and then cancelled. All its bids are rejected, as are
  the bids still held by an intention that fails or is cancelled before it
  awards.
- **Only an invitee answers its own `cfp`.** A bid naming a `cfp` that went to
  another agent is answered `reject-proposal { reason: "not invited" }`.
- **A `cfp` sent as a plain message** (`ActionResult.messages`) is not waited
  for: its bids are reported on `call:proposal` for the application to answer,
  and it is tracked until its `reply-by`, even after the plan that sent it ends.

See [CONTRACT-NET.md](CONTRACT-NET.md) for the design and PERFORMATIVES.md ›
Contract Net for the decisions.

### Desires: goals the agent starts itself

Everything above begins with someone else: a `request` on the bus, a standing
directive, a `cfp`. A **desire** is the other kind of goal — one the agent
chooses for itself because of what it believes. It is a standing preference,
"when my beliefs say so, pursue this goal", and it is how an agent acts on its
own initiative.

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
selection, so a goal one asks for can be worked in the same cycle. Once
generated the goal is an ordinary goal — queued, selected, planned, executed,
cancellable — with one difference: it has no `source`, so the agent owes nobody
a reply. There is no `agree`, no `refuse`, and no terminal `inform`/`failure`,
because there is no requester; everything else is the same, including `spawn`,
`delegations`, `continueWith` and `onGoalFailure`.

A few rules worth knowing:

- **`intend` is synchronous, cheap and free of side effects**, exactly like a
  `Plan.context`. It reads the beliefs and says what is wanted; it is not a
  place to do work. Returning `undefined` means "not asking". One that throws
  is reported on `desire:error` and changes nothing — it neither fires the
  desire nor counts as it stopping, so a flaky read cannot cause a refire.
- **One goal in flight at a time.** A desire with a goal still in the queue does
  not fire again, so no desire can pile up goals.
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

Listen for `desire:triggered` — it carries the desire and the goal it motivated
together, so a monitor sees *why* the work exists:

```typescript
agent.on("desire:triggered", ({ desire, goal }) => {
  log.info(`desire ${desire.name} -> goal ${goal.name} (${goal.id})`);
});
```

## Quick Start

```bash
npm install
npm test
npm run example              # two agents: an inform, then a request that acts on it
npm run example:delegation   # a shop delegating to a warehouse and a courier, with results and progress
npm run example:contract-net # a builder calling for quotes and awarding the cheapest
npm run example:queries      # queries that read vs a request that computes a result
npm run example:race         # ask three mirrors for the same rate, take the first answer (waitFor: "any")
npm run example:standing     # subscribe and request-when, then cancel
```

Each example lives in `src/examples/` and prints what goes on the wire.

### Creating an Agent

```typescript
import { Agent, InMemoryMessageBus, PlanLibrary } from "classic-agents";

const bus = new InMemoryMessageBus();
const lib = new PlanLibrary();

lib.register({
  goal: "greet",
  body: [
    {
      name: "say-hello",
      execute: async () => {
        console.log("Hello!");
        return {};
      },
    },
  ],
});

const agent = new Agent({ id: "bot", bus, planLibrary: lib });
await agent.start();
agent.goals.add({ id: "g1", name: "greet", priority: 10, status: "pending" });

// Let the reasoning cycle run
await agent.tick();
await agent.stop();
```

## Testing

### Testing your plans

`classic-agents/testing` runs a plan's steps without an agent, a bus or a
hand-built `Intention`:

```typescript
import { actionOf, fixtureIntention, runAction } from "classic-agents/testing";

// Run one step, by name, the way the agent would.
const { result, failure, beliefs } = await runAction(assess, "screen", {
  data: job, // the goal's data
  beliefs: { status: "idle" }, // or a BeliefBase of your own
  results: { enrich: { score: 3 } }, // answers of sub-goals already delegated
});
expect(result?.beliefUpdates).toContainEqual({ key: "screened", value: true });
expect(beliefs.get("status")).toBe("screening");

// On a `failure` or a throw, the plan's `onPlanFailure` runs too, and
// `failure.reason` is what the requester would be told.
expect(failure?.reason).toBe("shipping unavailable");
expect(failure?.originalReason).toBe("no courier");

// For anything else, build the intention and call the step yourself.
const intention = fixtureIntention(assess, {
  data: job,
  delegations: [{ goal: "enrich", status: "failed", reason: "down" }],
  childFailures: [{ goal: "enrich", reason: "down" }],
});
await actionOf(assess, "screen").execute(intention, beliefs);
```

`runAction` runs that one step only. What its result would start (delegations,
calls, spawned goals, messages, `continueWith`) is returned for the test to
check, not carried out.

To test the plan as a whole, `runPlan` runs it to the end on a real agent, so
it is stepped, waits and fails exactly as in production. Each goal it delegates
is answered from `subGoals`, by goal name: a self-delegation by a stub plan, a
delegation to another agent by a stub agent of that id.

```typescript
import { runPlan } from "classic-agents/testing";

const trace = await runPlan(review, {
  data: job,
  beliefs: { threshold: 0.5 },
  subGoals: {
    enrich: { result: { score: 3 } }, // what the sub-goal answers
    audit: { failure: { reason: "auditor down" } },
    price: (data) => ({ result: quote(data) }), // or answer from its data
  },
});

expect(trace.outcome).toBe("continued"); // or "achieved", "failed", "unfinished"
expect(trace.steps.map((s) => s.action)).toEqual(["fetch", "enrich", "decide"]);
expect(trace.continueWith).toEqual({ goal: "qualify", data: expect.anything() });
expect(trace.failure).toBeUndefined(); // { reason, cause, action, error, ... }
```

The trace also has the goal's `result`, the plan's `delegations`, every message
the agent sent, and its beliefs. The run stops when the goal is achieved,
fails or is handed on with `continueWith`. Calls for proposals are not
answered.

### Testing the library

```bash
npm test                  # run all tests
npm run test:watch        # watch mode
```

Tests cover: belief base CRUD, stance and events; goal queue selection, bounds and events; plan matching by name, context conditions, alternative-plan fallback, `onPlanFailure`, `onGoalFailure` and `goal:failed`; desires — intent evaluation, situation-dependent goals, edge- and level-triggered firing, one goal in flight, the retry delay, retraction, goals no plan serves, and the goal bound; the intention lifecycle; perception and both middleware chains; directive negotiation (agreement, refusal and its verdicts, `not-understood`); terminal replies; queries, standing directives and `cancel`; `reply-to` and `reply-by`; delegation to this agent and to others, `spawn`, `continueWith` and recursive sub-goals, `waitFor`, and failure cascades; Contract Net on both sides, calling and bidding; receiver sets, envelope validation, and `protocol`, `language` and `ontology`; the agent's event stream; the timer loop's failure reporting and bounded `stop()`; in-memory bus delivery; and two-agent integration.

## License

MIT
