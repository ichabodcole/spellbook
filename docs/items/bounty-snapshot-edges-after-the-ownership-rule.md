---
type: item
title: "Bounty snapshot: what the ownership rule leaves open"
description:
  A restore that silently drops tasks this build can't validate still counts as
  reading the file; a --fresh --restore crash on a read-only snapshots folder;
  and a keyed respawn that can't see its snapshot comes up empty without a word.
status: draft
lifecycle: triage
id: 01a0ea35-9eca-73dc-8e2e-c625cd2d4213
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
---

# Bounty snapshot: what the ownership rule leaves open

Found by the final no-stake verifier of
[cycle/2026-09-data-you-cant-get-back](../cycles/2026-09-data-you-cant-get-back.md)
on `ab440a21` (scripts in that session's `scratchpad/v12/`, not kept). Every
permission-flip-then-heal route kept every task; these are what's left. Cut at
close by the appetite, not fixed.

1. **A restore that drops tasks still counts as reading the file (loses a
   task).** A snapshot holding a task this build's `validateTask` rejects (e.g.
   a status or `notes` shape from another bounty version, or another tool)
   restores without that task. `readOwn` (`src/bounty/backend/server.ts` ~1349)
   still marks the daemon owner, even though `boardHoldsSnapshot` would say
   false. Add one card so the count doesn't shrink, close, and the dropped task
   is in no file. `open` said `restoreFailed: null, snapshotBackups: []`.
   **Fix:** ownership from a restore requires that the board holds the file (or
   copy it aside first), and name the dropped entries on `open`.
2. **A crash instead of an envelope.**
   `open --session-key P --fresh --restore <own id>`, with a live daemon and a
   read-only `snapshots/`, throws EACCES from `copyAsideBeforeTeardown`
   (`src/bounty/backend/cli.ts` ~964) and exits 1 with a stack. The board
   survives. This is new code from the cycle.
3. **A silent empty board.** A keyed respawn with `snapshots/` at mode 000 comes
   up empty with `restoreFailed: null`, because the CLI's `existsSync` can't see
   the file and so never passes `--restore`. The tasks are safe (the rule keeps
   them), but nothing says so. `unownedWhy` also says "(open --fresh)" when
   there was no `--fresh`.
4. **A racing `open --fresh --restore Q`** can attach to another open's board,
   exit 0, and never restore Q; the only notice is a `#` stderr line.

**Accepted, not bugs:** `init --stdin-tasks --replace` with a seed of the same
size or larger keeps no copy (an explicit replace; see
[rotation by content](bounty-snapshot-rotation-by-content-and-retention.md) for
a by-content backup that would cover it). Another tool writing over a live
board's `<id>.json` is outside bounty's control.
