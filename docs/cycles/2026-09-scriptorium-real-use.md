---
type: cycle
title: "Scriptorium from real use"
description:
  Fix what Cole's real editing sessions found in Scriptorium — selection and
  context bugs, losing your place, cramped layouts, silent notes, and the
  30-minute wake-ups
tags: [scriptorium, real-use, co-presence]
status: draft
lifecycle: closed
started: 2026-09-22
closed: 2026-09-24
appetite:
  "Stop when the context chip always matches the selection, switching views
  keeps your place, the side columns can get out of the way, a note shows that
  it is being worked on, and the 30-minute wake-up has an explanation and a
  ruling. Anything that needs more real use to decide waits for the next cycle."
scope:
  - backlog/2026-09-22-scriptorium-chat-context-does-not-mirror-the-selection
  - backlog/2026-09-22-scriptorium-rendered-selection-maps-to-wrong-lines
  - backlog/2026-09-22-scriptorium-view-switches-lose-scroll-position
  - backlog/2026-09-22-scriptorium-reader-mode-and-collapsible-sidebars
  - backlog/2026-09-22-scriptorium-a-note-is-acted-on-and-nothing-shows-it
  - backlog/2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing
after: []
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium from real use

## Why now

Scriptorium is the first spell Cole has used for sustained real work since it
shipped, and his notes (Operator, `Spells/Scriptorium`, 2026-09-20) are exactly
the real-use signal the project waits for before changing a surface. The bugs
cost trust in the thing that makes the app useful: the passage that rides along
with a message. The design findings (notes, timeouts) are one house rule — a
message to an agent must name its next act — showing up twice in one spell.

## Scope

Planned as five branches, in this order. Bugs go first because they are small
and well located. The spike goes last because it may turn into a change across
every spell.

1. **`fix/scriptorium-selection-context`**
   - **backlog/…-chat-context-does-not-mirror-the-selection** — dismissing the
     chip no longer blocks later selections, and click-to-deselect clears it in
     rendered mode. Both are cleared in the daemon's copy too, not just the
     surface's.
   - **backlog/…-rendered-selection-maps-to-wrong-lines** — reproduced on one of
     Cole's real documents, that document kept as a `projection.ts` test, and
     fixed. If it cannot be reproduced, the item records what was tried.
2. **`feat/scriptorium-keep-your-place`**
   - **backlog/…-view-switches-lose-scroll-position** — raw ↔ rendered keeps the
     visible section (or the selection), and split panes stay roughly aligned.
     Built on one "source line at the top of this pane" primitive.
3. **`feat/scriptorium-collapsible-sidebars`**
   - **backlog/…-reader-mode-and-collapsible-sidebars** — either side column, or
     both, can be collapsed, and that choice persists. Reader mode is in scope
     only if it turns out to be "rendered + collapsed + quieter chrome".
     Otherwise it gets split off. The composer stays reachable either way.
4. **`feat/scriptorium-note-in-progress`**
   - **backlog/…-a-note-is-acted-on-and-nothing-shows-it** — a new note shows
     that work has started, and that signal can go stale like E53's does.
     `SKILL.md` stops claiming "a note is not a request". Choosing between the
     surface-only and agent-acknowledged options is the branch's first step.
5. **Spike: Monitor expiry**
   - **backlog/…-tail-monitor-expiry-wakes-the-agent-for-nothing** — reproduced,
     and the source confirmed (Monitor's 30-min cap, or the daemon). Then a
     ruling. If the cause is the Monitor pattern the other skills share, the fix
     may leave this cycle as its own item.
   - **Found (2026-09-22):** the fix is house-wide, not Scriptorium's. The wake
     is the Monitor's 30-minute cap, and every bare re-arm replays the session,
     so answered messages come back looking live. The shared tail client in the
     kit (`src/kit/wire/tailEvents.ts`) and the seven skills that wrap a tail in
     Monitor all carry it. See
     [the investigation](../investigations/2026-09-22-monitor-expiry-and-the-tail.md).
6. **`feat/tail-quiet-handoff`** (added by Cole's ruling, 2026-09-23)
   - **The scope widens past Scriptorium on purpose.** The replay is a
     correctness bug in every spell with a tail, and Cole ruled that the fix
     must ship before the next release. So it stays in this cycle instead of
     leaving as its own item. The hybrid he chose (Monitor while active, a
     one-shot background wait while away, and the tail naming its own re-arm
     with the bookmark) is recorded as the Ruling on the backlog item. It
     touches the kit client and all seven skills, bounty's misleading example
     included.

Unplanned addition:

- **`fix/scriptorium-chip-across-documents`**: edge 0 of
  `backlog/2026-09-22-scriptorium-selection-edges-the-review-found`. The chip
  survived a document switch under the new document's name, which breaks this
  cycle's appetite. Cole ruled it fixed in-cycle.

Out of scope, deliberately:

- **Eager vs. lazy versioning**
  (`backlog/2026-09-22-scriptorium-eager-or-lazy-versioning`). Cole is
  undecided, and it needs more real use before anything is built.
- **Batched note review.** Cole flagged it as later work, and it may reshape
  branch 4's design rather than extend it.
- **The 2026-09-14/15 release-hygiene backlog** (dependency sweep, CI running
  `gate` twice, nested `node_modules`). A different theme, left for its own
  cycle.

## Outcome

Closed 2026-09-24. Every entry in `scope:` is `done` and all seven branches
landed on `develop`. The appetite was met, except that the chip clause holds for
everything Cole reported but not yet "always" (below). The cycle also shipped a
fix it had not planned: the house-wide tail handoff, which its own spike found.

### Against the appetite

- **"The context chip always matches the selection."** Met for every case Cole
  reported and for the worst edge the reviews found, but not yet _always_.
  [Branch 1](../projects/scriptorium/sessions/2026-09-22-the-chip-and-the-lines-it-pointed-at.md)
  fixed the four causes of rendered-mode drift, and Cole ruled that clearing the
  chip clears the selection, in the daemon too.
  [The chip-across-documents fix](../projects/scriptorium/sessions/2026-09-22-a-selection-that-outlived-its-document.md)
  stopped a selection surviving a document switch under the new document's name.
  Three edges in
  [the selection-edges item](../backlog/2026-09-22-scriptorium-selection-edges-the-review-found.md)
  can still put the wrong passage on a message, or none: an unplaceable
  selection keeps the previous passage (edge 1), a note added from the Notes
  panel leaves its passage on the chip (edge 4), and a second tab wipes the
  daemon's selection while the first tab's chip still shows it (edge 5).
- **"Switching views keeps your place."** Met.
  [Branch 2](../projects/scriptorium/sessions/2026-09-22-keeping-your-place-and-the-guard-that-guesses.md):
  raw, rendered and split keep the top-visible source line, all through one
  primitive. Two sub-frame holes are pinned and filed. A resize still does not
  re-place a pane; Cole deferred that until his own use says it matters.
- **"The side columns can get out of the way."** Met.
  [Branch 3](../projects/scriptorium/sessions/2026-09-22-room-to-read-and-the-width-the-anchors-forgot.md):
  either column collapses and the choice persists. The composer floats while the
  conversation is shut, and reader mode fell out as a derived preset.
- **"A note shows that it is being worked on."** Met.
  [Branch 4](../projects/scriptorium/sessions/2026-09-22-a-note-that-says-it-is-with-the-agent.md):
  a note shows it is with the agent and goes to a static "may be stuck" the way
  E53's messages do. Resolving it is the close. On Cole's ruling, three
  trade-offs are left to be learned in use.
- **"The 30-minute wake-up has an explanation and a ruling."** Exceeded.
  [The spike](../investigations/2026-09-22-monitor-expiry-and-the-tail.md)
  explained it: the wake was Monitor's cap, not Scriptorium, and every bare
  re-arm replayed the session. Cole ruled, and
  [`feat/tail-quiet-handoff`](../projects/scriptorium/sessions/2026-09-23-the-tail-hands-off-before-the-cap.md)
  shipped the fix to the kit and every spell with a tail.
- **"Anything that needs more real use waits."** Held. Eager vs. lazy
  versioning, the note trade-offs, the resize re-place, a collapse shortcut, and
  which tab's selection should win all wait on Cole's use. Each session ends
  with a "what to exercise" list, which is where that signal will come from.

### How the scope moved

Two additions, both ruled in by Cole, each for a stated reason.

- **The chip across documents.** Branch 4's reviewer of record found it with a
  real mouse. It predated the cycle, but it broke the first appetite clause, and
  it sent the agent one document's text as another's. So it was fixed in-cycle
  rather than filed.
- **The tail handoff.** Branch 5 was planned as a spike that might leave the
  cycle. It found the cause in the shared kit client and all seven skills that
  wrap a tail, not in Scriptorium. Cole kept the fix in because the replay is a
  correctness bug in every spell with a tail and has to ship before the next
  release. That widened the cycle past Scriptorium on purpose. Its session sits
  under Scriptorium only because a cross-spell session has no other home in
  `docs/`.

### The working method

The orchestrator delegated every branch in three stages, none of which reviewed
its own work. An implementer built it test-first. A no-stake verifier drove the
committed build with its own reproductions. A fresh reviewer of record read the
net diff, ran the gate and mutation-tested the new cells. The chip fix, the
smallest, used one agent to verify and review, and that agent still found a
second defect.

Each stage found what the one before it passed over:

- **The verifier found defects the implementer's green tests did not.** Every
  branch had at least one: the offset-0 clamp (branch 1), the time-window guard
  that discarded a human's scroll (branch 2), controls clipped out of reach
  (branch 3), a second "Ask the agent" that re-sent (branch 4), the reveal range
  carrying the same wrong-document flaw (chip fix), and a re-arm that hung when
  the session closed in the gap (tail).
- **The reviewer found code that could change with the suite still green.**
  Deleting `alignRuns`' back-off loop (branch 1), branches in `columns.ts`
  (branch 3), and the wiring around a well-pinned rule (branch 4 and the tail)
  all survived mutation until cells were written. It also found what nobody had
  asked about: an inverse bug that branch 1's fix opened, a falsified "only one
  ordering" claim (branch 2), and a rule in the tail that would have sent an
  anthill seat `tail.closed` on its first arm, before its board existed.

On branches 1 and 3 the orchestrator re-ran the reviewer's decisive mutations
itself before landing.

### What it learned

The memories carry the detail. Four generalise past their incident and are
proposed for `grimoire/house-style.md` in
[the house-style rules item](../backlog/2026-09-24-house-style-rules-from-scriptorium-real-use.md):

- [one state, one meaning](../memories/2026-09-22-scriptorium-selection-and-the-chip.md)
- [ask what a number is for](../projects/scriptorium/sessions/2026-09-22-keeping-your-place-and-the-guard-that-guesses.md#the-rule-that-came-out-of-it-and-it-is-not-scriptoriums)
  before writing it into a document
- [a place in a document names its document](../memories/2026-09-22-a-place-in-a-document-names-its-document.md)
- [a wait that wakes by ending must end](../memories/2026-09-23-a-wait-that-wakes-by-ending-must-end.md)

Two stay memories, and that item says why:
[an exact test over a time window](../memories/2026-09-22-a-time-window-is-a-guess.md)
with
[its observer-order sequel](../memories/2026-09-22-an-observer-is-late-for-the-event-that-beats-it.md),
and
[the rule was pinned, the wiring was not](../memories/2026-09-22-the-rule-was-pinned-the-wiring-was-not.md).

### Carried forward

Open backlog items this cycle filed or touched:

- [Selection edges](../backlog/2026-09-22-scriptorium-selection-edges-the-review-found.md):
  edges 1–7 (edge 0 is fixed). Edges 1, 4 and 5 are the ones that can send the
  wrong passage; 3 and 6 are cosmetic, 2 is off-macOS only, and 7 is the context
  tree.
- [Selection hygiene](../backlog/2026-09-22-scriptorium-selection-hygiene-duplication-and-cost.md):
  the duplicated edge-detect, and a full re-walk on every `selectionchange`.
- [A coalesced scroll is lost](../backlog/2026-09-22-scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md):
  the two pinned sub-frame holes.
- [Eager or lazy versioning](../backlog/2026-09-22-scriptorium-eager-or-lazy-versioning.md):
  waiting on Cole's use.
- [Anthill's seat filter drops the handoff line](../backlog/2026-09-23-anthill-seat-tail-filter-drops-the-handoff-line.md):
  the change is anthill's. Until it lands, a seat's bounty watch dies silently
  at the cap. Filed as
  [ichabodcole/anthill#113](https://github.com/ichabodcole/anthill/issues/113).
- [House-style rules from this cycle](../backlog/2026-09-24-house-style-rules-from-scriptorium-real-use.md):
  Cole's to rule. _(Note added 2026-09-24: approved and integrated into
  `grimoire/house-style.md`.)_

The residuals the sessions recorded under "Known and not built" are filed as two
items:

- [The tail's re-arm command names a versioned plugin path](../backlog/2026-09-24-tail-rearm-command-names-a-versioned-plugin-path.md):
  across an upgrade, a printed command first runs stale code, then fails once
  the old directory is deleted. It is its own item because it should be resolved
  before the release that first ships the handoff. _(Note added 2026-09-24,
  after the close: resolved on `fix/tail-rearm-without-plugin-path`. The printed
  command names no path.)_
- [Residuals from this cycle](../backlog/2026-09-24-scriptorium-real-use-residuals.md):
  the no-epoch spells' fallback gap, the keyed late-lead edge, a resize not
  re-placing a pane, triple-click giving no chip, and batched note review.

Waiting on Cole:

- **Whether mind-mapper stays a presence spell.** The tail handoff ruled it one,
  so its window always re-arms Monitor and never takes the zero-wake one-shot.
  He has not ruled. _(Note added 2026-09-24: he ruled it follows the session
  spells. Built on `feat/mind-mapper-quiet-handoff`.)_
- **The house-style proposals** above. _(Note added 2026-09-24, after the close:
  Cole approved all four, and they are integrated into `grimoire/house-style.md`
  on `docs/house-style-from-scriptorium-real-use`.)_
- **From his own use:** eager vs. lazy versioning, the three note trade-offs,
  the resize re-place, which tab's selection wins, and whether he reaches for a
  collapse shortcut.

## Sessions

- fix/scriptorium-selection-context (landed 2026-09-22)

- feat/scriptorium-keep-your-place (landed 2026-09-22)

- feat/scriptorium-collapsible-sidebars (landed 2026-09-22)

- feat/scriptorium-note-in-progress (landed 2026-09-22)

- fix/scriptorium-chip-across-documents (landed 2026-09-22)

- spike/monitor-expiry (landed 2026-09-23)

- feat/tail-quiet-handoff (landed 2026-09-23)

- fix/tail-rearm-without-plugin-path (landed 2026-09-24, after the close)

- feat/mind-mapper-quiet-handoff (landed 2026-09-24, after the close)
