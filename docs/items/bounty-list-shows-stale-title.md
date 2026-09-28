---
type: item
title: "`bounty list` shows a board's old title after `init --title`"
description:
  list keeps the title a board opened with; state and sessions show the new one.
status: draft
lifecycle: triage
id: 01a0e711-ef68-701d-a5a3-6a8fa03bc7e0
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
---

# `bounty list` shows a board's old title after `init --title`

Found by the no-stake verifier of
[cycle/2026-09-one-act-one-answer](../cycles/2026-09-one-act-one-answer.md),
2026-09-28, on `a7c041d3`, under a scratch `HOME`; filed, not chased. Its
scripts were `t1.sh`–`t9.sh` in that session's scratchpad (not kept).

```
$ bounty init --session-key k1 --title TitleOnly
$ bounty list      # k1 still shows "Orig"
$ bounty state     # "TitleOnly", as does `sessions`
```

`list` seems to read the title from the discovery file written at open. Probably
one state with two readers (see the house rule "one state, one meaning").
