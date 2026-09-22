---
type: backlog
title:
  "Backlog — Scriptorium: the tail's Monitor expires every 30 minutes and wakes
  the agent for nothing"
description:
  The repeating ~1800 s "timeout" is the harness Monitor's 30-minute cap on the
  tail, not Scriptorium's idle close; each expiry wakes the agent to re-arm
tags: [scriptorium, tail, monitor, co-presence]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: the tail's Monitor expires every 30 minutes and wakes the agent for nothing

## Reported

Cole (Operator doc, 2026-09-20, §6): step away from a document — a meal, an
errand, overnight — and come back to a string of "timeout" events, roughly every
1800 s, each answered by the agent re-arming and going back to sleep. Nothing
else happens. Cole's instinct was to remove Scriptorium's timeout.

## ⛔ The timeout is probably not Scriptorium's

Read 2026-09-22, not yet reproduced:

- Scriptorium **does** have an 1800-s idle close (`server.ts:1539`, `--timeout`,
  default 1800), but it fires only when the session has **no subscribers**
  (`kit/wire/housekeeping.ts:117–120` touches on every tick while one is
  connected). An open tab or a running `tail` holds it open, so it cannot fire
  repeatedly on a session Cole is still using — and when it does fire it closes
  the session (`closed`), it does not repeat.
- The skill tells the agent to run the tail under **Monitor** (`SKILL.md:86`:
  `tail # wrap with Monitor`). Claude Code's Monitor **caps every watch at 1 800
  000 ms** and notifies the agent on expiry, expecting a re-arm. That is the
  observed interval exactly.

So removing Scriptorium's idle close would not change what Cole sees. **Confirm
before acting:** reproduce with a session left idle past 30 minutes and check
whether the wake is a Monitor expiry notice or a `closed` event.

## Why it matters

Same rule as the notes item: a message to an agent must name the act it wants. A
Monitor expiry names none, so the agent's only move is "re-arm", which costs a
turn and tokens every 30 minutes for as long as the human is away.

## Options, none chosen

1. **Skill guidance:** on a Monitor expiry with zero events, re-arm silently —
   no message, no narration. Cheapest; still one wake per 30 min.
2. **A long wait that is not a Monitor:** e.g. a backgrounded `tail` that exits
   on the first event, so the wake happens only when something happens. Loses
   per-event streaming; needs thought about the gap between exit and re-arm.
3. **Let the watch lapse on purpose after a long absence** (Cole's multi-day
   idea): after N expiries with no activity, stop re-arming and say so, with the
   verb that resumes it (`--restore`).

⚠ **Likely house-wide, not Scriptorium's alone:** every spell whose skill wraps
`tail` in Monitor (grapevine, bounty, mind-mapper, …) should hit the same 30-min
cadence. Check the roster before fixing one skill.

## References

- `plugins/spellbook/skills/scriptorium/SKILL.md:86`
- `src/scriptorium/backend/server.ts:1539`, `src/kit/wire/housekeeping.ts:113`
- Related:
  [./2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it.md](./2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it.md)
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
