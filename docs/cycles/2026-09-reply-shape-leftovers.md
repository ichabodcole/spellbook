---
type: cycle
title: Reply-shape leftovers
description:
  Finish moving spell replies onto the outcome contract and clean up the
  refusal-envelope inconsistencies filed in September.
tags: [cli, conformance, spell-hardening]
status: draft
lifecycle: planned
started: 2026-09-28
appetite:
  Stop when the listed leftovers ship with a release note or are ruled out; a
  design question that needs Cole is cut, not held.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-28 }
---

# Reply-shape leftovers

## Why now

Agent-facing wire work filed across September: the outcome-contract migrations
left after #82 was closed, and the envelope inconsistencies both verifiers of
the last cycle found. Each changes a reply an agent reads, so it ships with a
release note.

## Scope

- **[item/outcome-nouns-left-to-migrate](../items/outcome-nouns-left-to-migrate.md)**
  — bounty `update`'s `noop`, grapevine's `already_running`, the
  `restarted`/`rolled` echoes, `reap`'s parallel arrays.
- **[item/spell-refusal-envelope-nits](../items/spell-refusal-envelope-nits.md)**
  — first the dash-leading key's come-back command that does not run, then the
  warm/cold `choices`, the nested `ok:true`, the retry comments, and the grace
  overshoot. Since round three it also holds Scriptorium's `say`/`task`/`note`
  missing-body-file code (2 → 5, to match `version-new`).
- **The wire-shaped part of
  [item/scriptorium-chat-and-toast-nits](../items/scriptorium-chat-and-toast-nits.md)**
  — a bare `tail` that retries forever after a human end, the crash-path
  `internal` with no restore hint, and `--doc` refusals without `choices`. Its
  UI nits stay there until Cole's use raises them (ruled 2026-10-02).
- Candidates, check at convene:
  [item/error-sites-never-regex-overreaches](../items/error-sites-never-regex-overreaches.md),
  [item/acc-ward-cannot-see-a-stale-surfaces-batch](../items/acc-ward-cannot-see-a-stale-surfaces-batch.md).

- **[item/bounty-failed-restore-and-empty-replace-succeed](../items/bounty-failed-restore-and-empty-replace-succeed.md)**
  — a corrupt or directory `--restore` and an all-invalid `init --replace` exit
  0; the team rules what they answer (moved here 2026-10-02, see
  [a restore keeps every task](2026-10-a-restore-keeps-every-task.md), row 3).

Out of scope, deliberately: where the outcome vocabulary's canonical copy lives
(still unruled).

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                                 | Options not taken                                                                          |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | 2026-10-02 | Cole: this is the second of two cycles after 5.1.0, after [a restore keeps every task](2026-10-a-restore-keeps-every-task.md). It takes the wire-shaped Scriptorium nits, so every caller-visible code change ships in one release note. | Fold it into the bounty cycle (one cycle); give the Scriptorium nits a cycle of their own. |

## Outcome

_Written at close._

## Sessions
