---
type: item
title: A failed restore and a replace that seeds nothing both exit 0
description:
  open --restore of a corrupt snapshot or a directory starts an empty board at
  exit 0; init --replace with every entry invalid empties the board at exit 0.
status: draft
lifecycle: triage
id: 01a0e711-eecd-77c1-9022-7389c7dfeeed
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
---

# A failed restore and a replace that seeds nothing both exit 0

Found by the no-stake verifier of
[cycle/2026-09-one-act-one-answer](../cycles/2026-09-one-act-one-answer.md),
2026-09-28, on `a7c041d3`, under a scratch `HOME`; filed, not chased. Its
scripts were `t1.sh`–`t9.sh` in that session's scratchpad (not kept).

Two cases with one question: an act the caller asked for did not happen, and the
exit code says it succeeded.

- `open --restore <a directory>` and `open --restore <corrupt snapshot>` both
  start an empty board at exit 0 with `restoreFailed` set (EISDIR, or a JSON
  parse error). A _missing_ snapshot is now exit 5 and starts nothing, so the
  three failed restores give two different answers. The item for the missing
  case documents this one as intended (a restore was attempted), which is the
  design question.
- `init --stdin-tasks --replace` with **every** entry invalid exits 0 and
  empties the board (`tasksReplaced: 1`, all input in `tasksDropped`). The
  caller opted in, but a replace that seeds nothing probably meant something
  else.
