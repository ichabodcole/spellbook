---
type: cycle
title: A restore keeps every task
description:
  "Close bounty's last open data-loss route: a restore that silently drops tasks
  it cannot validate, plus the snapshot edges filed beside it."
tags: [bounty, spell-hardening]
status: draft
lifecycle: active
started: 2026-10-02
appetite:
  Stop when no restore can lose a task without saying so, and a no-stake
  verifier has driven it on a scratch HOME; a fix that needs a ruling from Cole
  is cut, not held.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-02 }
---

# A restore keeps every task

## Why now

It is the one open route where bounty loses data. It has waited since "Data you
can't get back" (2026-09-28), and twice since then other work came first
([round two](2026-09-scriptorium-from-real-use-2.md), row 1). Cole chose it as
the first of two cycles after 5.1.0 (2026-10-02); the
[reply-shape leftovers](2026-09-reply-shape-leftovers.md) follow.

## Scope

- **[item/bounty-snapshot-edges-after-the-ownership-rule](../items/bounty-snapshot-edges-after-the-ownership-rule.md)**
  — the headline is its point 1: a snapshot holding a task this build's
  `validateTask` rejects (from another bounty version or another tool) restores
  without it, and still makes the daemon its owner, so the task is in no file
  after the next write. Done means a restore either keeps the file as it was (or
  copies it aside) or does not take ownership, and `open` names what it dropped.
  Points 2–4 (an EACCES stack under `--fresh --restore`, a silent empty board
  when `snapshots/` is unreadable, a racing `--fresh --restore`) sit in the same
  code and come along if they stay small. Out of scope, deliberately:
  [item/bounty-snapshot-rotation-by-content-and-retention](../items/bounty-snapshot-rotation-by-content-and-retention.md)
  and [item/bounty-snapshot-small-gaps](../items/bounty-snapshot-small-gaps.md)
  (backlog; nothing is lost without them), and any wire or exit-code cleanup
  that belongs to the reply-shape cycle, including
  [item/bounty-failed-restore-and-empty-replace-succeed](../items/bounty-failed-restore-and-empty-replace-succeed.md)
  (row 3).

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Options not taken                                                                                                                                                                                                                                                    |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-10-02 | Cole: two cycles after 5.1.0. This one first, on its own, because it is the only data-loss route and a design question; then the reply-shape leftovers. The Scriptorium UI nits wait for use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | One cycle with everything (mixes a design question into a batch of small fixes); a third cycle for the Scriptorium nits.                                                                                                                                             |
| 2   | 2026-10-02 | Convened. The cause is at `server.ts` ~1349: a restore from the board's own snapshot sets `readOwn` even when `validateTask` dropped or changed entries, so the board owns a file it does not hold and its next write erases them. Wire ruling (the team's): own the snapshot only when the board holds it (`boardHoldsSnapshot`, the test the other boot routes already use); otherwise keep the file aside before the first write, and `open` names each dropped entry. One implementer (all four points are in bounty's restore and ownership code), then one no-stake verifier on a scratch HOME.                                                                                                                                                                                                                                                                              | Refuse the restore (loses the entries that did validate, and blocks a board on a field it cannot read); keep the file aside on every restore (a copy per keyed respawn, most of them identical); one implementer per point (four agents in one region of two files). |
| 3   | 2026-10-02 | The candidate, a failed restore and an empty replace both exiting 0, moves to the reply-shape cycle. It was filed as waiting on Cole, but it is a wire question (an agent can tell the cases apart; nothing Cole sees or feels changes), so the team rules it, and it is exit-code shaped like the rest of that cycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Hold it here for a ruling from Cole (the escalation contract says it is not his); fix it here (splits the caller-visible code changes across two release notes).                                                                                                     |
| 4   | 2026-10-02 | Integrated (`489d9341`, `4c5aa186`, `f1065949`, dist `72ce6f58`); gate 3195/0. Accepted the implementer's calls: the field is `restoreDropped: [{index, id, reason}]`, present-and-`[]` on every boot and on `open`, `/state` and every `init` frame; the copy is a new backup kind, `partial-restore`; the reason comes from the existing `taskRejection`, so `validateTask` is untouched. `boardHoldsSnapshot` now compares data, not bytes (sorted keys, an empty array the same as absent), because exact JSON made every clean respawn of an ordinary board copy its file. Point 2 refuses as `conflict` (6) before teardown; point 3 attempts the restore when `snapshots/` cannot be listed, so EACCES lands in `restoreFailed`; point 4 reuses the #80.1 attach refusal (exit 2, `restoreSkipped`). Not done: the browser does not show `restoreDropped` (a surface call). | `tasksDropped`'s shape for the field (that is an input report on `init`, not a boot fact); byte comparison (a copy per respawn); a new exit code for point 4 (#80.1 already rules that situation).                                                                   |
| 5   | 2026-10-02 | No-stake verifier on the shipped launcher: all six claims **held** (it reproduced the race), and no task was lost in any scenario. Fixed in a second round, because each is a restore that loses data or says less than it did: an unknown field set to `[]` is erased with no copy (the loosened comparison let it through); duplicate ids copy the file on every respawn; a failed `partial-restore` copy is not mentioned on `open`; the copy's reason does not name changed tasks; a typo. Filed to [spell-refusal-envelope-nits](../items/spell-refusal-envelope-nits.md) for the reply-shape cycle: `init` dropping duplicates and fields under `tasksDropped: null`, the stale `restoreDropped` on an attach refusal, `--fresh` without a key, the snapshot title overriding `--title`. Point 4 also resolved that item's 5.0.0 lock-loser nit.                             | Fix the `init` drops here (an input report, not a restore: reply-shape's class); close with the five as known gaps (two are silent loss on restore, this cycle's own claim).                                                                                         |

## Outcome

_Written at close._

## Sessions
