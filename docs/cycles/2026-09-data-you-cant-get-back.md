---
type: cycle
title: Data you can't get back
description:
  "Fix the spell paths where an ordinary act destroys state no command can
  restore: astrolabe's corrupt registry and bounty's snapshot clobbers."
tags: [spell-hardening, data-loss]
status: draft
lifecycle: active
started: 2026-09-28
appetite:
  Stop when every data-loss path below is re-measured and either fixed, pinned
  by a test, and driven by a no-stake verifier, or shown already fixed; rotation
  or backup design that grows past a day is cut to its own item.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-28 }
---

# Data you can't get back

## Why now

Cole picked this as the next cycle on 2026-09-28. Most CLI bugs cost a retry;
these cost the data. The last cycle's verifier found astrolabe dropping its
whole registry, and two older bounty items describe a recovery move that
destroys the snapshot it should recover from.

## Scope

- **[item/astrolabe-corrupt-registry-silently-lost](../items/astrolabe-corrupt-registry-silently-lost.md)**
  — a registry that can't be read is refused or reported, never treated as
  empty, and never overwritten by the next save.
- **[item/bounty-snapshot-clobber-data-loss](../items/bounty-snapshot-clobber-data-loss.md)**
  — `close` on an empty board cannot write over a snapshot that holds tasks.
  Decide on rotation here, or cut it to its own item.
- **[item/bounty-fresh-restore-destroys-snapshot](../items/bounty-fresh-restore-destroys-snapshot.md)**
  — `open --fresh --restore` restores from the snapshot and does not empty it
  first.

**Re-measure first.** Both bounty items predate the fixes since August: #97 made
restore the default on a keyed respawn (closed 2026-08-11), and the last cycle
made `--restore` check the snapshot exists before `--fresh` tears anything down.
Parts of either item may already be fixed.

Out of scope, deliberately: the design question of whether a failed restore
should exit non-zero
([item/bounty-failed-restore-and-empty-replace-succeed](../items/bounty-failed-restore-and-empty-replace-succeed.md))
is not data loss and waits for Cole; `init --replace` wiping a board on
all-invalid input is opted into.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date | Decision | Options not taken |
| --- | ---- | -------- | ----------------- |

## Outcome

_Written at close._

## Sessions
