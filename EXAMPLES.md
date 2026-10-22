# Examples

Every example is a runnable script in [`src/examples/`](https://github.com/Freelansys/classic-agents/tree/main/src/examples) that
prints what goes on the wire. They are not exported from the package; run them
with `npm run example:<name>` after `npm install`.

| Command | Shows |
| --- | --- |
| `npm run example:getting-started` | the whole tutorial: request, publish, failure, paging, events |
| `npm run example` | two agents: an `inform`, then a `request` that acts on it |
| `npm run example:delegation` | a shop delegating to a warehouse and a courier, with results and progress |
| `npm run example:contract-net` | a builder calling for quotes and awarding the cheapest |
| `npm run example:queries` | a query that reads vs a request that computes |
| `npm run example:race` | ask three mirrors for the same rate, take the first answer |
| `npm run example:standing` | `subscribe` and `request-when`, then `cancel` |

## `getting-started`

[`src/examples/getting-started.ts`](src/examples/getting-started.ts)

The one to read first. A pricing agent answers a `request` (`agree`, then
`inform` with the result), publishes the quote to a topic that a dashboard
agent subscribes to, reports a `failure` for work it cannot do, and pages
through a catalogue with `continueWith`. The same script wires up event
listeners, and its flow is reproduced as a test in
[`tests/getting-started.test.ts`](tests/getting-started.test.ts).

Read [GETTING-STARTED.md](GETTING-STARTED.md) alongside it: the guide is the
prose, the script is the code.

```bash
npm run example:getting-started
```

## `main`

[`src/examples/main.ts`](src/examples/main.ts) — `npm run example`

The smallest complete exchange: a `sender` agent's plan sends an `inform` to a
`monitor`; the monitor's belief base receives it under `msg.*`, and a goal on
the monitor triggers a plan that reads those beliefs. It is the best example of
two things:

- an assertion lands in beliefs as `msg.temperature` / `msg.location`, with no
  handler written for it;
- a `request` runs on the *next* cycle, so the receiver should have the data in
  hand before it is asked (the comment in `log-alert` explains why).

Read [MESSAGING.md](MESSAGING.md) and [BELIEFS.md](BELIEFS.md).

## `delegation`

[`src/examples/delegation.ts`](src/examples/delegation.ts) — `npm run example:delegation`

A shop takes an `order` and splits it:

- `pack` is a sub-goal the shop serves itself (a self-delegation);
- `pick` is delegated to the warehouse, whose plan answers with a `result`;
- `deliver` is delegated to the courier, which sends progress notes;
- `audit` is `spawn`ed, and the order never waits for it.

The shop's next action reads all three delegation results and answers the
customer with its own. Watch for `intention:waiting`, `delegation:progress` and
`delegation:settled` in the log.

Read [DELEGATION.md](DELEGATION.md).

## `contract-net`

[`src/examples/contract-net.ts`](src/examples/contract-net.ts) — `npm run example:contract-net`

A builder calls for proposals for `pave`, inviting two pavers. Each paver bids
through a `bid` expression computing a price from its own beliefs; the result
becomes the `propose`'s terms. The builder waits for the calls to close, awards
the lowest bid, and the framework sends the loser `reject-proposal`. The winner
is sent `accept-proposal`, does the work and answers with `inform`.

This is the counterpart to `race`: use Contract Net when only the chosen
provider should act, because providers differ in what they offer.

Read [CONTRACT-NET.md](CONTRACT-NET.md) and
[ARCHITECTURE.md](ARCHITECTURE.md#contract-net-in-brief).

## `queries`

[`src/examples/queries.ts`](src/examples/queries.ts) — `npm run example:queries`

An inventory agent answers two kinds of question:

- `query-if` / `query-ref` name a registered proposition or expression — a
  quick read of what the agent already knows, answered outside the goal queue;
- a quote takes real work, so it is a plan invoked with `request`, and the
  final `inform` carries its `result`.

The example also shows the names-not-propositions limitation: both sides must
agree on the name.

Read [MESSAGING.md](MESSAGING.md#queries).

## `race`

[`src/examples/race.ts`](src/examples/race.ts) — `npm run example:race`

Three mirror agents answer the same `rate` lookup after different numbers of
steps. `waitFor: "any"` resumes the plan with the first answer and sends
`cancel` to the rest; the mirrors are `cancellable: true`, so the losers stop.
A mirror that fails does not end the race — only all three failing would.

A race is for **interchangeable, idempotent** work. See
[DELEGATION.md](DELEGATION.md) › *Failure handling*.

## `standing`

[`src/examples/standing.ts`](src/examples/standing.ts) — `npm run example:standing`

A home agent agrees to watch the temperature:

- `subscribe` names an expression: the value is reported now, and again on
  every change, until cancelled;
- `request-when` names a goal and a proposition: the goal is worked the first
  time the proposition holds.

The sender names the condition; the receiver owns the implementation. The
example ends by cancelling both.

Read [MESSAGING.md](MESSAGING.md#standing-directives).
