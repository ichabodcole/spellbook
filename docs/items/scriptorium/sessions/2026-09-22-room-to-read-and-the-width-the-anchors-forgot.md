---
type: session
title: "Room to read, and the width the anchors forgot — 2026-09-22"
description:
  Either side column collapses, the composer floats while the conversation is
  shut, reader mode fell out as a derived preset, and a collapse exposed a stale
  anchor table that a ResizeObserver could not clear in time
tags: [scriptorium, layout, reader-mode, co-presence, verification]
status: stable
generated: { by: claude-opus-5.5, at: 2026-09-22 }
---

# Room to read, and the width the anchors forgot — 2026-09-22

Part of
[Scriptorium from real use](../../../cycles/2026-09-scriptorium-real-use.md) —
its third branch. The first two are
[the chip and the lines it pointed at](./2026-09-22-the-chip-and-the-lines-it-pointed-at.md)
and
[keeping your place](./2026-09-22-keeping-your-place-and-the-guard-that-guesses.md).

## What this was

Cole wanted more room, above all where two documents share the centre: split
(raw + rendered) and compare. Split refuses to show below 720 px, so on a
smaller screen the side columns were also what kept split unavailable. The ask
is in
`docs/backlog/2026-09-22-scriptorium-reader-mode-and-collapsible-sidebars.md`,
from his Operator write-up of 2026-09-20: either column collapses on its own or
with the other, the view mode does not change, and a minimal-chrome reader mode
comes along if it is cheap.

## Rulings

- **A floating composer while the conversation is collapsed.** Talking to the
  agent must never require reopening the column (conversation-primary). The
  selection chip rides on it as it does in the column.
- **One composer's worth of state.** Branch 1's one-state rule, applied: the
  draft, the chip and the held selection mean one thing wherever the composer is
  drawn.
- **Reader mode is a preset, built only if cheap.** Rendered + both columns
  collapsed + quieter chrome, not a new view mode. It was cheap.
- **The collapsed state persists** in the home's prefs, like the pane sizes.
- **What asks for attention stays loud in reader mode** — ruled in two steps.
  First, after the verifier raised it: Save and "Unsaved" stay at full strength
  while there are unsaved edits. Then, generalised: warnings too ("Changed on
  disk"). Only idle chrome fades.

## What was built

`surface/state/columns.ts` (DOM-free, with cells) holds the rules; `App.tsx`
does the wiring. Everything is in
[E64](../decision-log.md#e64--the-side-columns-get-out-of-the-way).

- **Collapsed is a width, not a flag.** `react-resizable-panels` already had
  collapsible panels, and a collapsed panel is width 0 in the layout pref the
  pane sizes already used. So the collapsed state persisted with no new
  mechanism, and the button, a drag shut and a reload cannot disagree. The
  brief's question — does the library already do this? — was answered yes before
  anything was built.
- **The width a column reopens to** is the one fact the layout cannot hold (the
  library keeps it in memory, so after a reload it reopened at the minimum). It
  got its own pref, `panes:open`.
- **The composer's draft moved up into `App`**, and the composer is drawn in
  exactly one place: the column while it is open, floating at the foot of the
  document while it is shut. Moving it cannot lose or duplicate a draft.
- **Split becomes available when collapsing makes room**, with no further wiring
  — the pane already measured itself. The disabled split button now says to
  collapse the side columns, and only when that would actually make room.
- **Reader mode is derived**: true exactly when the view is rendered and both
  columns are shut. There is no reader flag to fall out of step.

## The interesting part: a width the anchors forgot

Keeping your place (branch 2) caches the rendered pane's block anchors and
clears them from a `ResizeObserver`. A collapse widens the pane in **one**
layout; the browser's scroll anchoring moves `scrollTop` to keep the same text
at the top, and that scroll event is dispatched **before** the observer's
callback runs. So it was reported through anchors measured at the old width, and
the split that the extra width then mounted opened a section early. A drag
reaches the same widths in small steps and never showed it.

Found by driving collapse against branch 2's own acceptance — "must not get
worse" — rather than by any test. The fix keys the cache on the width it was
measured at: a different width is exact evidence the table is stale, with no
timing in it. It is the same shape as branch 2's lesson, one level down — see
[the memory](../../../memories/2026-09-22-an-observer-is-late-for-the-event-that-beats-it.md).

## Review

**Reviewer census** (roster read from the session's available agent types):
**`general-purpose`** (tools `*`) for both the verifier and the reviewer of
record — fresh agents, neither of them the implementer, and execution-capable,
which the census in the two earlier sessions established as the bar.

Three stages, none reviewing its own work:

- **Implementer** — tests first for the pure pieces, and its own browser drives.
- **Verifier** (no stake) — drove the committed build. Confirmed one composer
  state, the chip lines, keep-your-place, split availability and reader mode.
  Found **two real defects**:
  - **The handle's Enter bypassed the reopen width.** The library's own
    `expand()` still ran on it, reopened a column at its 12% minimum after a
    reload, and that minimum was then saved as the reopen width for every later
    reopen. Enter now goes through the same acts as the buttons, and a minimum
    is never remembered.
  - **The new controls clipped out of reach.** The conversation's tabs need
    about 275 px and the column's minimum is 192 px in a 1280 px window
    (measured by the verifier), so its collapse button was invisible at a common
    width. The collapse buttons are now pinned and the document heading wraps
    rather than clips; checked with `elementFromPoint` at 1280, 900 and 600 px,
    with each column and the document in turn at its minimum.

  And three minor ones: reopening one column could push the other shut; a button
  that removed itself dropped focus to `<body>`; the split hint read a hair
  short at the boundary (the browser's 1/64 px layout; now rounded to the
  pixel).

- **Reviewer of record** — net diff. Verdict: _land with fixes_, nothing
  blocking. It checked the capture-phase Enter against the library source
  (arrows, Home and End still resize) and the one-state design. **Its sharpest
  finding was by mutation: several branches in `columns.ts` could be deleted
  with every test still green** — the 99% guard, round versus ceil, the
  half-percent slack at the minimum, the non-object JSON guard. Each now has a
  cell that fails without it, checked by mutating the source. It also found
  **the squeeze**: a capped reopen that the library squeezed was being saved
  over the width the human had chosen; only a human's resize is remembered now.
  The coordinator re-ran two mutations independently before landing — the anchor
  cache's width check and the human-resize guard — and both were convicted.

## Rulings made here that Cole did not cover

All recorded in E64 with the options not taken.

- **The affordance**: a collapse button in each column's heading, a reopen
  button at the matching end of the document's heading, the handles still drag,
  and Enter on a handle toggles the column beside it. No keyboard shortcut — the
  obvious ones collide, and it can come when real use asks.
- **The float sits in the flow**, not over the text, so it never covers the last
  lines and E63's scrollers need no padding.
- **The float carries one line of the conversation** (the latest message, its
  waiting badge, and "Open the conversation"). Without it, the answer to a
  message sent from the float landed where the human could not see it.
- **Leaving reader mode does not restore the view you entered from** — that
  memory would be the second state the preset exists to avoid. A consequence of
  deriving it: collapsing both columns by hand in rendered mode is reader mode.
- **A column dragged to exactly its minimum does not reopen there** — the price
  of never remembering the library's fallback width.

## Known and not built

- **The anchor rule's wiring has only browser evidence.** The cell holds
  `anchorCache`'s rule; that `MarkdownView` reads through it rests on the
  browser run. E64 says how to reproduce it.
- **A resize still does not re-place a pane** (branch 2's deferred item,
  unchanged). Observed across a collapse: rendered keeps its top block (scroll
  anchoring holds it); raw moved by one source line and came back exactly on
  reopen.
- **Triple-click in rendered mode gives no chip.** Pre-existing on `develop`,
  found by the verifier, not this branch's.
- **At the narrowest layouts the document heading wraps to several rows.**
  Reachable, not pretty.

## Verification

`bun run gate` on the final tree, run unpiped: exit 0, tree clean afterwards
(the committed `dist/` reproduces). E64 minted in
`docs/projects/scriptorium/decision-log.md`.

## What to exercise, next time the app is open

1. **Collapse the conversation mid-sentence** and keep typing in the float, then
   reopen it. The draft and the chip should come with you both ways.
2. **Split on your usual screen** — collapse whichever column you can spare and
   see whether split is now there when you want it.
3. **Reader mode with an unsaved edit** — the glasses button; Save and "Unsaved"
   should stay readable while everything else steps back.
4. **Reopen a column you had set wide** after a reload. It should come back at
   your width, not the minimum.
5. **Whether you miss a keyboard shortcut** for collapsing. None was built on
   purpose; if you reach for one, that is the signal.
