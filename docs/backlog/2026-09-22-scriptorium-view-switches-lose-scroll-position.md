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
lifecycle: done
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
views can name, and one `Place` per open document holds it. A pane `join`s the
place — which puts it where the place already is and makes it follow — and
`report`s the line at its top. The guard lives in the store rather than in the
panes, so the feedback loop cannot be reintroduced by forgetting to suppress a
handler, and it is an EVENT rather than a duration: a programmatic scroll
produces exactly one scroll event, so the first report after a drive is that
drive. (It was a 150 ms window first; see the defects below.) The raw pane needs
no mapping — CodeMirror's `posAtCoords` / `scrollIntoView` are exact. The
rendered pane is described by ANCHORS (the source line each rendered block
begins on and where it sits in the scroller, built by
`renderedRange.lineAnchors` over E51's projection), with linear interpolation
between them; `topForLine` and `lineAtTop` are inverses, so a round trip does
not drift. That is the definition of "close": the error is bounded by the block,
not by the pixel.

**Measured** on `grimoire/house-style.md` (668 lines) in Chromium, with an
oracle that reads both panes out of the DOM and locates the text in the file:
when a block begins at the top edge — the case a human aims at — the other
pane's top line is that block's own line **exactly, at 25 of the 27 `h2`–`h4`
headings the probe queried** (it did not query the `h1` title). Of **42
arbitrary positions**, 37 were measurable — one was the bottom clamp, and at
four the oracle could not find enough text at the top edge to locate it in the
file — and all 37 are **within three source lines**: exact at 20, within one at
32, within two at 34. That oracle reads late by up to two rendered lines, so it
is an upper bound.

These are kept because they are what a later change gets compared against: they
are the evidence behind Cole's "close is the bar", and a sync that degrades
shows up as this sweep moving. That is also why each carries its population — a
figure without one cannot be compared to anything. At the very bottom the
follower is at its maximum scroll and cannot put the leader's line at the top at
all: the residue is the distance from the last anchor to the last line (six
lines here), a structural floor of scrolling rather than a fault in the mapping.
No drift after settling, wheel or programmatic. Every mode switch —
split→raw→rendered→raw→split — kept the same passage at the top.

⚠ **A first pass claimed "within one source line"** on a 24-position sweep whose
probe flattered it, and an independent verifier could not reproduce it. The
number above is the reproduction, and the claim is now written with its method
and its limit attached. ⛔ **Its second pass then reported details out of 37
under a headline of 42** without saying where the other five went — the
ask-the-tool-for-its-population trap, twice on one branch, which is why the
denominators above are spelled out rather than summarised.

⚠ **The guard this rests on has a known hole**, pinned rather than fixed by
Cole's ruling — a coalesced human scroll can be swallowed in two sub-frame
windows. See
[the coalesced-scroll item](./2026-09-22-scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md).

**Two defects an independent verifier found in the first pass, both fixed
here:**

- **A real scroll inside the settle window was discarded, and nothing reconciled
  it.** Scroll rendered, then scroll raw 60 ms later: the panes ended up **fifty
  lines apart and stayed there**. The cell asserted that a driven pane's report
  is dropped — the mechanism — and nothing asserted the consequence, which is
  where the defect lived.
- **A fast wheel over the rendered pane left the follower up to twelve lines
  behind, frozen**, because two settle windows overlapped and one expired under
  the other.

Both are the same mistake, so both got the same fix: the window is gone. The
invariant is now the one the verifier named — **settled means agreed** — and it
is what the cells assert. Reproduced after the fix: the 60 ms case leaves both
panes on line 71, and eight fast-wheel bursts settle within one line.

Two more found by driving it here, both fixed and commented at the site:

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
