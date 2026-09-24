---
type: backlog
title: "Residuals from the Scriptorium real-use cycle"
description:
  Known gaps the cycle recorded only in its sessions (the no-epoch spells'
  fallback gap, the keyed late-lead edge, a resize not re-placing a pane,
  triple-click giving no chip, batched note review) and two later verifiers
  found (magpie's `--once` waking on a tab connecting, a doubled
  `epoch.changed`), each with a repro or pointer
tags: [scriptorium, tail, residuals]
status: draft
lifecycle: open
generated: { by: claude-opus-5.5, at: 2026-09-24 }
---

# Residuals from the Scriptorium real-use cycle

These were recorded under "Known and not built" in the sessions of
[Scriptorium from real use](../cycles/2026-09-scriptorium-real-use.md), and
nowhere else, plus two found later (sections 6 and 7). They are grouped here so
that none is lost. Each is small, or is waiting on Cole. If one grows, split it
into its own item. The versioned plugin path from the same list has
[its own item](./2026-09-24-tail-rearm-command-names-a-versioned-plugin-path.md),
because it can bite at the next release. It is resolved: the printed command
names no path, and the agent runs it with its own launcher (Cole's ruling,
2026-09-24; `fix/tail-rearm-without-plugin-path`).

## 1. The no-epoch spells' fallback gap

**What:** glamour, imago, magpie and bounty stamp no epoch on their event logs,
because the logs were ruled session-scoped. The tail handoff's fix for a
restarted log, `--since N@<epoch>`, therefore cannot reach them on one path: the
**Monitor-cap fallback**. If the cap wins before the handoff line, the skills
say to re-arm from the last id seen. If the daemon restarted in between, an old
bookmark at or below the new log's length makes the daemon send only what lies
above it, and the new log's early events are skipped without notice. The
whole-replay net and the come-back rule cover the other paths.

**Repro (sketch):** for bounty, tail a session and note the last id `N`, where
`N` is greater than 2. Restart its daemon. Post two events to the new log.
Re-arm with `tail --since N`. The two events never arrive.

**Fix direction:** a daemon change, adding an epoch on `createEventLog`
(`src/kit/wire/eventLog.ts`), so every spell prints `N@<epoch>`.

**Pointers:** the ⚠ STATED LIMIT under D2 in the header of
`src/kit/wire/tailHandoff.ts`;
[session](../projects/scriptorium/sessions/2026-09-23-the-tail-hands-off-before-the-cap.md#known-and-not-built).

## 2. The keyed late-lead edge

**What:** a keyed bounty **first** arm (an anthill seat) whose window ends
before its board opens prints a re-arm pinned to the derived id with an empty
bookmark (`--session k-… --since=-1 --once`). By D1's rule, that is a re-arm. So
if the board still does not exist, because the lead is more than one window (29
minutes) late, the seat gets `tail.closed` instead of waiting. The come-back it
names (`open --session-key K`) is still the right next step, which is why this
is minor.

**Repro:** run a seat's keyed `bounty tail` with a short
`SPELLBOOK_TAIL_WINDOW_MS` and no board open. Let the window end. Run the
printed re-arm, still with no board. It prints `tail.closed`.

**Pointers:** "KNOWN EDGE, NOT FIXED" in the header of
`src/kit/wire/tailHandoff.ts`;
[session](../projects/scriptorium/sessions/2026-09-23-the-tail-hands-off-before-the-cap.md#known-and-not-built).

## 3. A resize does not re-place a pane

**What:** a resize invalidates the rendered pane's anchors but does not re-place
the pane. So dragging the split handle keeps your pixel offset rather than your
source line, and the raw pane, which rewraps, can drift. **Cole deferred this
pending his own use.** The question is whether it is annoying, not whether it
happens. Across a collapse (branch 3), rendered mode held its top block thanks
to scroll anchoring, while raw moved by one source line and came back exactly on
reopen.

**Repro:** in split view, scroll to a heading, then drag the divider wide.

**Pointers:**
[branch 2 session](../projects/scriptorium/sessions/2026-09-22-keeping-your-place-and-the-guard-that-guesses.md#known-and-not-built),
[branch 3 session](../projects/scriptorium/sessions/2026-09-22-room-to-read-and-the-width-the-anchors-forgot.md#known-and-not-built).

## 4. Triple-click in rendered mode gives no chip

**What:** in rendered mode, a triple-click selects the paragraph, but no chip
appears. It predates the cycle: branch 3's verifier found it on `develop`, and
it was not that branch's to fix. It is the same family as the
[selection edges](./2026-09-22-scriptorium-selection-edges-the-review-found.md)
(the chip and the visible selection disagreeing), so it could be folded in
there.

**Repro:** open a document in rendered view, triple-click a paragraph, and look
at the composer.

**Pointers:** `src/scriptorium/surface/state/selection.ts`
(`renderedSelectionAct`), `MarkdownView.tsx`;
[session](../projects/scriptorium/sessions/2026-09-22-room-to-read-and-the-width-the-anchors-forgot.md#known-and-not-built).

## 5. Batched note review

**What:** notes held until the human sends them as one message, so a review is
not interrupted by edits. This is the case the original "a note is not a
request" design was reaching for. **Cole flagged it as later work,** and the
cycle kept it out of scope because it may reshape branch 4's design rather than
extend it. It was option 4 in the note item and is untouched.

**Pointers:**
[the note item, option 4](./2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it.md);
[branch 4 session](../projects/scriptorium/sessions/2026-09-22-a-note-that-says-it-is-with-the-agent.md#rulings).

## 6. Magpie's `--once` wakes on a tab connecting

**What:** the verifier of `fix/tail-rearm-without-plugin-path` ran magpie's full
loop literally, and its background `--once` woke on the WebSocket `connected`
lifecycle event before the human's message arrived. Magpie puts `connected` on
its event log, with a log id, so under the handoff's rule (a delivered log frame
counts and wakes `--once`) it is a real wake. Glamour's and imago's pings carry
no id and do not wake it. It predates that branch.

**Arguably fine:** a tab connecting usually means the human is back, which is
what the one-shot waits for. **But it is a wake without work.** The agent
handles nothing and re-arms, and a reload or a second tab does it again.

**If it is ever changed:** a `counts` predicate in magpie's tail that leaves out
`connected`/`disconnected`, as grapevine's leaves out its `subscribed` marker.
Or take them off the log, as glamour does. Either way, wait for real use to say
whether the wake is wanted.

**Pointers:** `src/magpie/backend/server.ts` (the lifecycle emits),
`src/kit/wire/tailHandoff.ts` (A3, D3).

## 7. `epoch.changed` prints twice after an in-process reconnect to a restarted daemon

**What:** the verifier of `feat/mind-mapper-quiet-handoff` restarted
mind-mapper's daemon on a different port under a running tail. The tail
re-resolved and reconnected in-process, and printed `epoch.changed` twice, the
second time with the same epoch. It predates that branch; it is in the kit, so
any epoch-stamping spell that reconnects in-process (scriptorium, astrolabe,
mind-mapper) can show it.

**Cause (the verifier's):** in `tailEvents.ts`, the epoch branch resets the
cursor and prints the line but sets only the per-frame `epochReset`, not the
per-attempt `restartNoted`. `askedSince` still holds the old bookmark for the
rest of that attempt. So the NEXT frame of the new log, whose id is also at or
below the old bookmark, passes the `restartOnReplay` check (`!epochReset` is
true again, `!restartNoted` is true, `n <= askedSince`) and prints a second
`epoch.changed`.

**Cost:** an extra line naming nothing new. An agent told to refetch state on
`epoch.changed` does it twice. No frame is lost or replayed.

**If it is changed:** set `restartNoted = true` where the epoch branch resets
the cursor, with a cell in `tailEvents.test.ts` that reconnects to a new epoch
whose first two frames are at or below the bookmark and expects one line.

**Pointers:** `src/kit/wire/tailEvents.ts` (the epoch branch and the
`restartOnReplay` check in the frame loop), `src/kit/wire/tailHandoff.ts` (D2).
