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
lifecycle: done
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

## Ruling (Cole, 2026-09-23)

A **hybrid**, fixed **in this cycle** because it must ship before the next
release. The fix branch is `feat/tail-quiet-handoff`. This item stays open until
it lands.

- **By default the agent watches with Monitor.** It streams live while Cole is
  active, which is most of the time.
- **At the 30-minute cap, what the watch saw decides the next act:**
  - it saw events: re-arm Monitor with `--since <last id>`;
  - it saw none (he is away: dinner, bed): switch to a one-shot
    `tail --once --since <last id>` in a background Bash task. It sleeps until
    something happens, so there are no idle wakes.
- **When the one-shot fires** (he is back), the agent handles the event and
  returns to Monitor.
- **The script names the next act, not the skill.** Just before the cap, the
  tail ends itself with a line naming the right re-arm command, bookmark
  included. This is the house rule that a response names its next act.
- **The bookmark (`--since`) is always used.** That fixes the replay house-wide.
- **Presence spells** (astrolabe, grapevine) may always get the Monitor re-arm
  line, because a one-shot would flicker their presence.
- **Fix bounty's example.** Its `timeout_ms: 3600000` and `persistent: true` are
  misleading.
- **Fallback:** if the one-shot cannot outlive 30 minutes, re-arm silently with
  the bookmark.

## Built (feat/tail-quiet-handoff, 2026-09-23)

The ruling is built, house-wide, and the branch was cleared to land (re-review,
2026-09-23). How the handoff feels in real use is the session's "What to
exercise" list:
[the session](../projects/scriptorium/sessions/2026-09-23-the-tail-hands-off-before-the-cap.md).

- **The kit: `src/kit/wire/tailHandoff.ts`.** Every spell's `tail` now ends its
  own window 60 s inside Monitor's cap and prints one stdout line naming the
  next act, bookmark included: `tail.window` (re-arm Monitor), `tail.quiet` (run
  `tail --once` as a background Bash task), `tail.woke` (the one-shot fired;
  back to Monitor), `tail.closed` or `tail.lost` (stop; the line names the
  spell's way back: `open --restore <id> --no-open` for the session spells,
  `open --session-key K --no-open` for a keyed bounty board, `open --no-open`
  for astrolabe and mind-mapper, `doctor` for grapevine). Its header is the
  decision log: the four adjustments, the margin, the disconnect decision, and
  the rulings with the options not taken.
- **`tail --once`** on the five session spells (scriptorium, glamour, imago,
  magpie, bounty). The presence spells (astrolabe, grapevine, and mind-mapper,
  whose SSE tail is its agent presence) always get the Monitor re-arm.
- **The client closes its connection on a terminal frame**
  (`src/kit/wire/tailEvents.ts`), which is what lets `--once` exit.
- **A `--since` re-arm prints no grounding line.** Grapevine seeds its bookmark
  from the `subscribed` marker's `latest_id`, so a live-only tail's re-arm no
  longer misses messages sent in the gap.
- **A killed daemon ends a session spell's tail on stdout** (`tail.lost`), in
  both modes, so a Monitor-wrapped agent hears it.
- **Skills:** all seven carry the same short rule (Monitor at
  `timeout_ms: 1800000`, follow the last line, the silent-bookmark fallback,
  never re-arm without `--since`). Bounty's `persistent`, `timeout_ms: 3600000`
  and `--since 0` are gone. mind-mapper's help names `timeout_ms` and the
  handoff.
- **Tests:** `src/kit/wire/tailHandoff.test.ts` (the pure decision, the
  connection close, the wrapper) and
  `src/scriptorium/backend/tail-handoff.integration.test.ts` (a real daemon).
- **The verifier's four defects, fixed on the branch** (D1–D4 in the kit
  header): a re-arm at a session that closed in the gap ends `tail.closed`
  instead of waiting forever; a bookmark from a restarted log is dropped (the
  come-back line says to arm the tail again with no `--since`); a tab's id-less
  ping no longer wakes `--once`; `grapevine tail --human` has no window. The
  review then added B1 (bounty's rule fired on a keyed FIRST arm; now only an
  explicit `--session` or `--since` marks a re-arm, and a keyed board comes back
  by its key) and closed D2's gap for the spells that stamp an epoch: the
  bookmark is printed `--since N@<epoch>`, so a restarted log is re-read from
  its start instead of skipped. Glamour, imago, magpie and bounty stamp none;
  for them the gap is stated in the kit header. Anthill's seat filter, which
  drops the handoff line, is filed as
  [its own item](./2026-09-23-anthill-seat-tail-filter-drops-the-handoff-line.md).

## References

- `plugins/spellbook/skills/scriptorium/SKILL.md:86`
- `src/scriptorium/backend/server.ts:1539`, `src/kit/wire/housekeeping.ts:113`
- Related:
  [./2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it.md](./2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it.md)
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
