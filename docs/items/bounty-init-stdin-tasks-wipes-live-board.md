---
type: item
title: "`bounty init --stdin-tasks` wipes a live board at ok:true"
description:
  init --stdin-tasks over a populated board replaces its tasks with
  tasksDropped:null and no warning.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: ready
id: 01a0e1bd-3ff6-72f5-81dc-fb3122e92bbd
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
cycle: 2026-09-one-act-one-answer
---

# `bounty init --stdin-tasks` wipes a live board at ok:true

Found by
[the sprint 06 re-measure](../features/spell-hardening/sprints/06-filed-is-not-fixed/remeasure.md)
on `b0e9d852`, and deliberately not chased in that cycle.

```
$ bounty add "t" --id t1
$ printf '' | bounty init --stdin-tasks
{"ok":true,"sent":"init","tasksDropped":null}   exit 0, nothing on stderr; t1 is gone
```

`tasksDropped:null` reads as "nothing dropped". The `s5-5` item cites a
board-level destructive-write warning as the precedent for its own fix; the
re-measure found no such warning.
