---
type: session
title: glamour open no longer holds the CLI's stderr — 2026-11-24
description:
  open starts its daemon through the kit's startDaemon, with stderr to
  GLAMOUR_HOME/daemon.log, so a caller reading the CLI's stderr to EOF returns.
tags: [glamour]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# glamour open no longer holds the CLI's stderr — 2026-11-24

A fix alongside [Split the kit](../../../cycles/2026-12-kit-split.md).

## Context

`glamour open` spawned its daemon with stderr inherited, so a caller reading the
CLI's stderr to EOF (spawnSync with pipes, Python's `capture_output`) blocked
until the daemon exited.

## What Happened

`cmdOpen` now starts the daemon through the kit's `startDaemon`
(`src/kit/wire/detach.ts`), as Scriptorium's workspace does, replacing about 70
hand-written lines. The daemon's stderr goes to `$GLAMOUR_HOME/daemon.log`
(appended, as bounty's does); a start failure's hint names the log. Changed with
the helper: a daemon that misses the handshake is stopped with its process group
rather than orphaned, an early exit fails at once, and a bad first line is one
of the helper's start failures. The SKILL documents the log and the change.
`detach.ts`'s header, which said no spell used it yet, names its callers.
`grimoire/error-choices-census.test.ts`'s glamour pin went 20 → 19 (two raises
became one).

[glamour-open-reports-a-dead-daemon](../../glamour-open-reports-a-dead-daemon.md)
(triage) did not reproduce on the old code or the new, with both of its probes;
most likely this hang read as a dead daemon. Its state is left for triage.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
`Bash`); `general-purpose` (`*`) chosen, briefed for this branch.

It diffed the old spawn against the helper call field by field (command, args,
cwd, env, detach, timeouts, the success envelope), checked the process-group
kill can reach only the spawned daemon, ran the new test on develop (hangs, as
the bug) and here (passes), glamour's and the kit wire's tests, Biome and the
gate (exit 0). Verdict: yes. Its one doc point was fixed: the SKILL said a
failed `open` leaves no session behind, but glamour's daemon has no SIGTERM
handler, so one killed between its discovery write and the handshake leaves a
stale file. Left as is: `daemon.log` is not rotated (as bounty's isn't); an
unwritable `GLAMOUR_HOME` now fails `open` where bounty falls back to
`"ignore"`.

## Follow-up

- [glamour-start-timeout-nan](../../glamour-start-timeout-nan.md) (triage): a
  non-number `--start-timeout` now kills the daemon at once.
