# Beliefs

The belief base is the agent's model of the world: a typed key-value store
where each value carries the **stance** the agent holds it with. This file
covers the store's API and the stance model; what an agent is allowed to write
is [MIDDLEWARE.md](MIDDLEWARE.md).

- [The belief base](#the-belief-base)
- [Stance](#stance)
- [`confirm` and `disconfirm`](#confirm-and-disconfirm)
- [Questions this agent asks](#questions-this-agent-asks)
- [Restoring an agent](#restoring-an-agent)
- [Seeing what changed](#seeing-what-changed)

## The belief base

`BeliefBase` is a pluggable typed key-value store, holding a `BeliefStatus`
(`"positive"`/`"uncertain"`/`"negative"`) beside each value so a `disconfirm`
can record the sender's stance against the content it names. The interface
defines the contract (`get`/`set`/`setStatus`/`statusOf`/`compareAndSet`/`remove`,
prefix and predicate queries, `beliefAdded`/`beliefUpdated`/`beliefRemoved`
events); the default backend is `InMemoryBeliefBase`. Inject any implementation
via `Agent` config (`beliefs`) — one backed by Redis, say — just like swapping
message-bus transports.

```typescript
agent.beliefs.set("room.temperature", 31);
agent.beliefs.get<number>("room.temperature");        // 31
agent.beliefs.get("room.humidity");                   // undefined
agent.beliefs.query((key) => key.startsWith("room.")); // matching entries
agent.beliefs.all();                                  // every value, by key
agent.beliefs.remove("room.temperature");
```

`compareAndSet(key, expected, next)` performs an atomic, compare-and-swap update and resolves to `true`/`false`. `expected: undefined` means "the key is absent". Comparison is deep (structural), so object beliefs round-tripped through the bus compare correctly. In-memory it's a synchronous map check-and-set (atomic within the event loop); Redis implementations can back it with a Lua script so read-compare-write stays atomic across processes.

For convenience, `update(key, reducer)` runs the optimistic read → `reducer(current)` → write loop for you via `casUpdate` (the shared retry helper — `reducer` is re-invoked on contention, and the update counts as failed after 100 attempts). Use `set()` for blind single-writer / newest-fact-wins writes (e.g. applying inbound messages); use `compareAndSet`/`update` whenever the new value depends on the current one.

Actions and desires read the same store: a plan's `execute(intention, beliefs)`
receives it, and a `Plan.context`, a `Desire.intend`, a proposition or an
expression all evaluate against it. Those reads should be cheap and
side-effect free.

## Stance

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

Keys stay value-independent, so `msg.temp` is "whatever is currently claimed
about temp". A `disconfirm` therefore negates whatever stands there now, and a
later `inform` replaces it — last write wins, consistently with the rest of the
store.

## `confirm` and `disconfirm`

`confirm` and `disconfirm` are answered like any other assertion: they go
through the belief `middleware` chain, and a `confirm` lands exactly as an
`inform` would. The difference is the stance:

| Act | Stored | `statusOf` |
| --- | --- | --- |
| `inform` | the content | `"positive"` |
| `confirm` | the content | `"positive"` |
| `disconfirm` | the content, unchanged | `"negative"` |

`belief:accepted` reports the stance the write was made with, and
`beliefAdded`/`beliefUpdated` report a `status` and `previousStatus`, so a
stance change is visible even when the value did not move. See
[EVENTS.md](EVENTS.md).

A `disconfirm` that answers a directive is not an ordinary assertion: like an
`agree` or `refuse`, it is bookkeeping and is settled as part of the exchange,
not written to the belief base. See [MESSAGING.md](MESSAGING.md) › *Assertions,
directives and replies*.

## Questions this agent asks

Every `query-if` or `query-ref` an agent sends opens
`answer.<peer>.<name>.<exchange>` as `"uncertain"`, where `<exchange>` is the
query's `replyWith`. The answer settles it with the result, held positive:
a `query-if` answered `false` is `false`, held positive, meaning "it does not
hold". A refusal, failure or `not-understood` removes it and records why at
`unanswered.<peer>.<name>.<exchange>`.

This is how "I asked and do not know yet" is distinguishable from "I never
asked" — the difference between an uncertain belief and an absent one. See
[PERFORMATIVES.md](PERFORMATIVES.md) › *Stance and the answers to queries* for
the decisions.

## Restoring an agent

The agent keeps its own state in the belief base it was given, under the
prefix `AGENT_STATE_PREFIX` (`"~agent."`), so a belief base that persists what
it holds restores the agent with it. There is no separate store to write: a
persistent belief base is the whole job.

What is kept:

- **Goals**: each unfinished goal, sub-goals included (`~agent.goal.<id>`),
  with its `data`, `source`, `dependsOn` and `when`, and a marker for an
  achieved goal another one still depends on (`~agent.achieved.<id>`).
- **Intentions** (`~agent.intention.<id>`): each unfinished intention, with
  its plan by name and the names of the plan's actions, the action it is at,
  the last action's result, and the delegations, calls and proposals it made
  with their outcomes so far.
- **Conversations** (`~agent.conv.<kind>.<id>`): `request-whenever` and
  `subscribe` commitments, with what their condition last did and a
  subscription's last value; directives agreed to and not yet answered;
  queries, requests and cancels sent and still awaiting an answer; directives
  the middleware chain deferred; bids not yet decided, made and received; the
  proposals and delegations a plan is waiting on; and the protocol of each
  exchange.
- **Desires** (`~agent.desire.<name>.<item>`): what each item's trigger last
  saw, and the goal it has in flight.

The first `start()` puts all of it back before the first cycle:

```typescript
const agent = new Agent({ id, bus, planLibrary, beliefs: myPersistentBeliefBase });
await agent.start(50); // restores first
```

- An intention is resumed where it was, if its plan is still registered with
  the same actions, by name and in order:
  - An action that was running when the agent stopped runs again. The actions
    before it do not: only the interrupted one may run twice, so it is the
    one that should be safe to repeat.
  - An intention waiting on work it handed out goes on waiting for it. Its
    sub-goals are restored with it, a remote delegation or a proposal it made
    stays open for the peer's answer, and a call it opened stays open, with
    the bids it already had.
- An intention whose plan changed, or is no longer registered, is not
  resumed. Its goal is `pending` again and planned afresh from its first
  action, and the work its old intention handed out is ended:
  - Its sub-goals are dropped, since the plan makes them again.
  - A remote delegation or a proposal it made is cancelled with the peer.
  - A bid on a call it opened that was still undecided is answered
    `reject-proposal { reason: "agent restarted" }`. A bid that arrives later
    naming the old call is answered as a bid on no call is.
- Bids on a call sent through `messages` are the application's to answer, and
  are left alone.
- A standing commitment does not fire or report again for a condition that
  already held, or a value that has not changed.
- A desire does not fire again for a goal it still has in the queue, or for
  an occurrence it already acted on. The desire has to be registered by the
  first `start()`, as one built into the agent's config is: what a desire
  missing then had kept is removed.
- A directive agreed to whose goal is not there any more is answered with
  `failure { reason: "agent restarted before it finished" }`.
- A bid whose plan is no longer registered is dropped. Plans are found by name.

An intention is written as it changes, like the rest: the agent tracks every
change made in it, whoever makes it, and writes the intention once the
change is made. An action's effects are applied before the intention moves
past it, so an agent that stops between the two runs that action again.
The record is a copy, and only a restart reads it: the live intention, which
plans read, keeps whatever was put in it. So what a plan puts in an
intention, such as an action's result or the data its delegations carry,
only has to survive the copy:

- Functions are never kept.
- `InMemoryBeliefBase` keeps anything structured clone can copy, such as a
  `Date`, a `Map` or an `Error`. A class instance keeps its fields but not its
  prototype.
- A belief base that stores JSON keeps only what JSON can hold, so there it
  should be plain JSON.

Plans, desires, expressions and peers never see these keys: `agent.beliefs` is
a `BeliefView` over the belief base that leaves them out of reads, queries,
`all()` and change events, and refuses to write them. A belief base of your
own receives them like any other key, so it must store plain JSON values, and
should answer `queryByPrefix` without walking every key, since the agent reads
its own prefix on start. `InMemoryBeliefBase` keeps its keys in a B+ tree
([sorted-btree](https://www.npmjs.com/package/sorted-btree)) for this, so its
queries and `all()` list keys in key order.

## Seeing what changed

```typescript
agent.beliefs.on("beliefUpdated", ({ key, value, previousValue, status, previousStatus }) => {
  log.info(`${key}: ${previousValue} -> ${value} (${previousStatus} -> ${status})`);
});
agent.on("belief:rejected", ({ reason, message }) => {
  log.warn({ from: message.sender, reason }, "assertion not believed");
});
```

The full event catalogue is in [EVENTS.md](EVENTS.md). To change what an agent
believes at all — an allow-list, an authorization service, a schema check — use
the `middleware` chain in [MIDDLEWARE.md](MIDDLEWARE.md).
