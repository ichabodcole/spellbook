---
type: backlog
title:
  "Backlog — Scriptorium: the duplicated edge-detect, and a full re-walk on
  every selectionchange"
description:
  Both panes hand-roll the same clearSeq edge-detect idiom, and align() re-walks
  every text node and re-runs alignRuns on every selectionchange
tags: [scriptorium, selection, duplication, performance]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: the duplicated edge-detect, and a full re-walk on every selectionchange

Both raised by the independent review of `fix/scriptorium-selection-context`
(2026-09-22); neither is a defect today.

## 1. Two copies of the same edge-detect

`MarkdownView` and `DocumentView` each hand-roll
`const cleared = useRef(clearSeq)` / compare / assign to notice that the held
selection was cleared. Duplicated edge-detection is the shape that drifts — one
pane gets a fix the other does not, and nothing fails. A two-line
`useEdge(seq, fn)` beside the rules in `state/selection.ts` would make it one
fact.

⚠ Worth doing **only** when something else brings you into both files; a
refactor whose whole value is symmetry can wait for a reason.

## 2. `align()` re-walks the document on every `selectionchange`

`align()` walks every rendered text node and re-runs `alignRuns` over the whole
projection each time the selection changes — and `selectionchange` fires
continuously during a drag. The branch added a `runs.map(r => r.trim())`
allocation per pass on top.

**Pre-existing, and no measurement says it hurts.** House-style (668 lines, 987
runs) drives fine. This is a line to hold the fact, not a call to optimise: if a
long document ever feels sticky while dragging a selection, this is where to
look first. Measure before changing anything.

## References

- `src/scriptorium/surface/state/renderedRange.ts` (`align`)
- `src/scriptorium/surface/components/MarkdownView.tsx`,
  `src/scriptorium/surface/components/DocumentView.tsx`
- Session:
  [the chip and the lines it pointed at](../projects/scriptorium/sessions/2026-09-22-the-chip-and-the-lines-it-pointed-at.md)
