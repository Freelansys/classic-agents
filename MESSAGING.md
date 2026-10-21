# Messaging

How agents talk: the bus, the FIPA-ACL envelope, what a performative makes an
agent do, and how a sender follows the work it asked for.

- [The bus](#the-bus)
- [Messages](#messages)
- [The messaging protocol (FIPA-ACL)](#the-messaging-protocol-fipa-acl)
- [Assertions, directives and replies](#assertions-directives-and-replies)
- [Answering a directive: `agree` and `refuse`](#answering-a-directive-agree-and-refuse)
- [Envelope parameters](#envelope-parameters)
- [Perception and validation](#perception-and-validation)
- [The inbox](#the-inbox)
- [Following a request you sent](#following-a-request-you-sent)
- [Queries](#queries)
- [Standing directives](#standing-directives)
- [Directives the agent cannot act on](#directives-the-agent-cannot-act-on)
- [Other conversations](#other-conversations)

## The bus

Transport-agnostic message bus interface. Supports both point-to-point (`send`/`registerAgent`) and pub/sub (`publish`/`subscribe`) patterns. Ships with `InMemoryMessageBus`, for agents in one process. A transport across processes — Redis, NATS, a message broker — is yours to own: implement the `MessageBus` interface (four methods) over whatever your infrastructure already runs. The library deliberately ships none, so it carries no client dependency you may not use.

An agent can subscribe to topics with `agent.subscribe(topic)`. Published messages are drained into the agent's mailbox on the next `tick()` and processed identically to point-to-point messages. The returned function unsubscribes; subscriptions survive `stop()`/`start()` restarts.

Actions publish by setting `topic` on an entry in their result's `messages` (routed via `bus.publish`); point-to-point delivery uses `receiver` (routed via `bus.send`).

```typescript
// Point-to-point.
await bus.send("agent-id", {
  performative: "request",
  sender: "user",
  receiver: "agent-id",
  content: { goal: "deploy" },
  timestamp: Date.now(),
});

// Publish to a topic (all subscribers receive it).
await bus.publish("events", {
  performative: "inform",
  sender: "sensor",
  topic: "events",
  content: { temperature: 42, location: "server-room" },
  timestamp: Date.now(),
});
```

A message published to a topic is a broadcast, not an assertion about the
world: whether a subscriber believes it is still the subscriber's decision, and
`middleware` still applies. See [BELIEFS.md](BELIEFS.md) and
[MIDDLEWARE.md](MIDDLEWARE.md).

## Messages

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

## The messaging protocol (FIPA-ACL)

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
[Standing directives](#standing-directives) and
[Directives the agent cannot act on](#directives-the-agent-cannot-act-on).

## Assertions, directives and replies

**An assertion compels nothing.** FIPA's rational effect for `inform` is that
the receiver comes to believe it, but a rational effect is what the sender
intends, not a duty on the receiver, so becoming a belief is the receiver's
decision. The default is to accept: content keys land in the belief base under
`msg.<key>`, and no configuration is required to get it. A user who wants
something else says so with `middleware` — there is no second knob for the same
decision:

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

Empty by default, which means the write happens. The chain is async because
real authorization is, and a message stopped anywhere in it is reported as a
`belief:rejected` event. The assertion chain and the directive chain are
separate lists, and the split is deliberate: trusting a peer's *claims* and
agreeing to its *work* are different decisions. See
[MIDDLEWARE.md](MIDDLEWARE.md) for both chains, the verdicts, and the trust
model.

An assertion is believed with a **stance**: `inform` and `confirm` hold it
positively, `disconfirm` holds its negation. See [BELIEFS.md](BELIEFS.md).

A directive asks the receiver to act rather than to believe, so its content
never becomes a belief. A `request` becomes a goal: it expects
`{ goal: "goalName" }` in content, and an `agree` goes back to the sender naming
the id actually assigned. Queries and standing directives take their own paths,
described below.

A performative can be both classes at once. `request-when`, `request-whenever`
and `subscribe` are directives, and assertives too, since SC00037J defines them
as an `inform` of the sender's intention. But what they assert is the sender's
*intention* that the receiver act or report, not their content, so a directive's
content never reaches the belief base. They are honoured as directives; see
[Standing directives](#standing-directives) below.

An `agree` or `refuse` answering a directive is the one special case. An
`agree` is class-assertive, so on class alone it would be propositional and
believed like any other assertion. But both are bookkeeping — facts about a
conversation, not about the world. An `agree` emits `goalAcknowledged` and a
`refuse` emits `goalRefused`, and neither creates a belief, goal or intention,
since folding them into beliefs would let an unrelated plan act on a
bookkeeping message. A `confirm` that is *not* an answer to a directive is an
ordinary assertion, and is believed as one — see [BELIEFS.md](BELIEFS.md) for
why that is exact rather than approximate.

```typescript
// What each performative does, in one table.
import { directsAction, isPropositional } from "classic-agents/bus";

directsAction("request");        // true   → becomes a goal
directsAction("subscribe");      // false  → asks you to monitor, not to act
isPropositional("inform");       // true   → eligible for the belief base
isPropositional("failure");      // true   → a claim about what happened; filed under its exchange when it answers a request
isPropositional("inform-if");    // true   → the conditional is still an assertion
```

## Answering a directive: `agree` and `refuse`

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
  back as `when` — see [Standing directives](#standing-directives).
- **`refuse`** — declined, so no goal was created. Content carries
  `verdict: "no-plan" | "capacity" | "unsupported" | "declined" | "middleware"`
  and, where the agent supplied one, its own `reason` as free text. `no-plan` is
  no plan serving the goal; `capacity` is the goal queue having no room (or, for
  a query or a `cfp`, the evaluation limit); `unsupported` is a performative
  asking for something the agent does not honour — a `proxy` or `propagate`, or
  a `cfp` for a plan that does not bid — see
  [Directives the agent cannot act on](#directives-the-agent-cannot-act-on);
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
declined directive never becomes one. See [PERFORMATIVES.md](PERFORMATIVES.md)
› `request` › *The terminal reply*.

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
[MIDDLEWARE.md](MIDDLEWARE.md) › *Work is guarded too*. There is no separate
predicate any more; the chain is the one place a request is judged, which is
why it can both decline *and* say why in the same step.

## Envelope parameters

Every incoming message is validated against `MessageSchema` before it is
reasoned about, whatever transport delivered it — a bus carries bytes, and a
decoding transport can hand over a message missing its `sender`, with a field
of the wrong type, or not a message at all. A malformed message with a usable
`sender` is answered `not-understood`; with none there is nobody to answer, so
it is reported locally and dropped. Either way `message:rejected` fires (see
[EVENTS.md](EVENTS.md)).

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

## Perception and validation

Perception is the first step of the cycle: everything delivered since the last
`tick()` is taken out of the inbox, oldest first, and revised. Nothing is
decided at delivery time — a message is an event, and being told something is
not the same as having taken it in.

The whole sequence, and where in it the two middleware chains sit, is in
[ARCHITECTURE.md](ARCHITECTURE.md#the-bdi-reasoning-cycle).

## The inbox

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

## Following a request you sent

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
`goalRefused` events instead of a raw inbox (see [EVENTS.md](EVENTS.md)). Both
are bookkeeping, not world state, so they deliberately create no belief, goal or
intention — folding them into beliefs would put protocol bookkeeping into the
belief base, where only world state belongs:

```typescript
const caller = new Agent({ id: "caller", bus, planLibrary: lib });

const unsubscribe = caller.on("goalAcknowledged", (ack) => {
  // { agentId, goal, goalId, conversationId?, inReplyTo? }
  track(ack.goalId, ack.conversationId);
});
```

That is also how a coordinator notices a lost race on a pinned id: it asked for `goalId: "job-7"`, and `ack.goalId` comes back as something else.

Acks are queued when the request is processed and sent later in the same cycle, before terminal answers, so a `MessageHandler` stays synchronous. A `replyWith` you stamp on the request is echoed back as `inReplyTo` on the ack, and on the terminal `inform`/`failure` that ends the request. Requests the agent sent to itself are not acked.

An `Agent` that sent the request files those replies itself, under the request's exchange: `intent.<peer>.<goal>.<exchange>` goes `positive` on `agree`; `done.*` records the final `inform`, `failed.*` a `failure`, `infeasible.*` a `refuse`, and `unanswered.*` no reply by `reply-by`. To wait for work rather than track it, delegate it — see [DELEGATION.md](DELEGATION.md).

## Queries

`query-if` and `query-ref` ask the receiver to answer from knowledge it already
has. This library has no content language, so a query names a proposition or
expression the receiver has registered:

```typescript
propositions.register({ name: "raining", evaluate: (beliefs) => … });
// The peer sends: query-if { name: "raining" }
```

**A query reads; a request computes.** A proposition or expression must be a
quick read of what the agent already knows. It may be async because the belief
store may live in a database or a file, not so it can do work. That is what
lets queries be answered outside the goal queue, so a busy agent stays
queryable. An answer that takes real work — a service, a model, another agent,
several steps — belongs in a plan the asker invokes with a `request`; the plan
sets `ActionResult.result`, and the final `inform { goal, goalId, done: true,
result }` carries it back. Evaluations are still bounded as a safety net:
`evaluationTimeoutMs` each, and `maxConcurrentEvaluations` at once, past which a
query is refused with `verdict: "capacity"`.

**Queries only work between agents that share names.** FIPA's `query-if`
carries a proposition as its content (in SL, say), and `query-ref` a
referential expression. This library has no content language, so a query names
a proposition or expression the receiver has registered: `{ name: "raining" }`.
A standard FIPA peer that sends a proposition or descriptor as content is
answered `not-understood`, and a classic-agents query sent to such a peer will
not be understood either. Both sides must agree on the names, which is the
price of not owning an ontology.

Which keys a query opens on the sender's side, and what an answer does to them,
is in [BELIEFS.md](BELIEFS.md) › *Questions this agent asks* and
[PERFORMATIVES.md](PERFORMATIVES.md) › *Stance and the answers to queries*.

## Standing directives

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
  [desire](DESIRES.md) follows by default, so the two fire, wait for room and
  hold a missed edge alike.
- **An evaluation that throws** ends the commitment with `failure`.
- **`cancel`** with `inReplyTo` naming the directive ends it, and is answered
  `inform`. Only the sender may cancel. A plain request can be cancelled too:
  always if it has not started, and once started only if its plans are marked
  `cancellable: true`, between actions, after running each plan's `onCancel`
  clean-up. Otherwise the cancel is answered `failure`. See
  [PERFORMATIVES.md](PERFORMATIVES.md) › `cancel`.
- The sending agent tracks a subscription it sent at
  `subscription.<peer>.<name>.<exchange>`, which each update replaces.

The `subscribe` method on `Agent` is unrelated: it subscribes *this* agent's
inbox to a bus topic.

## Directives the agent cannot act on

The two acts in the CAL vocabulary the base agent declines are `proxy` and
`propagate`, the forwarding directives. Each asks the receiver to relay a
message on the sender's behalf, which this release does not do, and neither has
a plan a goal could be served by, so a message carrying one is answered
`refuse { verdict: "unsupported" }`. This follows JADE and SPADE, which carry
both acts without implementing forwarding; [PROXY.md](PROXY.md) holds the plan
for supporting `proxy`. `isUnsupportedDirective()` is exported if you want to
ask the same question, and a subclass that can honour such an act overrides
`handleUnsupportedDirective`. Every other directive in the CAL vocabulary —
including `cfp`, which is bid on or declined rather than treated as a request —
is honoured by the base agent.

A `cfp` a plan does not bid on is answered `refuse` with a `RefusalVerdict` the
sender already understands: `unsupported` when the plan does not bid, `no-plan`
when nothing serves the goal, `capacity` when the queue is full, and `declined`
when the bid expression answers no bid.

## Other conversations

- **Delegation** — a plan asks another agent for a goal and waits for the
  answer. [DELEGATION.md](DELEGATION.md).
- **Contract Net** — a plan calls for proposals, reads the bids and awards the
  work. [CONTRACT-NET.md](CONTRACT-NET.md) and
  [ARCHITECTURE.md](ARCHITECTURE.md#contract-net-in-brief).
- **Query vs request** — [Queries](#queries) above.
- **Standing directives** — [Standing directives](#standing-directives) above.
