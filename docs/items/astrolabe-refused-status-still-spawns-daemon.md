---
type: item
title: "`astrolabe status` spawns a daemon for a command it refuses"
description:
  astrolabe status with an unknown project exits 2 but has already started a
  daemon.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: ready
id: 01a0e1bd-40c9-72d2-b371-e4263f728e18
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
cycle: 2026-09-one-act-one-answer
---

# `astrolabe status` spawns a daemon for a command it refuses

Found by
[the sprint 06 re-measure](../features/spell-hardening/sprints/06-filed-is-not-fixed/remeasure.md)
on `b0e9d852`, and deliberately not chased in that cycle.

```
$ astrolabe status x hi
… exit 2, kind usage, "unknown project"
$ pgrep -f astrolabe   # a daemon pid, started by the refused call
```

A refused invocation should have no side effect; validation should run before
the daemon is ensured.

## Fixed (2026-09-28)

Reproduced as filed first: through the shipped launcher on a scratch
`ASTROLABE_HOME`, `status x hi` exited 2 (`usage`, "unknown project 'x'") and
left `daemon.port` and `daemon.pid` behind.

The registry is not only in the daemon: it is `$ASTROLABE_HOME/registry.json`,
the snapshot the daemon restores on boot. So when no daemon is answering, the
CLI now builds the board the daemon _would_ boot with and refuses from it,
before anything is spawned. When a daemon is up, the daemon's live state still
decides (the file is a debounced snapshot and may trail it). The restore itself
moved into the pure layer (`restoreRegistry` and `validateProject` in
`scripts/state.ts`), and the daemon and the CLI both call it, so the cold answer
cannot drift from the one the daemon would give.

"No daemon" is not `not_found`: the question is whether the project is
registered, and the disk answers it. A cold refusal therefore has the same kind,
message and exit as a warm one (`usage`, exit 2), plus `choices` naming the
registered ids, as `join`'s warm check already did.

The same shape was in every verb that names a project, and all of them are
fixed: `status`, `attention`, `poke`, `remove` and `join` (unknown id), and
`add` (a duplicate, found by the daemon's own `applyProjectAdd` run against the
cold board). `open` and `tail` validate nothing after ensuring the daemon, and
`state`, `list`, `info` and `close` never spawn one.

Tests (`plugins/spellbook/skills/astrolabe/scripts/cli.test.ts`,
`a refused invocation starts no daemon`):

- `status on an unknown project with no daemon exits 2 and starts nothing`
- `every id verb refuses an unknown project from the disk registry, with its ids as choices`
- `a duplicate add with no daemon exits 2 and starts nothing`
- `a project on the disk registry still starts the daemon and applies`

The error-choices census pin for astrolabe moved 14/1 → 16/2.
