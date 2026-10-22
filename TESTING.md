# Testing

`classic-agents/testing` lets you test a plan without an agent, a bus or a
hand-built `Intention`. This page is the reference; the tutorial has a
short [worked example](GETTING-STARTED.md#step-7-testing-a-plan).

- [Testing your plans](#testing-your-plans)
- [Testing the library](#testing-the-library)

## Testing your plans

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

The helpers are:

| Helper | What it does |
| --- | --- |
| `runAction(plan, action, options)` | runs one step; applies its belief updates, runs `onPlanFailure` on failure, returns `result`/`failure`/`beliefs` |
| `runPlan(plan, options)` | runs the whole plan on a real agent and returns a trace |
| `fixtureIntention(plan, overrides)` | builds an `Intention` for a plan, with delegations, child failures and data |
| `actionOf(plan, name)` | the `Action` of that name in a plan |

`tests/getting-started.test.ts` is the guide's walkthrough as a test and is a
good starting point for your own.

## Testing the library

```bash
npm test                  # run all tests
npm run test:watch        # watch mode
```

Tests cover: belief base CRUD, stance and events; goal queue selection, bounds and events; plan matching by name, context conditions, alternative-plan fallback, `onPlanFailure`, `onGoalFailure` and `goal:failed`; desires — intent evaluation, situation-dependent goals, edge- and level-triggered firing, one goal in flight, fanning out per item, the retry delay, retraction, goals no plan serves, and the goal bound; the intention lifecycle; perception and both middleware chains; directive negotiation (agreement, refusal and its verdicts, `not-understood`); terminal replies; queries, standing directives and `cancel`; `reply-to` and `reply-by`; delegation to this agent and to others, `spawn`, `continueWith` and recursive sub-goals, `waitFor`, and failure cascades; Contract Net on both sides, calling and bidding; receiver sets, envelope validation, and `protocol`, `language` and `ontology`; the agent's event stream; the timer loop's failure reporting and bounded `stop()`; in-memory bus delivery; and two-agent integration.
