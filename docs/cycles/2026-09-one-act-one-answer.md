---
type: cycle
title: One act, one answer
description:
  "Fix the five same-class CLI bugs sprint 06 filed and did not chase: each is a
  command whose exit code, envelope or side effects disagree with what it did."
tags: [spell-hardening, cli]
status: draft
lifecycle: active
started: 2026-09-28
appetite:
  Stop when the five land and a no-stake verifier has driven each on a scratch
  HOME; a fix that turns into a design question is cut to its own item, not
  stretched.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-28 }
---

# One act, one answer

## Why now

Cole, closing sprint 06 (2026-09-27): "handle the new issues in a new cycle".
Sprint 06's re-measure and its no-stake verifier found six bugs of the class it
had just fixed, and filed them rather than stretch the cycle. One destroys data
at `ok:true`. Each is a command whose exit code, envelope or side effects
disagree with what it actually did, which is the house rule the last two cycles
wrote down.

## Scope

- **[item/bounty-init-stdin-tasks-wipes-live-board](../items/bounty-init-stdin-tasks-wipes-live-board.md)**
  — `init --stdin-tasks` over a board that has tasks is refused (`conflict`,
  exit 6) unless the caller opts in; replacing says how many tasks it dropped.
- **[item/bounty-open-restore-missing-exits-zero](../items/bounty-open-restore-missing-exits-zero.md)**
  — a restore of a snapshot that does not exist is `not_found`, exit 5, and
  starts no board.
- **[item/bounty-add-stdin-drops-positional-title](../items/bounty-add-stdin-drops-positional-title.md)**
  — `add <title> --stdin` is a usage error, as `update --stdin --title` became
  in sprint 06.
- **[item/bounty-tail-closed-board-two-answers](../items/bounty-tail-closed-board-two-answers.md)**
  — a closed board answers `tail` the same way however it is named.
- **[item/astrolabe-refused-status-still-spawns-daemon](../items/astrolabe-refused-status-still-spawns-daemon.md)**
  — a refused `status` starts nothing.

Out of scope, deliberately:
[item/astrolabe-close-stale-port-internal-error](../items/astrolabe-close-stale-port-internal-error.md)
is already fixed by sprint 06's `s5-8` change (pinned by a test), and is closed
at convene rather than worked. The 8 house-style rules left
`none — checkable, unchecked` are ward work, not bugs.
[outcome-contract-rule-ids](../items/outcome-contract-rule-ids.md) stays in
backlog.

**Release note:** three of these change an exit code a caller can see
(`open --restore` 0→5, `add` 0→2, `init` 0→6). They go in the next release's
breaking-changes note.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                      | Options not taken                                                                                                                                           |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-09-28 | Stale-port item closed at convene as covered by `s5-8` (its test exists).                                                                                                                                                                                                                                                                                                                                                                     | Re-work it; also delete the stale port file on `close` (no caller needs it: `open` already respawns over it).                                               |
| 2   | 2026-09-28 | Wire rulings are the team's (Cole rules cost/UX, the team rules the wire). `init` over a non-empty board: **refuse** with `conflict`, opt in with an explicit flag, report the number dropped.                                                                                                                                                                                                                                                | Warn and proceed (a warning with no act; data already gone); refuse with no opt-in (re-seeding a board is a real use).                                      |
| 3   | 2026-09-28 | `tail --session-key` on a key whose board has a close snapshot stops as `tail.closed`, exit 0, like `--session`.                                                                                                                                                                                                                                                                                                                              | Leave the two answers (both hints true, but one board, two outcomes); make `--session` wait out the grace too (slower, and less true).                      |
| 4   | 2026-09-28 | No separate re-measure pass: the bugs were measured yesterday on the current parsers; each implementer writes the failing test first, which is the re-measure.                                                                                                                                                                                                                                                                                | Sprint 06's standalone re-measure (worth it then: the parsers had been rewritten since August).                                                             |
| 5   | 2026-09-28 | Two implementers in parallel, split by file: one on bounty (four items, one `cli.ts`), one on astrolabe; then one no-stake verifier on the shipped launchers.                                                                                                                                                                                                                                                                                 | One per item (four agents contending for one file).                                                                                                         |
| 6   | 2026-09-28 | Astrolabe: the registry is on disk, so a refused call with no daemon refuses from the disk registry (`usage`, exit 2, same as warm, ids in `choices`); a live daemon still decides when up. `status`, `attention`, `poke`, `remove`, `join` and duplicate `add` fixed; census 14/1 → 16/2. The enumerator bug it hit is filed as [item/error-sites-never-regex-overreaches](../items/error-sites-never-regex-overreaches.md), not fixed here. | `not_found` for "no daemon" (the question is whether the project is registered, which the disk answers); fix only `status` (five verbs had the same shape). |
| 7   | 2026-09-28 | Bounty implementer's call, accepted: the replace count is a new field, `tasksReplaced: <n>` (only with `--replace`), because `tasksDropped` already means the caller's _input_ entries the daemon rejected (b8), never the board's tasks; the item had misread its `null`.                                                                                                                                                                    | Overload `tasksDropped` with a number (one key, two types; breaks parsers of `.dropped`; loses the input report on a replace), as row 2 first said.         |
| 8   | 2026-09-28 | Accepted: the init conflict is decided in the daemon (only it sees board and write together); `init --replace` without `--stdin-tasks` is a usage error; the restore existence check runs after the keyed attach and before the `--fresh` teardown, so a missing snapshot cannot close a live board.                                                                                                                                          | A CLI-side pre-read of the board (racy); ignoring a stray `--replace` (a flag that silently does nothing).                                                  |
| 9   | 2026-09-28 | Bounty's `acc.recorded-surfaces.json` is stale on one record (`init`'s choices lack `--replace`). Re-record the whole batch with `acc probe-plan` after verification, not hand-edit the one line: the batch stamps the build it was recorded on.                                                                                                                                                                                              | Hand-edit the line (the stamp would then lie); leave it (the ward only checks the batch was read, so it would stay stale silently).                         |

## Outcome

_Written at close._

## Sessions
