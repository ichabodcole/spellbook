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
  overshoot.
- Candidates, check at convene:
  [item/error-sites-never-regex-overreaches](../items/error-sites-never-regex-overreaches.md),
  [item/acc-ward-cannot-see-a-stale-surfaces-batch](../items/acc-ward-cannot-see-a-stale-surfaces-batch.md).

Out of scope, deliberately:
[item/bounty-failed-restore-and-empty-replace-succeed](../items/bounty-failed-restore-and-empty-replace-succeed.md)
until Cole rules on it; where the outcome vocabulary's canonical copy lives
(still unruled).

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date | Decision | Options not taken |
| --- | ---- | -------- | ----------------- |

## Outcome

_Written at close._

## Sessions
