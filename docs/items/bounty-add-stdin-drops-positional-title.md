---
type: item
title: "`bounty add x --stdin` silently drops the positional title"
description:
  add with both a positional title and --stdin takes stdin and discards the
  positional at exit 0 — the misroute sprint 06 refused on update.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: triage # triage | backlog | ready | active | review | done | dropped
id: 01a0e1dc-1ea5-7486-b77e-e386168c4245
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
---

# `bounty add x --stdin` silently drops the positional title

Found by the sprint 06 no-stake verifier (2026-09-27, on `5554e12b`); not a
break of any sprint 06 claim, filed rather than chased.

```
$ printf 'from stdin\n' | bounty add x --stdin
{"ok":true,"added":…}   exit 0; the title is "from stdin", "x" is gone
```

Same on the build before sprint 06. Sprint 06 made `update --stdin --title` a
usage error ([its item](bounty-update-stdin-misroutes-to-title.md)); `add` now
disagrees with it. The likely fix is the same refusal in `add`'s `check` hook.
