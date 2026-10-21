# Beliefs

The belief base is the agent's model of the world: a typed key-value store
where each value carries the **stance** the agent holds it with. This file
covers the store's API and the stance model; what an agent is allowed to write
is [MIDDLEWARE.md](MIDDLEWARE.md).

- [The belief base](#the-belief-base)
- [Stance](#stance)
- [`confirm` and `disconfirm`](#confirm-and-disconfirm)
- [Questions this agent asks](#questions-this-agent-asks)
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
