---
type: cycle
title: A restore keeps every task
description:
  "Close bounty's last open data-loss route: a restore that silently drops tasks
  it cannot validate, plus the snapshot edges filed beside it."
tags: [bounty, spell-hardening]
status: draft
lifecycle: planned
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
  code and come along if they stay small.
- Candidate, check at convene:
  [item/bounty-failed-restore-and-empty-replace-succeed](../items/bounty-failed-restore-and-empty-replace-succeed.md)
  — it is a design question, so it joins only once Cole has ruled on it.

Out of scope, deliberately:
[item/bounty-snapshot-rotation-by-content-and-retention](../items/bounty-snapshot-rotation-by-content-and-retention.md)
and [item/bounty-snapshot-small-gaps](../items/bounty-snapshot-small-gaps.md)
(backlog; nothing is lost without them), and any wire or exit-code cleanup that
belongs to the reply-shape cycle.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                      | Options not taken                                                                                                        |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | 2026-10-02 | Cole: two cycles after 5.1.0. This one first, on its own, because it is the only data-loss route and a design question; then the reply-shape leftovers. The Scriptorium UI nits wait for use. | One cycle with everything (mixes a design question into a batch of small fixes); a third cycle for the Scriptorium nits. |

## Outcome

_Written at close._

## Sessions
