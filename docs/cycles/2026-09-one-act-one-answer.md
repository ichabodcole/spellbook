---
type: cycle
title: One act, one answer
description:
  "Fix the five same-class CLI bugs sprint 06 filed and did not chase: each is a
  command whose exit code, envelope or side effects disagree with what it did."
tags: [spell-hardening, cli]
status: draft
lifecycle: closed
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

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Options not taken                                                                                                                                                 |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-09-28 | Stale-port item closed at convene as covered by `s5-8` (its test exists).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Re-work it; also delete the stale port file on `close` (no caller needs it: `open` already respawns over it).                                                     |
| 2   | 2026-09-28 | Wire rulings are the team's (Cole rules cost/UX, the team rules the wire). `init` over a non-empty board: **refuse** with `conflict`, opt in with an explicit flag, report the number dropped.                                                                                                                                                                                                                                                                                                                                                                             | Warn and proceed (a warning with no act; data already gone); refuse with no opt-in (re-seeding a board is a real use).                                            |
| 3   | 2026-09-28 | `tail --session-key` on a key whose board has a close snapshot stops as `tail.closed`, exit 0, like `--session`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Leave the two answers (both hints true, but one board, two outcomes); make `--session` wait out the grace too (slower, and less true).                            |
| 4   | 2026-09-28 | No separate re-measure pass: the bugs were measured yesterday on the current parsers; each implementer writes the failing test first, which is the re-measure.                                                                                                                                                                                                                                                                                                                                                                                                             | Sprint 06's standalone re-measure (worth it then: the parsers had been rewritten since August).                                                                   |
| 5   | 2026-09-28 | Two implementers in parallel, split by file: one on bounty (four items, one `cli.ts`), one on astrolabe; then one no-stake verifier on the shipped launchers.                                                                                                                                                                                                                                                                                                                                                                                                              | One per item (four agents contending for one file).                                                                                                               |
| 6   | 2026-09-28 | Astrolabe: the registry is on disk, so a refused call with no daemon refuses from the disk registry (`usage`, exit 2, same as warm, ids in `choices`); a live daemon still decides when up. `status`, `attention`, `poke`, `remove`, `join` and duplicate `add` fixed; census 14/1 → 16/2. The enumerator bug it hit is filed as [item/error-sites-never-regex-overreaches](../items/error-sites-never-regex-overreaches.md), not fixed here.                                                                                                                              | `not_found` for "no daemon" (the question is whether the project is registered, which the disk answers); fix only `status` (five verbs had the same shape).       |
| 7   | 2026-09-28 | Bounty implementer's call, accepted: the replace count is a new field, `tasksReplaced: <n>` (only with `--replace`), because `tasksDropped` already means the caller's _input_ entries the daemon rejected (b8), never the board's tasks; the item had misread its `null`.                                                                                                                                                                                                                                                                                                 | Overload `tasksDropped` with a number (one key, two types; breaks parsers of `.dropped`; loses the input report on a replace), as row 2 first said.               |
| 8   | 2026-09-28 | Accepted: the init conflict is decided in the daemon (only it sees board and write together); `init --replace` without `--stdin-tasks` is a usage error; the restore existence check runs after the keyed attach and before the `--fresh` teardown, so a missing snapshot cannot close a live board.                                                                                                                                                                                                                                                                       | A CLI-side pre-read of the board (racy); ignoring a stray `--replace` (a flag that silently does nothing).                                                        |
| 9   | 2026-09-28 | Bounty's `acc.recorded-surfaces.json` is stale on one record (`init`'s choices lack `--replace`). Re-record the whole batch with `acc probe-plan` after verification, not hand-edit the one line: the batch stamps the build it was recorded on.                                                                                                                                                                                                                                                                                                                           | Hand-edit the line (the stamp would then lie); leave it (the ward only checks the batch was read, so it would stay stale silently).                               |
| 10  | 2026-09-28 | No-stake verifier: all five claims **held** on the shipped launchers. Of its 11 surprises, three are fixed in this cycle: `message x --stdin` (the `add` class on a sibling verb), `open --restore ""` (the missing-restore class through an empty id), and the tail not_found hint made false by this cycle's own dead-code removal.                                                                                                                                                                                                                                      | Fix all 11 (several are design questions: the appetite says cut, not stretch); fix none (two are the exact classes this cycle exists for, one is our regression). |
| 11  | 2026-09-28 | The rest are filed to triage: [astrolabe-corrupt-registry-silently-lost](../items/astrolabe-corrupt-registry-silently-lost.md) (data loss, predates the cycle), [bounty-failed-restore-and-empty-replace-succeed](../items/bounty-failed-restore-and-empty-replace-succeed.md) (a design question), [bounty-list-shows-stale-title](../items/bounty-list-shows-stale-title.md), and [spell-refusal-envelope-nits](../items/spell-refusal-envelope-nits.md) (warm/cold `choices`, nested `ok:true`, grace overshoot, B1 on a closed board).                                 | One item per surprise (four nits that no one acts on separately).                                                                                                 |
| 12  | 2026-09-28 | Second no-stake verifier: the three follow-ups **held**. Its four surprises (a come-back command that does not run for a dash-leading key, "no session yet" retry comments, key-slug collisions, "repo root" wording) are appended to [spell-refusal-envelope-nits](../items/spell-refusal-envelope-nits.md). Bounty's surfaces batch re-recorded (`515d0fbc`); it had been stale since the previous cycle, which the acc ward could not see: filed as [acc-ward-cannot-see-a-stale-surfaces-batch](../items/acc-ward-cannot-see-a-stale-surfaces-batch.md). Cycle closed. | A third fix round (the appetite: the five landed and were driven; the rest are filed with their fixes named).                                                     |

## Outcome

Closed 2026-09-28. All five bugs shipped, plus three that the no-stake verifier
found in the same classes. Two no-stake verifiers drove every claim on the
committed launchers under a scratch `HOME`, and every claim held. The gate was
green at each integration (3004, then 3007 in the implementer's run).

**Shipped.**

- **bounty `init --stdin-tasks`** over a board that has tasks is a `conflict`
  (exit 6) and the board is unchanged. `--replace` opts in and reports
  `tasksReplaced: <n>`. `tasksDropped` keeps its old meaning: the caller's input
  entries that were rejected.
- **bounty `open --restore`** of a missing snapshot is `not_found` (5), and of
  `""` is `usage` (2). Neither starts a board, and neither can tear down a live
  one under `--fresh`.
- **bounty `add <title> --stdin` and `message <text> --stdin`** are `usage` (2).
  No other verb has that shape.
- **bounty `tail --session-key`** on a closed board stops at once as
  `tail.closed` (exit 0), like `--session`. Its not_found hint claims only what
  the CLI knows.
- **astrolabe:** a refused `status`, `attention`, `poke`, `remove`, `join` or
  duplicate `add` starts no daemon. It refuses from the on-disk registry, with
  the registered ids in `choices`.
- The stale-port `close` item was already fixed by `s5-8`, and was closed at
  convene.

**For the next release note:** these change a code a caller can see:

| Command                                | Exit before | Exit after |
| -------------------------------------- | ----------- | ---------- |
| `open --restore <missing>`             | 0           | 5          |
| `open --restore ""`                    | 0           | 2          |
| `add x --stdin`                        | 0           | 2          |
| `message x --stdin`                    | 0           | 2          |
| `init --stdin-tasks` over tasks        | 0           | 6          |
| `tail --session-key` on a closed board | 5           | 0          |

The astrolabe refusals keep exit 2, but no longer start a daemon. There is one
new flag, `init --replace`.

**Falsified or corrected.**

- Item 1's filed repro (`printf ''`) was already refused. The real trigger is
  any JSON array, `[]` included.
- The item read `tasksDropped: null` as "nothing dropped". It never described
  the board's tasks, so row 2's plan to put the count there was wrong (row 7).
- This cycle introduced one regression: removing the "existed and has closed"
  branch made a hint false. The verifier caught it, and it was fixed the same
  day.
- The astrolabe registry turned out to be readable from disk, so there was no
  need to choose between "no daemon" and "unknown project".

**Carried over** (filed to triage, none scheduled):

- [astrolabe-corrupt-registry-silently-lost](../items/astrolabe-corrupt-registry-silently-lost.md):
  data loss, and the most urgent.
- [bounty-failed-restore-and-empty-replace-succeed](../items/bounty-failed-restore-and-empty-replace-succeed.md):
  a design question.
- [bounty-list-shows-stale-title](../items/bounty-list-shows-stale-title.md).
- [spell-refusal-envelope-nits](../items/spell-refusal-envelope-nits.md), whose
  dash-key come-back is the one worth doing.
- [error-sites-never-regex-overreaches](../items/error-sites-never-regex-overreaches.md).
- [acc-ward-cannot-see-a-stale-surfaces-batch](../items/acc-ward-cannot-see-a-stale-surfaces-batch.md).

**Learned.** A no-stake verifier again found more than the implementers did:
eleven surprises, then four, and one of them a regression of our own. Asking it
to try "one shape the author did not think of" per claim is what surfaced the
siblings (`message`, `--restore ""`).

## Sessions
