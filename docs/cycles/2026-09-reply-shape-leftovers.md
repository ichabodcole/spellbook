---
type: cycle
title: Reply-shape leftovers
description:
  Finish moving bounty, grapevine and astrolabe replies onto the outcome
  contract, and fix the replies that say the wrong thing.
tags: [cli, conformance, spell-hardening]
status: stable
lifecycle: abandoned
started: 2026-09-28
appetite:
  Stop when the listed leftovers ship with a release note or are ruled out; a
  design question that needs Cole is cut, not held.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-28 }
closed: 2026-10-26
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
  warm/cold `choices`, the nested `ok:true`, the retry comments and hint, and
  the attach refusal's `restoreDropped`. Re-scoped to these on 2026-10-17; its
  robustness findings moved to
  [item/bounty-astrolabe-daemon-robustness](../items/bounty-astrolabe-daemon-robustness.md),
  outside this cycle.
- **[item/bounty-failed-restore-and-empty-replace-succeed](../items/bounty-failed-restore-and-empty-replace-succeed.md)**
  — a corrupt or directory `--restore` and an all-invalid `init --replace` exit
  0; the team rules what they answer (moved here 2026-10-02, see
  [a restore keeps every task](_archive/2026-10-a-restore-keeps-every-task.md),
  row 3).

Out of scope, deliberately:

- Where the outcome vocabulary's canonical copy lives (still unruled).
- **Scriptorium's wire nits** (2026-10-17): the kit path replaces the shipped
  Scriptorium at the cutover. Its missing-body-file code is already `not_found`
  there, and the wire part of
  [item/scriptorium-chat-and-toast-nits](../items/_archive/scriptorium-chat-and-toast-nits.md)
  is re-checked against the kit path before the cutover instead.
- **The two gate-only fixes** (2026-10-17):
  [item/error-sites-never-regex-overreaches](../items/error-sites-never-regex-overreaches.md)
  and
  [item/acc-ward-cannot-see-a-stale-surfaces-batch](../items/acc-ward-cannot-see-a-stale-surfaces-batch.md)
  change no reply, so they need no release note and go to any cycle.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                                          | Options not taken                                                                          |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | 2026-10-02 | Cole: this is the second of two cycles after 5.1.0, after [a restore keeps every task](_archive/2026-10-a-restore-keeps-every-task.md). It takes the wire-shaped Scriptorium nits, so every caller-visible code change ships in one release note. | Fold it into the bounty cycle (one cycle); give the Scriptorium nits a cycle of their own. |
| 2   | 2026-10-17 | Cole, at the project sweep: re-scope rather than abandon. Keep the reply changes only; split the robustness findings into their own item; take out the Scriptorium nits (the kit path replaces them) and the gate-only candidates.                | Abandon the cycle and return its items to the backlog; keep it as planned.                 |
| 3   | 2026-10-26 | Cole, after 6.0.0: abandon. The next cycle is bugs only, and these items change replies agents read, so they are wire work, not bugs. Its items return to the backlog with no cycle.                                                              | Fold them into the bugs-after-6 cycle; keep this cycle planned for later.                  |

## Outcome

Abandoned on 2026-10-26 without starting. Nothing in it shipped. Its two items,
`outcome-nouns-left-to-migrate` and `spell-refusal-envelope-nits`, go back to
the backlog with no cycle; `bounty-failed-restore-and-empty-replace-succeed` had
already left it. It sat `planned` for a month because the kit cutover and the
6.0.0 release took every cycle after it was written. The lesson for the next
one: a cycle planned more than one cycle ahead goes stale before it starts, so
plan only the next one.

## Sessions
