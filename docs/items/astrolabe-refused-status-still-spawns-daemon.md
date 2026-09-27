---
type: item
title: "`astrolabe status` spawns a daemon for a command it refuses"
description:
  astrolabe status with an unknown project exits 2 but has already started a
  daemon.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: triage # triage | backlog | ready | active | review | done | dropped
id: 01a0e1bd-40c9-72d2-b371-e4263f728e18
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
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
