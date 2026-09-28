---
type: item
title: "`bounty add x --stdin` silently drops the positional title"
description:
  add with both a positional title and --stdin takes stdin and discards the
  positional at exit 0 — the misroute sprint 06 refused on update.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: done
id: 01a0e1dc-1ea5-7486-b77e-e386168c4245
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
cycle: 2026-09-one-act-one-answer
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

## Fixed (2026-09-28)

Re-measured red first: `printf 'from stdin\n' | bounty add x --stdin` exited 0
and added a card titled "from stdin". The `x` was gone.

What changed: `add`'s `check` hook (`checkAdd`) now refuses a positional title
given together with `--stdin`. This is the same refusal `checkUpdate` makes for
`update --stdin --title`. It is a usage error: exit 2, stdout empty, one
envelope on stderr
(`add: a title and --stdin both set the title; pass one of them …`). Because it
is raised before any board is contacted, nothing is added. `add <title>` alone
and `add --stdin` alone behave as before.

Pinned by `server.test.ts`, "one act, one answer — add with a title AND --stdin"
› "add <title> --stdin is a usage error (2) and adds nothing; either one alone
still adds".

`message` had the same shape: `message x --stdin` exited 0, toasted the stdin
text and dropped `x`. Its `check` hook (`checkMessage`) now refuses it the same
way, exit 2 and nothing sent. The other verbs that take `--stdin` were checked:
`update`'s only positional is the task id, which `--stdin` does not replace (its
`--stdin --title` clash was already refused), and `init --stdin-tasks` takes no
positional. Pinned by "message <text> --stdin is a usage error (2); either one
alone still sends", in the same `describe`.
