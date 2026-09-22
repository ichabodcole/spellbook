---
type: backlog
title:
  "Backlog — Scriptorium: switching views loses your place, and split panes
  scroll apart"
description:
  Switching raw↔rendered returns to the top of the document, and split view's
  two panes do not scroll together
tags: [scriptorium, view-modes, scroll, ux]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: switching views loses your place, and split panes scroll apart

Cole's working rhythm (Operator doc, 2026-09-20, §3) is to flip often: rendered
to read, raw to select and edit. Both of these break that.

## A. A mode switch returns to the top

Scroll (or select) partway down in rendered mode, switch to raw — the view is at
the top. Same the other way. **Expected:** land on the same section. A
selection, when there is one, is the better anchor than the scroll offset.

## B. Split view's panes do not scroll together

In `split`, scrolling raw should bring rendered to the same place and vice
versa. Exact sync is hard (rendered height ≠ source height); **close is the
bar**, not pixel-perfect.

## Approach note

Both want the same primitive: "which source line is at the top of this pane" and
"scroll this pane to source line N". The rendered side can reuse E51's
source↔rendered mapping (`state/renderedRange.ts`, `state/projection.ts`) rather
than growing a second one. Build the primitive once; A and B are then two
callers.

## Acceptance Criteria

- [x] raw ↔ rendered keeps the top-visible section in view
- [x] split: scrolling either pane keeps the other roughly aligned, without a
      feedback loop between the two scroll handlers
- [x] compare mode is explicitly in or out of scope, decided rather than
      forgotten — **out** (Cole)

## What was built (`feat/scriptorium-keep-your-place`, 2026-09-22)

Cole ruled the anchor is the **top-visible line**, not the selection: one rule,
whether or not anything is selected. Compare is **out of scope** — CodeMirror's
merge view does its own scrolling.

The primitive is `surface/state/place.ts`: a source line is the currency both
views can name, and one `Place` per open document holds it. A pane `report`s the
line at its top and `follow`s another pane's; the drive guard lives in the store
rather than in the panes, so the feedback loop cannot be reintroduced by
forgetting to suppress a handler. The raw pane needs no mapping — CodeMirror's
`posAtCoords` / `scrollIntoView` are exact. The rendered pane is described by
ANCHORS (the source line each rendered block begins on and where it sits in the
scroller, built by `renderedRange.lineAnchors` over E51's projection), with
linear interpolation between them; `topForLine` and `lineAtTop` are inverses, so
a round trip does not drift. That is the definition of "close": the error is
bounded by the block, not by the pixel.

**Measured** on `grimoire/house-style.md` (668 lines) in Chromium: at 24 scroll
positions the followed pane's top line was within **1 line** (median 1, max 1,
and the 1 is the probe counting a partly visible line); raw→rendered was exact
at four positions. No drift after settling, wheel or programmatic. Every mode
switch — split→raw→rendered→raw→split — kept the same passage at the top.

Two defects found by driving it, both now fixed and commented at the site:

- A container's **leading whitespace text node** is placed where the cursor
  already stands, i.e. at the END of the previous block, so a `<blockquote>`
  claimed the line above it and the paragraph that knew the real line was
  dropped as out of order. Cost eight lines on the porting section before it was
  found. `lineAnchors` now ignores whitespace-only runs.
- `scrollIntoView(line 1, y: "start")` scrolls the editor's own top padding
  away, so arriving at the top of the document from the rendered pane looked
  clipped. Line 1 now means `scrollTop = 0`.

**A cost note this answers:** `align()` on `house-style.md` measures **0.2 ms**
(rects 0.2 ms, tree walk 0.02 ms). Its per-`selectionchange` cost, filed as a
possible problem in the selection review, is not one at this size.

## References

- `src/scriptorium/surface/components/DocumentPane.tsx:36` (`VIEW_MODES`)
- `src/scriptorium/surface/state/renderedRange.ts`
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
