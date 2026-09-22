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

- [ ] raw ↔ rendered keeps the top-visible section (or the selection) in view
- [ ] split: scrolling either pane keeps the other roughly aligned, without a
      feedback loop between the two scroll handlers
- [ ] compare mode is explicitly in or out of scope, decided rather than
      forgotten

## References

- `src/scriptorium/surface/components/DocumentPane.tsx:36` (`VIEW_MODES`)
- `src/scriptorium/surface/state/renderedRange.ts`
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
