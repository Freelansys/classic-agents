# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/raminb-dls/classic-agents/compare/7614c2d...v1.1.0
[1.0.0]: https://github.com/raminb-dls/classic-agents/tree/7614c2d
