---
type: backlog
title:
  "Backlog — Scriptorium: three selection edges the review found and the fix
  left alone"
description:
  A stale chip when a rendered selection cannot be placed, ctrl+click read as a
  right-click off macOS, and a chip that outlives an Escape-dismissed note menu
tags: [scriptorium, selection, edge-cases]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: three selection edges the review found and the fix left alone

Raised by the independent review of `fix/scriptorium-selection-context`
(2026-09-22) and deliberately left out of that branch. None reproduces the
defect the branch fixed; each is the same _shape_ — the chip saying something
the document does not.

## 1. An unplaceable selection keeps the previous passage on the chip

`renderedSelectionAct` returns `"ignore"` when a rendered selection is ours, not
collapsed, and cannot be resolved to source. The chip then keeps the
**previous** passage while a **different** one is visibly highlighted — which is
the failure the branch exists to end, at a smaller scale.

Not hypothetical: the reviewer's sweep of all 523 tracked markdown files found
**0.33% of runs still unplaced** (183,375 runs), concentrated in fenced code
blocks, and `resolveRange` returns null for a selection wholly inside one.

`"clear"` is the honest act here — the chip cannot describe this selection, so
it should hold nothing. ⚠ Check first what `"clear"` costs on a _transient_
unplaceable state mid-drag; if it flickers, the answer may be a third act rather
than reusing `clear`.

## 2. `ctrl+click` is read as a context press off macOS

`MarkdownView.tsx` treats `e.button === 0 && e.ctrlKey` as a context press,
which is right on macOS and wrong everywhere else: on Windows and Linux a plain
ctrl+click would wrongly preserve the selection through a collapse. Low reach
today (the surface runs in the human's own browser, and Cole is on macOS), so
this is a correctness note rather than a live defect.

## 3. An Escape-dismissed note menu leaves a chip with no highlight

Right-click over a selection is kept on purpose, so the note menu has a passage
to act on. Escape fires `keydown`, which spends the context press, but no
`selectionchange` follows — so the chip sits on a passage the browser has
already erased until the next selection event. Cosmetic residual of a deliberate
trade.

## References

- `src/scriptorium/surface/state/selection.ts` (`renderedSelectionAct`)
- `src/scriptorium/surface/components/MarkdownView.tsx`
- Session:
  [the chip and the lines it pointed at](../projects/scriptorium/sessions/2026-09-22-the-chip-and-the-lines-it-pointed-at.md)
