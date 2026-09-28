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

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Options not taken                                                                                                                                                                                                                                                                                                              |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 2026-09-28 | Convened on Cole's go-ahead. Astrolabe starts at once (measured yesterday, on current code); the two bounty items get a re-measure first, in parallel, because August's fixes may have closed parts of them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Re-measure all three (astrolabe's was measured on `a7c041d3` a day ago); skip the re-measure (last cycle's two filed repros were already partly wrong).                                                                                                                                                                        |
| 2   | 2026-09-28 | Astrolabe principle (the wire is the team's): an unreadable registry's bytes are never lost (moved aside, never overwritten); no caller is told "unknown project" without also being told the registry could not be read and where its bytes went; that notice names the act that recovers it. The implementer picks the mechanism. _(Rows 1–2 were written at convene but lost to a failed insert; restored after the implementer worked from the brief's copy.)_                                                                                                                                                                                                                                                                                                                                                   | Refuse to start the daemon until a human fixes the file (blocks all use to protect a file a move-aside protects as well); keep booting empty and only log (today's silence, one step removed).                                                                                                                                 |
| 3   | 2026-09-28 | Bounty re-measure (no-stake, shipped launcher, scratch HOME): neither item happens in its August form. Keyed respawn restores (`fb209f1a`), SIGTERM saves (`2cc513d4`), a dying daemon is heard (`tail.lost`), and a shrinking write is backed up (`bbeaad53`). What still loses data with no backup: **(a)** concurrent keyed opens start two daemons for one id, and the orphan later reverts newer work; **(b)** `--fresh --restore <own id>` on a live board restores the teardown's own write; **(c)** an unreadable or malformed snapshot is overwritten; and **(d)** the backup that is made is never reported to the caller.                                                                                                                                                                                 | Fix the items as written (their main claims are already fixed); close the items and stop (a)–(c) are new paths to the same loss, found by the re-measure).                                                                                                                                                                     |
| 4   | 2026-09-28 | In scope: (a) one daemon per id (a boot-time lock; a second `open` attaches); (b) copy the snapshot aside **before** the `--fresh` teardown and restore from the copy, which is what the caller asked for; (c) copy an unreadable snapshot aside before the first write, and report a non-array `tasks` as `restoreFailed` rather than `[]`; (d) name any backup on the `close` and `open` envelopes. The same principle as astrolabe (row 2).                                                                                                                                                                                                                                                                                                                                                                       | Refuse `--fresh --restore` on a live board (a keyed open over a dead board already restores, but a caller asking to reset to the snapshot has a real intent); a hash-based "first overwrite of a foreign file" backup (covers the rest, but adds one `.bak` per boot with no retention: cut, with retention, to its own item). |
| 5   | 2026-09-28 | Filed, not scheduled: content-aware rotation with a retention limit; flushing the first mutation after boot (SIGKILL within ~1 s loses a board's first edits); `open` not saying it restored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Fold them in (retention is a design; the other two are small and not data loss by an ordinary act).                                                                                                                                                                                                                            |
| 6   | 2026-09-28 | Astrolabe shipped: the cold CLI refuses by itself (`conflict`, exit 6: the disk cannot say whether the project is registered), starting and moving nothing; `open`'s daemon boot is the one act that renames the file to `registry.json.unreadable-<time>` (exit 1 rather than boot if the rename fails). Callers learn of it while the file exists (re-read from disk each call): a `# warning:` on successes, the refusal envelope on failures, `registry_set_aside` on `info`/`state`/`list`. Recovery is manual and worded in the notice; a `registry restore` verb is proposed, not built. Census 16/2 → 17/2. **Open:** the warm path recognises the daemon's refusal by matching its message text, which the house rule forbids (route on kind, not prose); to be fixed with a structured field before close. | Start the daemon from the cold path (moves the file as a side effect of a refused call); a one-shot notice (a flag that goes stale); build the restore verb now (wait for real use).                                                                                                                                           |

## Outcome

_Written at close._

## Sessions
