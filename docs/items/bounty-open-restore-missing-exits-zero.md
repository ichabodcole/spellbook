---
type: item
title: "`bounty open --restore <missing>` exits 0 and opens a fresh board"
description:
  open --restore on a snapshot that does not exist sets restoreFailed but exits
  0 and spawns an unrelated fresh board.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: triage # triage | backlog | ready | active | review | done | dropped
id: 01a0e1bd-405f-7763-b303-bb4a58848512
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
---

# `bounty open --restore <missing>` exits 0 and opens a fresh board

Found by
[the sprint 06 re-measure](../features/spell-hardening/sprints/06-filed-is-not-fixed/remeasure.md)
on `b0e9d852`, and deliberately not chased in that cycle.

```
$ bounty open --restore k-nope-123 --no-open
{"ok":true,…,"restoreFailed":"ENOENT…"}   exit 0; a new, empty board is running
```

The envelope says the restore failed; the exit code says it succeeded.
`bounty tail` currently prints this command as its come-back line (see `#98`).
