# classic-agents

A classical Belief-Desire-Intention (BDI) agent framework for TypeScript.

classic-agents enables agent-oriented programming where agents maintain an explicit belief base, select among desires/goals, and execute intentions via a plan library. The reasoning cycle is deterministic and inspectable.

## Install

```bash
npm install classic-agents
```

## Architecture

### The BDI Reasoning Cycle

Each agent runs an asynchronous reasoning loop with these steps:

1. **Perceive** — take everything the bus has delivered since the last cycle out of the inbox (`agent.inbox`), oldest first. Nothing is decided yet: a message is an *event*, and being told something is not the same as having taken it in.
2. **Revise Beliefs** — decide what the perceived messages mean. An assertion about the world becomes a belief if — and only if — its `middleware` chain does not cancel the write; a directive becomes a goal unless its `directiveMiddleware` chain cancels it. This is where an agent chooses to believe, and chooses to work, rather than having either happen as a side effect of delivery.
3. **Deliberate** — promote the highest-priority eligible goal to active. Work only ever starts because a goal says it should: a plan is never selected by a belief alone, so every action can name the request it was for and be correlated with it.
4. **Means-Ends Reasoning** — for goals not already covered by an active intention, find an applicable plan from the plan library and instantiate an intention.
5. **Execute** — advance each active intention by one action step. Concurrent intentions execute in parallel via `Promise.allSettled`.
6. **Repeat** — the cycle runs as a free-running timer or can be driven manually via `tick()`.

Because perception is a step of the cycle and not of delivery, a message that arrives between two ticks changes nothing until the next one. That is what makes an agent's beliefs a record of what it decided, rather than of everything that was ever said to it.

### Package Layout

The code is organized into namespaced modules, exposed as subpath exports:

```
src/
├── index.ts         classic-agents              — main entry: core + bus
├── bus/             classic-agents/bus          — MessageBus interface + InMemoryMessageBus
├── core/            classic-agents/core         — Belief base, goals, plans, intentions, reasoning cycle
└── examples/        (not exported) — runnable demo agents
tests/                                         — all unit + integration tests
```

Import styles:

```typescript
import { Agent, InMemoryMessageBus } from "classic-agents"; // main entry (core + bus)
import { GoalQueue } from "classic-agents/core"; // core only
import { InMemoryMessageBus } from "classic-agents/bus"; // transport layer
```

### `classic-agents/bus`

Transport-agnostic message bus interface. Supports both point-to-point (`send`/`registerAgent`) and pub/sub (`publish`/`subscribe`) patterns. Ships with `InMemoryMessageBus` — swap in Redis Streams, NATS, etc. by implementing the `MessageBus` interface.

An agent can subscribe to topics with `agent.subscribe(topic)`. Published messages are drained into the agent's mailbox on the next `tick()` and processed identically to point-to-point messages. The returned function unsubscribes; subscriptions survive `stop()`/`start()` restarts.

Actions publish by setting `topic` on an entry in their result's `messages` (routed via `bus.publish`); point-to-point delivery uses `receiver` (routed via `bus.send`). `src/examples/main.ts` is a runnable two-agent demo: one asks the other to watch a temperature reading, the other waits for the reading, then acts on it.

#### Messaging Protocol (FIPA-ACL)

Messages carry a performative: a speech act typing what the sender is doing to
the conversation. Performatives are grouped by the **communicative-act class**
that determines what a receiver is obliged to do:

| Class | Performatives | Hearer effect |
|-------|---------------|---------------|
| **Assertive** | `inform`, `inform-if`, `inform-ref`, `confirm`, `disconfirm`, `failure`, `not-understood`, `agree`, `subscribe`, `request-when`, `request-whenever` | *none* — the sender asserts a proposition, the receiver decides what to do |
| **Directive** | `request`, `query-if`, `query-ref`, `request-when`, `request-whenever`, `subscribe`, `cfp` | the receiver is asked to act — or, for the queries, to answer from its own knowledge |
| **Declarative** | `cancel` | the sender brings the proposition about |
| **Expressive** | `refuse`, `reject-proposal`, `agree`, `cancel`, `disconfirm`, `failure` | *none* — the sender reports a state of mind |
| **Commissive** | `accept-proposal`, `propose` | *none* — the sender commits to a future action |

`propagate` and `proxy` are also accepted; FIPA assigns them no CA class, and
the agent treats them as non-propositional.

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

**The distinction that matters: an assertion compels nothing.** FIPA-ACL gives
`inform` no effect on the receiver at all, so becoming a belief is the
receiver's decision. The default is to accept: content keys land in the belief
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

A directive is the one performative with a compelled hearer effect, so it
becomes a goal. Expects `{ goal: "goalName" }` in content, and an `agree` goes
back to the sender naming the id actually assigned.

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
isPropositional("failure");      // false  → about the conversation, not the world
isPropositional("inform-if");    // true   → the conditional is still an assertion
```

A performative can be both classes at once. `request-when`, `request-whenever`
and `subscribe` are directives and, in FIPA's table, assertives too. But what
they assert is the sender's *intention* that the receiver act or report, not
their content, so a directive's content never reaches the belief base. They are
honoured as directives; see
[Standing Directives](#standing-directives-request-when-request-whenever-subscribe)
below.

An `agree` or `refuse` answering a directive is the one special case: both are
class-assertive, so on class alone they would be propositional and believed like
any other assertion. But *those* are bookkeeping — facts about a conversation,
not about the world. An `agree` emits `goalAcknowledged` and a `refuse` emits
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
  `verdict: "no-plan" | "capacity" | "unsupported" | "middleware"` and, where the
  agent supplied one, its own `reason` as free text. `no-plan` is no plan serving
  the goal; `capacity` is the goal queue having no room; `unsupported` is a
  performative asking for something the agent does not honour — a `cfp`, or
  cancelling a request already in progress — see
  [Directives the Agent Cannot Act On](#directives-the-agent-cannot-act-on);
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
`"no-plan"` and `"unsupported"` and false of `"capacity"`, which is backpressure
the same offer may be agreed to later. A sender must read the two apart, so every
verdict in the vocabulary is kept when a refusal is received, in `goalRefused`
and in the `infeasible.<peer>.<goal>.<exchange>` record. A received `failure`
closes its exchange the same way: `intent.*` goes negative and
`failed.<peer>.<goal>.<exchange>` records why.

Never both, and never an `agree` naming a goal the receiver dropped: a sender is
told what actually happened.

`refuse` is not `failure`. A failure means work was *undertaken and could not be
completed* — the action ran and broke, or returned `failure: { reason }`. A
refusal means the work was never started. Only a real failure leaves an
intention behind. The distinction is structural, not a convention: a `failure`
can only come from an action's own return value inside an executing intention,
and a declined directive never becomes one.

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
  receiver?: string;       // point-to-point target agent id
  topic?: string;          // pub/sub topic
  content: T;              // message payload
  conversationId?: string; // optional correlation id
  replyWith?: string;      // optional sender-stamped id, echoed back as inReplyTo
  inReplyTo?: string;      // optional id of the message this one answers
}
```

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

```typescript
interface Message<T = unknown> {
  performative: Performative;  // any FIPA-ACL performative
  sender: string;
  receiver?: string;       // point-to-point target agent id
  topic?: string;          // pub/sub topic
  content: T;              // message payload
  conversationId?: string; // optional correlation id
  replyWith?: string;      // optional sender-stamped id, echoed back as inReplyTo
  inReplyTo?: string;      // optional id of the message this one answers
  timestamp: number;
}
```

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

A goal that came from a directive keeps a `source` recording the message it came from, and that `source` is inherited by every sub-goal the plan spawns — so the sender can follow its own job through arbitrary decomposition and all the way to a failure event, without guessing ids.

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

Because the sender's id is predictable to it up front, it can also pre-register dependent goals by id (`dependsOn: ["goal-8f3c…"]`) — or pin the id itself.

**Goal ids.** A caller may pin the id with `content.goalId`; the agent honours it only while that id is free, since reusing a taken id would overwrite a live goal. Either way the sender is told which id was actually assigned, so it never has to guess:

```typescript
// Sender registers an inbox (or subscribes to the bus directly):
bus.registerAgent("ui", (msg) => {
  if (msg.performative === "agree") {
    // { goal: "deploy", goalId: "goal-8f3c…", conversationId: "chat-42" }
    track(msg.content.goalId, msg.content.conversationId);
  } else if (msg.performative === "refuse") {
    // { goal: "deploy", verdict: "capacity", reason: "goal queue is full (limit 4)" }
    offerLater(msg.content.goal, msg.content.reason);
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

Acks are queued when the request is processed and sent on the agent's next `tick()`, so a `MessageHandler` stays synchronous. A `replyWith` you stamp on the request is echoed back as `inReplyTo` on the ack. Requests the agent sent to itself are not acked.

### `classic-agents/core`

The BDI engine:

- **BeliefBase** — pluggable typed key-value belief store, holding a `BeliefStatus` (`"positive"`/`"uncertain"`/`"negative"`) beside each value so a `disconfirm` can record the sender's stance against the content it names. The `BeliefBase` interface defines the contract (`get`/`set`/`setStatus`/`statusOf`/`compareAndSet`/`remove`, prefix and predicate queries, `beliefAdded`/`beliefUpdated`/`beliefRemoved` events); the default backend is `InMemoryBeliefBase`. Inject any implementation via `Agent` config (e.g. a `RedisBeliefBase`), just like swapping message-bus transports.

`compareAndSet(key, expected, next)` performs an atomic, compare-and-swap update and resolves to `true`/`false`. `expected: undefined` means "the key is absent". Comparison is deep (structural), so object beliefs round-tripped through the bus compare correctly. In-memory it's a synchronous map check-and-set (atomic within the event loop); Redis implementations can back it with a Lua script so read-compare-write stays atomic across processes.

For convenience, `update(key, reducer)` runs the optimistic read → `reducer(current)` → write loop for you via `casUpdate` (the shared retry helper — `reducer` is re-invoked on contention, and the update counts as failed after 100 attempts). Use `set()` for blind single-writer / newest-fact-wins writes (e.g. applying inbound messages); use `compareAndSet`/`update` whenever the new value depends on the current one.

- **GoalQueue** — priority-based goal queue with pluggable selection strategy. Goals have statuses: `pending → active → achieved | failed | dropped`. Goals can declare dependencies on other goals via `dependsOn: string[]` — a goal is only selected when all its dependencies have achieved. Failed goals cause dependent goals to be dropped. Sub-goals created by an action's `newGoals` record where they came from: `parentGoalId` is the goal whose plan created them, and `rootGoalId` is the top of that chain (the parent's `rootGoalId`, or the parent's own id), so lineage survives the creating intention. The queue emits `goalAdded`, `goalStatusChanged`, `goalRejected` and `goalRemoved` for everything that happens to it (see [Events You Can Listen To](#events-you-can-listen-to)).

  Because an achieved goal is collected at the end of the cycle that finished it, the queue keeps a small separate record of achievements that something still depends on — `goals.achievedIds()`, or `goals.dependenciesMet(goal)` for the check itself. It is reference-counted against the goals that declare `dependsOn`, so the record is retained only while there is work waiting on it: an agent that never uses `dependsOn` retains nothing, and a goal that is waiting on a dependency nobody has achieved yet simply stays `pending`.

  Goals are **bounded, not rotated**. An agent holds at most `maxGoals` unfinished goals (`pending` + `active`, sub-goals included; default `1000`, `0` or `Infinity` for unbounded). A goal offered once the bound is reached is admitted and immediately failed rather than queued — the queue is full, so backpressure is the honest answer. Nothing is ever evicted to make room: a goal leaves the queue only after reaching `achieved`, `failed` or `dropped`, at the end of the cycle that finished it. So `goals.all()` is the agent's *current* work, not its history; read history off the event stream (see [Working Set and History](#working-set-and-history)).

- **PlanLibrary** — registers plans, each a `{ name, body }` where `name` is the goal it serves and `body` the actions it runs. There is no separate readiness test: a plan that serves a goal is the agent said to be able to do it. `declares(goalName)` is the static check that lets a directive be refused as `no-plan` before a goal exists; `match(goal)` returns the plan that serves a goal by name, or `undefined` when none does.

- **IntentionStack** — tracks active intentions with states: `pending → executing | waiting → completed | failed`. Intentions enter `waiting` when their action creates sub-goals (`newGoals`) and more plan actions remain — the parent pauses until all children achieve, then resumes. If sub-goals are created by the last action, the parent completes immediately and new goals become independent next steps. A sub-goal that *fails* also releases the parent, which fails with it (see [Action Failures](#action-failures)).

- **Agent** — orchestrates the full BDI cycle. Configurable for max concurrent intentions, `maxGoals`, `replyTimeoutMs` (the default FIPA `reply-by` stamped on every directive it sends, 30 s) and `evaluationTimeoutMs` (how long a proposition or expression may run before it is answered `failure`, 10 s). Replies always go to a message's `reply-to` when it names one; evaluations never block the reasoning cycle. See PERFORMATIVES.md › *`reply-to` and `reply-by`* and *Evaluating propositions and expressions*.

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

A goal the queue could not take fails immediately, which means the same two things a failed job does: an answer to whoever asked for it, and a parent waiting on that sub-goal failing with it. The answer differs by lineage. A **root** goal gets a `refuse`, since no `agree` went out for it. A **sub-goal** gets none: it carries its parent's `source`, so its requester is the one already holding an `agree` for the goal it did ask for, and FIPA allows no `refuse` after `agree` — the shed sub-goal fails its parent, and the requester hears the root goal's single `failure` instead. What sets the shed apart either way is the event that reports it: a goal shed for capacity is declined, never attempted, so it fires `goal:rejected` rather than `intention:failed`, and the `reason` names the limit:

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
| `goal:status` | `{ goal, from, to }` — the status it left and the one it took |
| `goal:rejected` | `{ goal, reason }` — refused for room; the goal is failed and never worked on |
| `goal:removed` | `Goal` — collected after it finished, at the end of that cycle |
| `intention:started` | `Intention` |
| `intention:advanced` | `{ intention, action, result }` — the action that just ran, and what it returned |
| `intention:waiting` | `{ intention, children }` — the sub-goal ids it is waiting for |
| `intention:completed` | `Intention` |
| `intention:failed` | `{ intention, reason }` |
| `intention:removed` | `Intention` — collected after it finished, at the end of that cycle |
| `message:received` | `Message` — point-to-point or on a subscribed topic, before it is processed |
| `message:sent` | `Message` — handed to the bus, from an action or an `agree`/`refuse` |
| `belief:accepted` | `{ agentId, keys, status, message }` — an assertion the agent believed, the belief keys it was stored under, and the stance it was held with (`"negative"` for a `disconfirm`) |
| `belief:rejected` | `{ agentId, reason, message }` — an assertion the agent was told about and did not believe; `reason` is `middleware` or `middleware threw: …` |
| `goalAcknowledged` | `GoalAck` — an `agree` answering a request this agent sent |
| `goalRefused` | `GoalRefusal` — a `refuse` answering a request this agent sent |

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

Two things to know about the payloads:

- **Goals and intentions are live objects.** `goal`/`intention` are the very objects the queue and stack hold, mutated in place as work progresses (`setStatus`, `advance`, …), so a handler that keeps one sees later changes. Snapshot it — `{ ...goal }` — to hold the state you saw; every other field is plain data and safe to serialise.
- **Handlers run synchronously**, on the cycle that raised the event, so they must not block; hand slow work to a queue. A handler that throws fails that cycle.
- **Finished items leave the stores.** A goal or intention is collected once it is terminal, at the end of the cycle that finished it, so `goal:removed` / `intention:removed` are the last event in a job's sequence. Within a cycle everything is still readable; across cycles, snapshot the stream rather than polling `all()`.

Goal events are delivered whether or not the agent is running, and survive `stop()`/`start()`. All of them cover only this agent's own work. A bus-wide view — or a view across processes — is the user's to build: map the events onto whatever channel she owns (`agent.on("intention:failed", e => channel.publish(e))`), which is plumbing classic-agents deliberately does not dictate.

#### Action Failures

An action signals failure by returning `failure: { reason }` in its `ActionResult` (or by throwing). Either way the intention and its goal are marked `failed`, goals that depend on it are `dropped`, and the `intention:failed` event reports it:

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

A failure never discards the rest of the action's result. When an action returns `failure` *alongside* `beliefUpdates`, `beliefRemovals`, `newGoals` or `messages`, every one of those is still applied before the intention is failed — partial progress is real progress. An action that reports a failure keeps that reported reason even if applying its other results subsequently throws.

#### Sub-goal Failures

An intention waiting on its sub-goals is released when one of them fails — a parent can never sit in `waiting` forever (which would also keep holding a `maxConcurrentIntentions` slot). By default the waiting parent fails too, with a reason naming the sub-goal, and the failure keeps cascading to *its* waiting parents until the top-level goal fails:

```
sub-goal "build" failed: 503 from registry
```

Every intention that fails this way reports the same `intention:failed` event as any other failure.

#### Goal Achieved

When a goal reaches `achieved`, the `intention:completed` event reports it, carrying the completed intention — its goal, plan, and the `result` of the last action:

```typescript
agent.on("intention:completed", (intention) => {
  console.log(`${intention.goal.name} achieved`, intention.result);
});
```

The completed intention mirrors a failure report: the same `parentGoalId`/`rootGoalId` lineage and the same `source` for goals that came from a directive, so completions route back to whoever asked for the work. A monitor watching both `intention:failed` and `intention:completed` sees a job end to end.

Replying to whoever requested a goal is left to the plan that requested it, which knows the reply shape its caller needs — an automatic reply would force every request to carry the whole follow-up logic.

Plans that can recover from a failed sub-goal say so:

```typescript
lib.register({
  name: "deploy",
  onChildFailure: "continue", // "fail" (default) | "continue"
  body: [
    {
      name: "prepare",
      execute: async () => ({
        newGoals: [
          { name: "build", priority: 10 },
          { name: "test", priority: 9 },
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

With `"continue"` the failed sub-goal leaves the parent's pending set, the reason is recorded in `intention.childFailures`, and the parent resumes with its next action once no sub-goal is left outstanding — remaining sub-goals are still awaited rather than abandoned.

#### Plans Serve Goals by Name

A plan carries two things: a `name` and a `body`. The `name` is the goal it
serves, and the body is the work that goal takes. Registering a plan named
`deploy` is the agent saying it can `deploy`, and nothing more: the moment a
`deploy` goal exists, means-ends reasoning finds that plan and starts it.

```typescript
lib.register({
  name: "handle-reading",   // the goal it serves
  body: [/* … */],
});
```

There is no readiness test between the goal and the body. A plan is a
capability, so a matching goal is always a match; whether the work *can* proceed
is the body's business, and the body reports a `failure` when it cannot. This is
deliberate: gating work inside the agent on a belief only the agent holds is a
`request-when` the sender never named, so a condition is always the sender's to
declare — see
[Standing Directives](#standing-directives-request-when-request-whenever-subscribe).

`declares()` reports whether some plan serves a goal name. It is checked against
a plan library that is fixed for the agent's lifetime, so a plan registered
*after* a request was refused will not retroactively rescue it. That is the
trade for answering honestly at admission instead of agreeing and stalling: an
unservable request can never occupy a `maxGoals` slot.

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
- **An evaluation that throws** ends the commitment with `failure`.
- **`cancel`** with `inReplyTo` naming the directive ends it, and is answered
  `inform`. Only the sender may cancel. Cancelling a request that is already
  running is refused `unsupported`.
- The sending agent tracks a subscription it sent at
  `subscription.<peer>.<name>.<exchange>`, which each update replaces.

The `subscribe` method on `Agent` is unrelated: it subscribes *this* agent's
inbox to a bus topic.

#### Directives the Agent Cannot Act On

One FIPA directive is still refused with `verdict: "unsupported"`: `cfp`. It
asks for a proposal inside a negotiation, and this library keeps no negotiation
state. Reading it as a request would do the one thing the sender did not ask
for. The test is derived from the CA taxonomy rather than a list of names, so a
directive added to the vocabulary later cannot slip through to do nothing at
all. `isUnsupportedDirective()` is exported if you want to ask the same
question.

If your agent can negotiate, extend `Agent` and override one method:

```typescript
class BiddingAgent extends Agent {
  protected override async handleUnsupportedDirective(msg: Message): Promise<void> {
    if (this.wantsToBid(msg)) {
      // Hand it to ordinary admission: the plan check, the goal bound and the
      // `agree` all apply as they would for a `request`.
      await this.considerDirective(msg, 5);
    } else {
      // Answers in the standard shape: one `goal:refused`, one `refuse` on the
      // wire, carrying a `RefusalVerdict` the sender already understands.
      this.declineDirective(msg, "middleware", { reason: "not bidding" });
    }
  }
}
```

#### Goal Decomposition

Plans can automatically decompose goals into sub-goals:

```typescript
lib.register({
  name: "deploy",
  body: [
    {
      // Action 0: decompose into sub-goals, then pause
      name: "prepare",
      execute: async () => ({
        newGoals: [
          { name: "build", priority: 10 },
          { name: "test", priority: 9 },
        ],
      }),
    },
    // Waits for build + test to achieve...
    {
      // Action 1: runs after all sub-goals complete
      name: "release",
      execute: async () => ({ beliefUpdates: [{ key: "deployed", value: true }] }),
    },
  ],
});

// Sequential goals — last action completes immediately, spawning independent next steps:
lib.register({
  name: "onboard",
  body: [
    {
      execute: async () => ({
        beliefUpdates: [{ key: "accountCreated", value: true }],
        newGoals: [{ name: "setupProfile", priority: 10 }],
      }),
    },
    // No more actions → parent completes, setupProfile runs next tick independently
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

## Quick Start

```bash
npm install
npm test
npm run example   # run the two-agent demo
```

### Creating an Agent

```typescript
import { Agent, InMemoryMessageBus, PlanLibrary } from "classic-agents";

const bus = new InMemoryMessageBus();
const lib = new PlanLibrary();

lib.register({
  name: "greet",
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
agent.start();
agent.goals.add({ id: "g1", name: "greet", priority: 10, status: "pending" });

// Let the reasoning cycle run
await agent.tick();
agent.stop();
```

## Testing

```bash
npm test                  # run all tests
npm run test:watch        # watch mode
```

Tests cover: belief base CRUD and events, goal queue selection and events, plan matching by name, intention lifecycle, directive negotiation (agreement, refusal and the `no-plan` answer), agent and goal-queue event streams, multi-step plans and sub-goal failure cascades, in-memory bus delivery, a full two-agent integration test, and Redis-backed bus and belief storage.

## License

MIT
