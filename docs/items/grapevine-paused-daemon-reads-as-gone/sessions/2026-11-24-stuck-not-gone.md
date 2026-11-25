---
type: session
title: A paused grapevine daemon is stuck, not gone — 2026-11-24
description:
  Discovery tells a silent live daemon from a gone one, refuses to spawn beside
  it, and names the kill that clears it; daemon discovery moved out of cli.ts to
  make room.
tags: [grapevine]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# A paused grapevine daemon is stuck, not gone — 2026-11-24

A fix alongside [Split the kit](../../../cycles/2026-12-kit-split.md).

## Context

`readDaemonPort` deleted the port and pid files when the daemon didn't answer in
500 ms, so a SIGSTOPped daemon read as gone and `start` or `restart --force`
spawned a second one beside it.

## What Happened

- **Room first.** `cli.ts` is frozen under the 1,200-line limit, so a
  `refactor(grapevine)` commit moved daemon discovery (port and pid paths, the
  ping, the hold helpers, `untilDaemonGone`, enumeration, doctor's and reap's
  sweeps) into `daemonDiscovery.ts`, behaviour unchanged. `cli.ts` went 2,466 →
  2,267, and the override was lowered to 2,282, the count after the fix, so no
  commit raises it.
- **Three answers.** Discovery returns live (answered in 500 ms), stuck (the
  port accepts but stays silent, and `ps` names the pid a grapevine daemon), or
  stale (refused, dead pid, or a pid that isn't a daemon; cleaned as before). A
  live pid gets a second 2.5 s ping before it is called stuck: at 500 ms alone,
  healthy daemons under the full parallel suite read as stuck. Only the stuck
  path pays it.
- **Refusals.** Every port-reading verb refuses a stuck daemon: exit 6,
  `daemon_stuck`, the pid and port, hint `kill -CONT <pid>`, then `kill -KILL`.
  `start`, `restart --force` and `roll --force` refuse rather than spawn;
  `doctor` reports `stuck`; `reap` keeps it as the home's own; a waiting tail
  notes it once and waits. The census pin went 54 → 56; the SKILL gained one
  bullet.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
`Bash`); `general-purpose` (`*`) chosen, briefed for this branch.

It diffed the moved code line for line, measured Biome's counts at both commits,
ran `ps -p <pid> -o command=` in `ubuntu:24.04` for CI's Linux, ran the new test
file on develop (two of three fail; the third guards existing behaviour), the
grapevine suite, `bunx biome lint` and the gate (exit 0, 6,517 pass), and
checked no stopped process of its own was left. Verdict: yes. Three nits, left
as they are: when `ps` cannot run, the `kill -KILL` hint names an unconfirmed
pid; the once-per-pid tail note doesn't repeat if the same pid pauses twice;
`ps -ww` would guard against a narrow `COLUMNS`.

## Follow-up

- [grapevine-daemon-startup-clears-stuck-pair](../../grapevine-daemon-startup-clears-stuck-pair.md)
  (triage): `daemon.ts`'s own startup ping still deletes the pair.
