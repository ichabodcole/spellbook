---
type: session
title: "The tail hands off before the cap — 2026-09-23"
description:
  Every spell's tail now ends itself before Monitor's 30-minute cap and prints
  the next act with its bookmark, so an idle session stops waking the agent and
  a re-arm no longer replays; the review found a hang, a stray board, a skipped
  log start and wiring no test reached
tags: [tail, monitor, co-presence, verification]
status: stable
generated: { by: claude-opus-5.5, at: 2026-09-23 }
---

# The tail hands off before the cap — 2026-09-23

Part of
[Scriptorium from real use](../../../cycles/2026-09-scriptorium-real-use.md),
its fifth and sixth branches: the Monitor-expiry spike and
`feat/tail-quiet-handoff`. The fourth is
[a note that says it is with the agent](./2026-09-22-a-note-that-says-it-is-with-the-agent.md).

**Why it is filed here.** The work is house-wide: the kit and every spell with a
tail. There is no home for cross-spell session docs. `docs/projects/` holds one
folder per project and `docs/sessions/` does not exist. So it sits with the
cycle that produced it, under Scriptorium, whose real use raised it.

## What this was

Cole saw a "timeout" roughly every 1800 s whenever he left a Scriptorium
document alone. Branch 5's spike
([the investigation](../../../investigations/2026-09-22-monitor-expiry-and-the-tail.md))
found the cause. The wake was Claude Code's Monitor reaching its 30-minute cap
on the tail, not Scriptorium's idle close. And every bare re-arm replayed up to
the last 1000 events, answered human messages included. Both were house-wide:
seven skills (and mind-mapper's help) wrap a tail in Monitor, and all eight
tails share one client.

Cole ruled a hybrid into this cycle because it must ship before the next
release. A feasibility spike then proved the risky half: a background one-shot
slept 38 minutes, past the cap, and still woke the agent on the next event. The
same spike found the four adjustments this branch had to carry.

## Rulings

Cole's, recorded on
[the backlog item](../../../backlog/2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing.md#ruling-cole-2026-09-23):

- **The hybrid.** Monitor while he is active. At the cap, re-arm Monitor if the
  window saw events, or switch to a background one-shot `tail --once` if it saw
  none. When the one-shot fires, the agent handles the event and returns to
  Monitor.
- **The script names the act, not the skill.** The tail ends itself just before
  the cap and prints the re-arm command.
- **The bookmark is always used.**
- **Presence spells always re-arm Monitor**, because a stop-start tail would
  flicker their presence.
- **In this cycle.**

## What was built

The decision log is the header of `src/kit/wire/tailHandoff.ts`: A1–A4 for the
spike's adjustments, D1–D4 and B1 for the review, each with the options not
taken.

- **`src/kit/wire/tailHandoff.ts`.** A watch ends 60 s inside the cap and prints
  one stdout line naming the next act:
  - `tail.window`: re-arm Monitor;
  - `tail.quiet`: run `tail --once` as a background Bash task;
  - `tail.woke`: the one-shot fired, so go back to Monitor;
  - `tail.closed` or `tail.lost`: stop, and here is how to come back.

  Each line carries a command that runs as printed. The decision is the pure
  `handoff()`.

- **`tailEvents` closes its connection on a terminal frame.** Without this,
  `--once` never exits, and a background task that never exits never wakes the
  agent. The client also reports its final cursor and epoch, detects a restarted
  log, and no longer opens a stream after a stop that lands during `resolve`.
- **`--once`** on the five session spells: scriptorium, glamour, imago, magpie
  and bounty. Astrolabe, grapevine and mind-mapper are presence tails.
  _Superseded for mind-mapper by Cole's ruling of 2026-09-24: it takes `--once`
  too (`feat/mind-mapper-quiet-handoff`; the kit header's "MIND-MAPPER JOINS THE
  SESSION SPELLS")._
- **The bookmark carries its log.** Spells whose daemon stamps an epoch print it
  as `--since N@<epoch>`, so a tail re-armed across a restart re-reads the new
  log instead of skipping its start.
- **Skills.** All seven skills and mind-mapper's help give the same short rule:
  Monitor at `timeout_ms: 1800000`, do what the last line says, re-arm silently
  from the last id if the cap wins, and never re-arm without `--since`. Bounty's
  example lost `persistent`, `timeout_ms: 3600000` and `--since 0`. Imago's and
  grapevine's Monitor greps let the handoff line through.
- **Tests.** Kit cells over a fake daemon, plus real-daemon cells for
  scriptorium, bounty, glamour and grapevine, and fake-daemon cells for
  astrolabe and mind-mapper. The window is injected
  (`SPELLBOOK_TAIL_WINDOW_MS`), so no cell waits minutes.

## Review

**Census** (roster read from the session's available agent types):
**`general-purpose`** for the verifier and the reviewer of record, and
**`investigator`** for both spikes. Neither reviewer was the implementer, and
both could run code.

- **The implementer's own real run.** Under a real Monitor with a 20 s window: a
  quiet window handed off to a background `--once`, a real message woke it, and
  the Monitor re-arm replayed nothing.
- **Verifier** (no stake). It ran every spell's real tail through the shipped
  launchers. The happy path held. It found four defects:
  - **D1:** a re-arm at a session that closed in the gap waited forever,
    silently. The trigger is ordinary: the human presses Close while the agent
    is handling `tail.woke`.
  - **D2:** after a daemon restart, the old bookmark replayed the whole new log
    on every re-arm, and `--once` woke in a loop. This was the branch's own
    replay bug, reached through its own stop-and-come-back path.
  - **D3:** a tab's id-less connect and disconnect pings woke `--once`.
  - **D4:** `grapevine tail --human`, a person at a terminal, now ended after 29
    minutes.
  - It also found that anthill's seat filter drops the handoff line. That is
    filed for anthill; see below.
- **Reviewer of record.** Verdict: _land with fixes_.
  - **B1 would have broken anthill seats.** Bounty resolves a session from
    `$BOUNTY_SESSION_KEY` too, so D1's rule fired on a seat's FIRST arm, and the
    seat got `tail.closed` before its board existed. The keyed come-back also
    restored by id, which spawned an unkeyed stray board.
  - **The D2 gap.** An old bookmark at or below a restarted log's length made
    the daemon send only what lay above it, so a human message at new id 2 was
    skipped with no notice. The first version of D2 had listed "carry the epoch
    in the bookmark" as not taken. The reviewer showed the gap live, and the
    client-only fix it suggested went in: `--since N@<epoch>`, and an epoch
    change past the asked cursor re-reads the new log from 0. No daemon or wire
    change.
  - **Wiring no test reached**, found by mutation: the per-spell rules and
    grapevine's seeding, marker and `--human` wiring. The pure rule was pinned
    and the wiring around it was not, the same shape as
    [the earlier memory](../../../memories/2026-09-22-the-rule-was-pinned-the-wiring-was-not.md).
    Each got a cell, confirmed by re-applying the mutant. Two survivors turned
    out to change nothing and were removed rather than pinned.
- **Re-review:** _land_. B1 and D2 were re-run, and every printed command
  parses. It asked for cells on astrolabe's and mind-mapper's epoch
  pass-through, which were added and mutation-confirmed.

## Rulings made here that Cole did not cover

All are in the kit header with the options not taken.

- **Mind-mapper is a presence spell.** Its SSE tail is what its daemon counts as
  an agent present, so its window always re-arms Monitor. Cole has not overruled
  this. _Superseded: Cole overruled it on 2026-09-24. Mind-mapper follows the
  session spells, and its daemon's presence lingers across the tail's gaps
  (`feat/mind-mapper-quiet-handoff`; the kit header's "MIND-MAPPER JOINS THE
  SESSION SPELLS")._
- **The margin is 60 s.** It covers start-up, a daemon spawn, the last line's
  flush and Monitor's batching. The spike measured a 12 s window ending cleanly
  under a 20 s cap.
- **A lost session-spell daemon ends the tail on stdout, in both modes.** "Lost"
  means three refused connections in a row, about 0.75 s under the kit's
  backoff. A dropped stream alone stays silent. Before, `tail.disconnected` on
  stderr left a Monitor-wrapped agent unaware of a `kill -9`. Presence tails
  keep retrying.
- **Only a delivered log frame counts or wakes `--once`.** Frames the tail's own
  filter rejects and frames without a log id don't.
- **`--once` ends on the first frame, with no drain.** A burst arrives split,
  and the bookmark loses nothing.
- **The window is set by an env var** (`SPELLBOOK_TAIL_WINDOW_MS`, `0` for a
  human's terminal), not a flag. It is not an agent's act.

## Known and not built

- **The no-epoch spells' fallback gap.** Glamour, imago, magpie and bounty stamp
  no epoch (ruled session-scoped). For them, a Monitor-cap fallback re-arm
  across a restart can still skip the new log's start. The whole-replay net and
  the come-back rule cover the rest. Closing it needs an epoch on
  `createEventLog`.
- **The keyed late-lead edge.** A keyed bounty first arm whose window ends
  before its board opens prints a pinned re-arm. If the lead is more than one
  window late, the seat gets `tail.closed`, whose come-back is still the right
  step.
- **The versioned plugin path.** The printed command names the launcher's full
  path, which includes the installed plugin's version directory. Across an
  upgrade, a re-arm keeps running the old version.
- **Anthill's seat filter**
  ([its own item](../../../backlog/2026-09-23-anthill-seat-tail-filter-drops-the-handoff-line.md)).
  `team-join`'s grep drops every `tail.*` line, and every `task.*` event with
  it. The change is anthill's to make.

## Verification

`bun run gate` on the final tree, run unpiped: exit 0. The committed `dist/` was
rebuilt with each change. The implementer's, the verifier's and the reviewer's
real runs are described above; every session and daemon they opened was closed.

## What to exercise, next time the app is open

1. **Leave a Scriptorium session for more than 30 minutes, then come back and
   send a message.** The agent should not have woken while you were away. It
   should answer your message once, with nothing old answered again.
2. **Stay active past the 29-minute mark.** The agent should re-arm quietly and
   keep streaming.
3. **Close the session while the agent is mid-answer.** Its next watch should
   say the session closed, not hang.
4. **Restart a session with `open --restore` after a crash, then keep talking.**
   Your first new message should reach the agent.
5. **Run an anthill team on bounty** once anthill carries the filter change, and
   watch a seat's lane survive its first window.
