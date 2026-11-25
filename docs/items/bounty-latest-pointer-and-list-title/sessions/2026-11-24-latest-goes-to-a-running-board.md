---
type: session
title: bounty's latest pointer goes to a board still running — 2026-11-24
description:
  Closing a board hands bounty-latest.json to the newest board still answering,
  and removes it only when none is; discovery moved out of server.ts to make
  room.
tags: [bounty]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# bounty's latest pointer goes to a board still running — 2026-11-24

A fix alongside [Split the kit](../../../cycles/2026-12-kit-split.md).

## Context

With an unkeyed board A running, opening a keyed board K and closing it deleted
`bounty-latest.json` rather than pointing it back at A, so unpinned `state`,
`add` and `close` exited 5 while `list` showed A running. The item's `list`
title half was moved at triage to `bounty-list-shows-stale-title`; not touched.

## What Happened

- **Room first.** `server.ts` was at its frozen count (2,736), so a
  `refactor(bounty)` commit moved the discovery files' code (paths, the atomic
  boot write, the exit cleanup) out of `main()` into `discovery.ts`, behaviour
  unchanged. `server.ts` is 2,688 and the override was lowered to match; the fix
  adds only an `await` to it.
- **The fix.** `cleanupDiscovery` is async. When `latest` names the closing
  board, it reads the other `bounty-*.json` newest first (a board writes its own
  file once, at boot, so file age is boot order), probes them in parallel with
  `GET /state?lean=1` at 600 ms (the check `list` uses), re-reads `latest`
  before writing so a board that took it meanwhile keeps it, and writes the
  newest one answering atomically; if none answers, the old conditional unlink.
  The SKILL says so in one clause.
- Rebased onto develop before landing; `test-timings.json` was regenerated on
  the new base rather than merged.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
`Bash`); `general-purpose` (`*`) chosen, briefed for this branch.

It checked the refactor was a pure move, that nothing but boot writes a board's
discovery file (so age is boot order), the atomic write's temp name against the
probe's filter, every exit path, and the 5 s watchdog; ran the new test on the
refactor-only commit (fails: `latest` null) and the branch (passes), five
concurrent-close trials in private homes (all correct), the bounty suite, Biome
and the gate (exit 0). Verdict: yes. Left as they are: a rare race, two boards
closing within one probe window, can leave `latest` naming a dead board (exit 5,
as before the fix); probing `/state` resets other boards' idle timers, as `list`
already does. Ideas noted, not filed: a closing daemon could refuse `/state`
once teardown starts, and the probe could check the reply's `session_id`.

The implementer once ran a bare `git stash push`/`pop` (the stack is shared
across worktrees); the lead checked afterwards that the stack was empty and the
worktree clean.

## Follow-up

- [spell-latest-pointer-deleted-on-close](../../spell-latest-pointer-deleted-on-close.md)
  (triage): magpie and glamour clean up their pointer the same way.
