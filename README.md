# classic-agents

A classical Belief-Desire-Intention (BDI) agent framework for TypeScript.

classic-agents enables agent-oriented programming where agents maintain an explicit belief base, select among desires/goals, and execute intentions via a plan library. The reasoning cycle is deterministic and inspectable.

- **Beliefs** with stance — what an agent was told, and whether it holds it positively, negatively, or is still uncertain.
- **Goals** with priorities, dependencies and lineage; **plans** that serve goals by name, with alternative plans chosen by context.
- **Messaging** in the full FIPA-ACL vocabulary — `request`, `inform`, queries, standing directives, `cancel`, Contract Net, delegation — over any transport you implement.
- **Observability** — a typed event stream for every step of the cycle, with no polling.
- **Testable plans** — run a single action or a whole plan without a bus.

## Install

```bash
npm install classic-agents
```

## Quick start

```bash
npm install
npm test
npm run example:getting-started  # the guided tour: request, publish, failure, paging, events
npm run example                  # two agents: an inform, then a request that acts on it
npm run example:delegation       # a shop delegating to a warehouse and a courier
npm run example:contract-net     # a builder calling for quotes and awarding the cheapest
npm run example:queries          # queries that read vs a request that computes a result
npm run example:race             # ask three mirrors for the same rate, take the first answer
npm run example:standing         # subscribe and request-when, then cancel
```

Each example lives in `src/examples/` and prints what goes on the wire;
[EXAMPLES.md](EXAMPLES.md) explains what each one shows. The walkthrough in
[GETTING-STARTED.md](GETTING-STARTED.md) builds one agent end to end.

### Creating an agent

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

Or let a request create the goal for you — see
[GETTING-STARTED.md](GETTING-STARTED.md).

## Package layout

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

## How it works

Each agent runs an asynchronous reasoning loop. One cycle — one `tick()` —
perceives what the bus delivered, revises beliefs and turns directives into
goals, expires what has waited too long, reconsiders desires, selects goals,
starts the plans that serve them, runs one action of each, and answers whoever
is owed a reply. A goal is worked only because something wants it — a request,
a standing directive, a desire, a parent plan — so every action can name the
goal it was for.

The cycle runs on a timer (`agent.start(50)`) or by hand (`agent.tick()`), and
every step is observable on the event stream. [ARCHITECTURE.md](ARCHITECTURE.md)
takes the cycle apart step by step.

## Documentation

| Document | What it covers |
| --- | --- |
| [GETTING-STARTED.md](GETTING-STARTED.md) | build an agent end to end, with runnable code |
| [ARCHITECTURE.md](ARCHITECTURE.md) | the reasoning cycle, the stores, goal lifecycle, plans, failure hooks |
| [MESSAGING.md](MESSAGING.md) | the bus, FIPA-ACL, `agree`/`refuse`, the inbox, following a request, queries, standing directives |
| [BELIEFS.md](BELIEFS.md) | the belief base, stance, `confirm`/`disconfirm` |
| [MIDDLEWARE.md](MIDDLEWARE.md) | the belief and directive chains, and the trust model |
| [DESIRES.md](DESIRES.md) | goals the agent starts itself |
| [EVENTS.md](EVENTS.md) | every event, with its payload |
| [TESTING.md](TESTING.md) | the `classic-agents/testing` helpers |
| [EXAMPLES.md](EXAMPLES.md) | the runnable examples, and what each shows |
| [DELEGATION.md](DELEGATION.md) | delegating in depth: deadlines, cancelling, `continueWith`, failure handling |
| [CONTRACT-NET.md](CONTRACT-NET.md) | the Contract Net protocol and its design |
| [PERFORMATIVES.md](PERFORMATIVES.md) | how each of the 22 FIPA acts is handled, and why |
| [PROXY.md](PROXY.md) | the plan for `proxy`/`propagate` forwarding |
| [FIPA-COMPLIANCE.md](FIPA-COMPLIANCE.md) | the compliance checklist |
| [CHANGELOG.md](CHANGELOG.md) | release history |

`classic-agents` deliberately has no content language: content is JSON, and
queries and conditions name propositions or expressions the receiver has
registered. That keeps the library small and lets you own your ontology. The
trade-offs are documented where they arise.

## License

MIT
