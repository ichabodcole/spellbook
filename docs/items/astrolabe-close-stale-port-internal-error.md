---
type: item
title: "`astrolabe close` with a stale port file reports an internal error"
description:
  When the daemon was killed and left its port file, close exits 1 internal
  'Unable to connect', a third shape for the same user act.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: triage # triage | backlog | ready | active | review | done | dropped
id: 01a0e1bd-413b-7160-be58-7efbcb633363
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
---

# `astrolabe close` with a stale port file reports an internal error

Found by
[the sprint 06 re-measure](../features/spell-hardening/sprints/06-filed-is-not-fixed/remeasure.md)
on `b0e9d852`, and deliberately not chased in that cycle.

```
$ kill <astrolabe daemon pid>   # SIGTERM, port file left behind
$ astrolabe close
{"ok":false,"error":{"kind":"internal",…"Unable to connect"}}   exit 1
```

Close on a dead daemon is the same act as close with no daemon (`s5-8`, fixed in
sprint 06 as a benign no-op). Check whether the `s5-8` fix already covers it
before working this.
