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

## Fixed (2026-09-28)

Re-measured red first. The literal repro above (`printf ''`) no longer reaches
the board: empty stdin is not JSON, so it is already a `usage` refusal, exit 2.
The defect is real with any JSON array, `[]` included:
`printf '[]' | bounty init --stdin-tasks` over a board holding `t1` answered
`{"ok":true,"sent":"init","tasksDropped":null}` at exit 0 and emptied the board.

What changed:

- The daemon refuses an `init` that carries `tasks` over a board that already
  has tasks: `applied:false`, `kind:"conflict"`, and a sentence naming how many
  tasks are on the board. It decides this itself because only the daemon sees
  the board and the write in one step, and it checks before touching the title,
  so a refused `init` changes nothing. A title-only `init` never conflicts.
- The CLI raises that as `conflict`: exit 6, stdout empty, one envelope on
  stderr whose `hint` names `--replace`.
- `--replace` is the new opt-in (no replace or force flag existed). It is
  declared in the options table that `defineCli` parses and accepted only on
  `init`'s row, and it is refused as usage without `--stdin-tasks`. With it the
  reply adds `tasksReplaced: <n>`, the number of the board's tasks it discarded.
  That is always a number, and `0` on an empty board.
- Seeding an empty board without `--replace` answers byte-for-byte as before.

`tasksDropped` has not changed. It is b8's report of the entries in the caller's
**input** that the daemon rejected (`{requested, dropped:[{index, reason}]}`, or
`null` when every entry was seeded). It never described the board's own tasks,
so its `null` meant "all of your input was valid", not "nothing was lost". The
replace count therefore lives in its own field, so that one key does not carry
two meanings.

Pinned by `server.test.ts`, in "one act, one answer — init over a board that has
tasks". The cell "init --stdin-tasks over a populated board is a conflict (6);
--replace opts in and counts what it replaced" pins the refusal and the opt-in.
The cell "seeding an EMPTY board answers exactly as before, and --replace there
reports 0" pins the empty-board path.
