---
type: item
title: A respawn after a failed save does not name the unsaved dump
description:
  After a close that could not save (exit 6, an unsaved dump), the next keyed
  open comes up from the older snapshot without pointing at the dump that holds
  the newer tasks.
status: draft
lifecycle: triage
id: 01a0fdcd-fe1d-7058-bb1f-53a0174ddcfa
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-02 }
from: cycle/2026-10-a-restore-keeps-every-task
---

# A respawn after a failed save does not name the unsaved dump

Found by the second no-stake verifier of
[cycle/2026-10-a-restore-keeps-every-task](../cycles/2026-10-a-restore-keeps-every-task.md),
2026-10-02, on the shipped launcher under a scratch `HOME`. No task is lost:
every one was in a named file. It predates that cycle; the cycle made it easier
to reach (a failed `partial-restore` copy refuses writes the same way).

**Repro.** Put a task this build rejects in a keyed board's snapshot and
`chmod 555 snapshots`. `open --session-key K` (exit 0, `snapshotBackupFailed`
set), `add X`, `close` (exit 6, an `unsaved` dump in `$BOUNTY_HOME` that holds
X, named in the refusal's hint). `chmod 755`, `open --session-key K`: the board
comes up from the old snapshot, without X, and nothing on that `open` points at
the dump. Two read-only sessions in a row each start from the old snapshot, so
their tasks end up split across two dumps. `sessions` does not list
`$BOUNTY_HOME/*.unsaved-*.json` either.

**The question.** The dump is named once, on the failed `close`. A caller who
follows `snapshotBackupFailed.fix` and respawns sees tasks missing. Options:
`open` names any `unsaved` dump for this id newer than the snapshot (in
`snapshotBackups`, with its restore command); or the respawn restores from the
newest of the snapshot and its dumps. The second changes what a keyed respawn
restores, so it is a wire ruling with more reach.

**Also (cosmetic):** when a duplicate id's first entry is invalid and a later
one is kept, the `partial-restore` reason also says `changed: <id> (…)`, because
it compares the file's first entry with the kept one.
