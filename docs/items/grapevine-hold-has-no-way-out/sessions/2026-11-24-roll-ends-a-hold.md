---
type: session
title: Roll ends a grapevine hold — 2026-11-24
description:
  roll now ends a stop --hold hold and only once the new daemon answers; tails
  wait a hold out and resume from their last id.
tags: [grapevine]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# Roll ends a grapevine hold — 2026-11-24

A fix alongside [Split the kit](../../../cycles/2026-12-kit-split.md).

## Context

After `stop --hold <s>`, `roll` was refused though the hold's refusal named it,
live tails exited 6 with no `tail.*` line, and only `stop --hold 1` shortened a
hold.

## What Happened

`roll` now ends the hold, with no new verb: it starts the new daemon while the
hold file is on disk and clears the hold only once that daemon answers, so a
waiting tail never sees "no hold, no daemon" and spawns a stale one. Refusals
under a hold name `roll` with a runnable hint; `start` reports `held_until`.
Tails wait a hold out (`daemonUnlessHeld()` returns null inside the kit's retry
loop), log one `# daemon held until …` line per hold, and resume from their own
cursor; the handoff window still runs, so a long hold ends in `tail.window` with
`--since`. Chosen over a new `tail.*` line because it needs no kit change and
keeps the tail's presence. The SKILL describes the window as `stop --hold 60`,
swap, `roll`. `restart` still refuses under a hold, and now points at `roll`.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
`Bash`); `general-purpose` (`*`) chosen, briefed for this branch.

First review ran the grapevine suite, the gate (exit 0), a rebuild (dist matches
source) and the new tests against develop's `cli.ts` and `dist/cli.js` (all four
fail). Verdict: yes, with findings. A failed cold roll deleted the operator's
hold in a `finally`: fixed on the branch (the hold stands, and the error says
until when), with a test that fails on the parent; the SKILL misquoted the
waiting line: fixed. A re-review of that commit ran the suite, the census test
and the new test on the parent (fails twice over: message and deleted hold).
Verdict: yes. `grimoire/error-choices-census.test.ts`'s grapevine pin went 53 →
54 for the re-raise.

## Follow-up

- [grapevine-roll-hold-lapse-two-daemons](../../grapevine-roll-hold-lapse-two-daemons.md)
  (triage): a hold lapsing mid-roll can start two daemons; predates this fix.
- `kit-profiles-watch-test-timeout` recurred once in this branch's gate (a slow
  112 s run); noted on that item.
