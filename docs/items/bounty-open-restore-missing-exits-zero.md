---
type: item
title: "`bounty open --restore <missing>` exits 0 and opens a fresh board"
description:
  open --restore on a snapshot that does not exist sets restoreFailed but exits
  0 and spawns an unrelated fresh board.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: done
id: 01a0e1bd-405f-7763-b303-bb4a58848512
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
cycle: 2026-09-one-act-one-answer
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

## Fixed (2026-09-28)

Re-measured red first: `open --restore k-nope-123 --no-open` exited 0 with
`restoreFailed: ENOENT…`, and `list` then showed a second, empty board running.

What changed: before it spawns anything, `open` checks the places the daemon
would look for the restore. That is the argument as a path, resolved against the
daemon's cwd, and then `<arg>.json` in the snapshots directory. When neither
exists, `open` exits 5 (`not_found`) with stdout empty and one envelope on
stderr. The envelope's `hint` names `sessions`. No board or daemon is started.

- The check runs after the keyed attach and before `--fresh`'s teardown. A
  `--restore` against a live keyed board still gets #80.1's attach refusal (exit
  2, `restoreSkipped`). `--fresh --restore <missing>` refuses before it closes
  the live board, so the live board survives.
- A snapshot that exists but cannot be read still reaches the daemon and still
  reports `restoreFailed`, because that restore was attempted.

The come-back line that `bounty tail` prints (#98) is still true. It prints
`open --restore <id> --no-open` only for a board whose snapshot is on disk, and
that snapshot still restores at exit 0. One edge is not fully true. An unnamed
re-arm (`--since` with no `--session`) that finds no board can print the
come-back with no snapshot behind it, or with the literal `<id>`. That edge came
before this fix. It used to start a stray empty board, and now it fails loudly
with `not_found`.

Pinned by `server.test.ts`, in "one act, one answer — open --restore of a
snapshot that does not exist". The cell "open --restore <missing> is not_found
(5) and starts no board" pins the fix. "--fresh --restore <missing> on a live
keyed board refuses BEFORE the teardown" pins the ordering. "GUARD — open
--restore <id> of a closed board's snapshot still restores it" pins the
come-back.

An empty id slipped past this: `open --restore ""` exited 0 and started a fresh
empty board with `restoreFailed: null`, because the empty id read as "no
restore" (and `""` resolves to the cwd, which exists). `open`'s `check` hook
(`checkOpen`) now refuses it as usage, exit 2, before anything is attached or
spawned. Pinned by 'open --restore "" is a usage error (2) and starts no board',
in the same `describe`.
