# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `GETTING-STARTED.md`, a walkthrough that builds one agent end to end, with
  the runnable `src/examples/getting-started.ts`
  (`npm run example:getting-started`) and `tests/getting-started.test.ts`
  checking what it shows.
- Reference docs split out of the README: `ARCHITECTURE.md`, `MESSAGING.md`,
  `BELIEFS.md`, `MIDDLEWARE.md`, `DESIRES.md`, `EVENTS.md`, `TESTING.md` and
  `EXAMPLES.md`. The generated API docs include them.

### Changed

- `README.md` is now an introduction, a quick start and a map of the docs.

### Fixed

- The payload types of `goal:replanned` and `goal:failed`, and the types
  `onGoalFailure` takes and returns, were not exported: `GoalReplanned`,
  `GoalFailed`, `GoalFailure`, `GoalFailureResult` and `PlanAttempt` are now
  exported from `classic-agents/core` (and `classic-agents`).

## [1.6.0] - 2026-10-20

### Changed

- `defaultGoalSelection` holds back only the *same* goal, not every goal of
  the same name. Goals are the same when they share a name and a `goalKey`:
  their explicit `Goal.key` when set, otherwise their `data` compared by value
  (as JSON, object keys in any order). Goals of one name about different
  things — a `qualify` per lead — now run side by side, while a duplicate of a
  goal still waits for it to finish. Goals without data, and goals whose data
  cannot be serialised, are compared by name alone, as before. An agent that
  relied on every goal of a name running one at a time can restore that with
  `goalSelection`. The recursion exemption follows the same rule: a sub-goal
  is exempt under a waiting ancestor that is the same goal.

### Added

- `Goal.key?: string`: what makes a goal the one it is among goals of its
  name, for when `data` carries values that change while it is still the same
  goal (a score, a timestamp). `goalKey(goal)` (in `classic-agents/core`)
  returns the comparison the default selection uses, for custom ones.
- Desires can fan out. `intend` may return a list of goal descriptors — one
  per item that needs work — instead of one, and each item is tracked on its
  own: its own trigger, rising edge, goal in flight, retry delay and
  retraction. An item missing from the list has stopped asking; `[]` is not
  asking. Items are told apart by the new `DesiredGoal.key`, recorded as the
  generated goal's `Goal.key`, or else by goal name and data. Two items of one
  answer with the same key are reported on `desire:error`, and only the first
  fires. A desire returning a single goal behaves exactly as before.
- `Trigger.idle(now?)`: whether a trigger holds nothing worth keeping, so a
  caller watching many conditions can discard idle ones. Desires drop an
  item's trigger this way once the item has left and its goal is done.

## [1.5.0] - 2026-10-20

### Added

- `AgentConfig.goalSelection?: GoalSelectionFunction` lets an agent choose how
  its next pending goal is picked, passed through to the `GoalQueue`. Defaults
  to `defaultGoalSelection`, so existing agents are unchanged. An application
  whose same-named goals are independent can now run them in parallel, for
  example by wrapping `defaultGoalSelection` and filtering the names it wants
  exempt from the same-name rule out of `active`.

## [1.4.0] - 2026-10-15

### Added

- **Desires** — goals an agent generates from its own beliefs, without a
  directive on the bus. `DesireLibrary` (in `classic-agents/core`, alongside
  `PlanLibrary`) registers `Desire` rules: `{ name, intend, trigger?, retryAfterMs?,
  onRetract? }`.
  `intend(beliefs)` is a pure, synchronous function — held to the same
  discipline as `Plan.context` — returning the goal descriptor
  (`{ goal, priority?, data?, dependsOn? }`, the same shape an action
  `spawn`s) to pursue now, or `undefined` for "not asking"; one that throws
  is reported on `desire:error` and changes nothing. Because the goal is returned rather than applied,
  `intend` has no side effects and is safe to re-evaluate every cycle, which is
  how the agent watches for the moment the desire begins — and stops — asking.
  A desire with no goal already in flight generates one. That goal is otherwise
  ordinary — queued, selected, planned, executed, cancellable, subject to
  `onGoalFailure`, free to `spawn`/delegate/`continueWith` — but carries no
  `source`, so the agent owes nobody a reply. `trigger: "edge"` (the default)
  fires on the rising edge of the asking; `"level"` fires again once the
  previous goal finishes, while it keeps asking. After a goal fails, a desire
  waits `retryAfterMs` (default 1000, `DEFAULT_DESIRE_RETRY_MS`) before firing
  again. A goal no plan serves is not generated. `onRetract: "withdraw"`
  withdraws the goal in flight when the desire stops asking, under the rules a
  `cancel` follows. At the goal bound a desire waits for room rather than
  generate a goal the queue would reject; when only some fit, the highest
  priority goes first.
- `AgentConfig.desires?: DesireLibrary` wires a library in; the generated goal
  records `Goal.desire` (attribution only), and each firing emits a
  `desire:triggered` (`DesireTriggered: { desire, goal }`) event. A desire
  that cannot be acted on emits `desire:error` (`DesireError`), and a
  retraction `desire:retracted` (`DesireRetracted`).
- `Trigger` (in `classic-agents/core`): the firing rule — edge or level, a
  firing held until the goal queue has room, one goal in flight, a retry delay
  after failure — shared by desires and standing `request-when` /
  `request-whenever` directives, so both behave alike.

## [1.3.0] - 2026-10-13

### Added

- `classic-agents/testing`: helpers for unit-testing your own plans.
  `actionOf(plan, name)` looks a step up by name and throws on a missing or
  shared one. `fixtureIntention(plan, options?)` builds the intention an action
  receives, with every field defaulted and fixed ids; `results` seeds sub-goal
  answers by goal name, and `delegations`, `childFailures` and `calls` seed the
  rest. `runAction(plan, name, options?)` runs one step against it the way the
  agent does: it applies the step's belief updates and, on a `failure` or a
  throw, runs `onPlanFailure` and applies the hook's. It returns
  `{ result, failure, beliefs, intention }`.
- `runPlan(plan, options?)` in `classic-agents/testing`: runs a plan to the end
  on a real agent over an in-memory bus and returns a `RunPlanTrace`:
  `outcome` (`"achieved" | "failed" | "continued" | "unfinished"`), the
  `steps` run, the goal's `result`, `continueWith`, `failure`, `delegations`,
  the `messages` sent and the `beliefs`. `subGoals` answers each delegated
  goal by name, with an `ActionResult` or a function of the sub-goal's data: a
  self-delegation through a stub plan, a delegation to another agent through a
  stub agent of that id.

## [1.2.0] - 2026-10-13

### Added

- `Plan.context?: (beliefs, goal) => boolean` (`ContextCondition`): a context
  condition that chooses among several plans serving the same goal. The first
  applicable plan in registration order runs. It never delays: a goal no plan
  is applicable to fails with `no applicable plan for "<goal>"`. Admission
  still decides by name alone.
- Alternative-plan fallback. When a plan fails, the next applicable plan not
  yet tried for the goal takes it over, and the goal stays `active`. The goal
  fails, with the last plan's reason, only once no untried plan is applicable.
  Goals being removed or cancelled are not replanned.
- `goal:replanned` event (`GoalReplanned`: `{ goal, failed, reason,
  intention }`), emitted between the failed plan's `intention:failed` and the
  next plan's `intention:started`.
- `PlanLibrary.applicable(beliefs, goal, exclude?)`.
- `PlanLibrary.serving(goalName)`, and the `planName(plan)` helper.
- `Plan.onPlanFailure(intention, beliefs, failure)`: a hook run each time the
  plan fails, before the failure is acted on. `failure` is a `PlanFailure`:
  `{ reason, cause: "action" | "delegation", action?, error? }`. The hook may
  return `beliefUpdates`, `beliefRemovals`, `messages` and a replacement
  `reason` (`PlanFailureResult`). It runs per plan, before alternative plans
  are evaluated, and not for cancelled or removed work. If it throws, the
  failure goes ahead with its reason unchanged.
  (Freelansys/classic-agents#53)
- `intention:failed` carries `onPlanFailureError` when the hook threw.
- `goal:failed` event (`GoalFailed`: `{ goal, reason, attempts }`), emitted
  once when a goal reaches `failed`, whatever the path. `attempts`
  (`PlanAttempt[]`) lists every plan tried, in order, each with its plan,
  intention id, reason, cause, action and error. The requester's `failure`
  still carries only the last reason.
- `AgentConfig.onGoalFailure(goal, beliefs, { reason, attempts })`: a hook run
  once when a goal's work fails for good (its last applicable plan failed, or
  no plan was applicable), before the goal is marked `failed`. It may return
  `beliefUpdates`, `beliefRemovals`, `messages` and a replacement `reason`
  (`GoalFailureResult`). The reason reaches `goal:failed`, the requester's
  `failure` and a waiting parent; `intention:failed` keeps the plan's reason.
  It does not run for goals that were declined, rejected for room, cancelled
  or dropped. If it throws, the failure goes ahead and `goal:failed` carries
  `onGoalFailureError`.

### Changed

- **Breaking:** `Plan.goal: string` is required and names the goal the plan
  serves, which used to be the plan's `name`. `Plan.name` is now optional and
  is the plan's own identity, defaulting to the goal's name (`planName(plan)`
  reads it), so several plans for one goal can be told apart in
  `goal:failed`'s `attempts`, cancellation reports and failure reasons. To
  upgrade, rename `name` to `goal` on every plan: `{ name: "ship", body }`
  becomes `{ goal: "ship", body }`. A plan without `goal` serves no goal, and
  requests for it are refused `no-plan`.
- `intention:failed` no longer always means the goal failed: another plan may
  have taken it over. Check `intention.goal.status`, or listen to
  `goal:replanned`.
- **Breaking:** `PlanLibrary.register` throws when a plan of the same name is
  already registered, an unnamed plan counting as its goal's name. Such a
  plan used to be unreachable; give each further plan for a goal its own
  `name`.
- A `cfp` is bid on by the first plan serving the goal that names a `bid`,
  not only by the first plan serving it. It is declined `unsupported` only
  when none does.

### Fixed

- An awarded job ran whichever plan was selected first for its goal, not the
  plan whose bid won. The winning plan now runs it, if its context still
  holds; if not, or if it fails, the goal falls to its other plans as usual.
- The reply to a requester's `cancel` named the goal by its current name, so
  after a `continueWith` hand-off it carried the continued name. It now names
  the goal the requester asked for, as the terminal `inform` or `failure`
  already did.

## [1.1.0] - 2026-10-12

### Added

- `ActionResult.continueWith: { goal, data?, priority? }` hands a goal on from
  a plan's last action. The goal keeps its id, `parentGoalId`, `rootGoalId`,
  `source` and `dependsOn`, takes the new name and data, and goes back to
  `pending`. Parents and requesters wait on the continuation, and a request
  gets one terminal reply when the chain ends. Depth and intention slots stay
  constant, so a plan can loop (paging, polling, retrying) inside one request.
  Used anywhere but a plan's last action, or together with `delegations`,
  `calls` or `awards`, it fails the intention with a reason saying so.
- `goal:continued` event (`GoalContinued`: `{ goal, from, intention }`),
  emitted when a goal is handed on.
- `cycle:failed` event (`CycleFailed`: `{ agentId, error }`), emitted when a
  cycle of the `start(tickIntervalMs)` loop rejects. Without a listener, the
  error is logged to the console.
- `stop({ timeoutMs })` bounds how long `stop()` waits for the running cycle
  (`0` does not wait).
- `idle({ timeoutMs? })` waits for the loop's running cycle to finish.

### Changed

- `stop()` and `idle()` resolve `true` once no cycle is running, and `false`
  if the wait timed out. `stop()` used to resolve `void`.
- `stop()` stops scheduling cycles and unsubscribes before it waits for the
  running cycle. With no options, it still waits for that cycle however long
  it takes.
- `intention:completed` no longer always means the goal was achieved: after a
  `continueWith` hand-off the goal is `pending` again. Check
  `intention.goal.status`, or listen to `goal:continued`.

### Fixed

- A plan that delegated its own goal deadlocked silently.
  `defaultGoalSelection` never activated a pending goal sharing a name with
  an active goal, even when that active goal was its waiting ancestor. Such a
  sub-goal is now exempt, so bounded recursion runs. Unrelated goals with the
  same name are still never run at once.
- A cycle of the `start(tickIntervalMs)` loop that threw (for example,
  because an event handler threw) ended the loop for good, and its rejection
  escaped as unhandled. That could crash the process, or leave the agent not
  reasoning while it still counted as running. The loop now reports the
  failure on `cycle:failed` and schedules the next cycle.
- After a bounded `stop()` and a quick restart, a cycle from before the stop
  could run alongside the new loop or schedule more cycles of its own. The
  leftover cycle now schedules nothing, and the new loop waits for it to
  finish before its first tick.

## [1.0.0]

First 1.x release. Changes from 0.x are not itemised here; see the git history.

[Unreleased]: https://github.com/raminb-dls/classic-agents/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/raminb-dls/classic-agents/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/raminb-dls/classic-agents/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/raminb-dls/classic-agents/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/raminb-dls/classic-agents/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/raminb-dls/classic-agents/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/raminb-dls/classic-agents/compare/7614c2d...v1.1.0
[1.0.0]: https://github.com/raminb-dls/classic-agents/tree/7614c2d
