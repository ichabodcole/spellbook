---
type: item
title: "Bounty snapshot backups: by content, with a retention limit"
description:
  The pre-write backup fires only when the task count shrinks, so a same-count
  or larger replacement is never kept; and backups have no retention limit.
status: draft
lifecycle: backlog
id: 01a0e988-664f-771e-af3b-0516a873c85a
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
---

# Bounty snapshot backups: by content, with a retention limit

Found by the re-measure in
[cycle/2026-09-data-you-cant-get-back](../cycles/2026-09-data-you-cant-get-back.md),
2026-09-28, on `493f01f5` (shipped launcher, scratch `HOME`); filed, not
scheduled (decision-log row 5).

Since `bbeaad53` (2026-08-08), the first write of each daemon that **shrinks**
the task count copies the old snapshot to `<id>.pre-<ts>.bak.json`. Two gaps:

- **Count, not content.** A write that replaces the tasks at the same count or a
  larger one is never backed up. Measured: `--fresh --restore` from another
  board's snapshot (4 tasks over 3) overwrote K's three tasks with nothing kept.
  An orphan daemon's revert (3 over 3) did the same; this cycle fixes the orphan
  itself.
- **No retention.** Backups accumulate without limit.

The likely shape: back up once per daemon on its first write over a file it did
not write itself (compare against a hash of what it loaded or last wrote). Then
keep the newest N per id, and let `sessions` list them. It's a design, which is
why the cycle cut it.
