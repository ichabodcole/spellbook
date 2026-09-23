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

## Findings (spike, 2026-09-22)

Full write-up:
[the Monitor-expiry investigation](../investigations/2026-09-22-monitor-expiry-and-the-tail.md).
The ruling is pending, so this item stays open.

- **Cause confirmed.** The wake is the Monitor's 1,800,000 ms cap (per the
  tool's schema; a 3,600,000 ms request came back as "expires in 30m"). It is
  not Scriptorium's idle close, which cannot fire while a tail is connected.
  Reproduced: an 8 s idle close did not fire under a 20 s Monitor, which ended
  with an expiry notice and no `closed` event.
- **The re-arm replays the session.** `tail` with no `--since` replays the whole
  event buffer (up to 1000 frames), including human messages already answered.
  That invites duplicate replies. `--since <last id>` fixes it, but no skill
  says so.
- **House-wide.** Seven skills (plus mind-mapper's CLI help) wrap a tail in
  Monitor, and all hit the cap. Every tail except grapevine's replays on a bare
  re-arm. Bounty's example passes `--since 0`, plus a `timeout_ms` and
  `persistent` that don't do what they imply.
- **Recommendation:** fix the replay everywhere (cursor on re-arm). Pilot a
  one-shot background wait on Scriptorium for zero idle wakes. Avoid the
  deliberate lapse. **Cole rules** whether 2 idle wakes an hour are acceptable,
  and whether zero is worth a re-arm after every event.

## References

- `plugins/spellbook/skills/scriptorium/SKILL.md:86`
- `src/scriptorium/backend/server.ts:1539`, `src/kit/wire/housekeeping.ts:113`
- Related:
  [./2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it.md](./2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it.md)
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
