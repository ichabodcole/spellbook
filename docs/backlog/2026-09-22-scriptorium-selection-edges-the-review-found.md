---
type: backlog
title:
  "Backlog — Scriptorium: selection edges the reviews found and the fixes left
  alone"
description:
  A stale chip when a rendered selection cannot be placed, ctrl+click read as a
  right-click off macOS, a chip that outlives an Escape-dismissed note menu, and
  a Notes-panel note that does not consume the selection
tags: [scriptorium, selection, edge-cases]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: selection edges the reviews found and the fixes left alone

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

## 4. A note added from the Notes panel does not consume the selection

Found by the no-stake verifier of `feat/scriptorium-note-in-progress`
(2026-09-22). It predates that branch. E57 says a note consumes the selection.
The right-click path does this (`onAddNote` in `App.tsx` drops the held
selection), but the Notes panel's own form does not, because its `onAdd` only
sends `note.add`.

**Repro:**

1. Select a passage in the document.
2. Open the Notes tab, write a note in the panel's form, and press Add note.
3. The note is made, but the panel's form still shows the quoted passage.
4. Switch to the conversation. The composer's chip still carries the same
   passage, so the next message silently sends the text the note was about.

Probable fix: have the panel's `onAdd` drop the selection as the right-click
path does, so there is one act and one rule.

## References

- `src/scriptorium/surface/state/selection.ts` (`renderedSelectionAct`)
- `src/scriptorium/surface/components/MarkdownView.tsx`
- Session:
  [the chip and the lines it pointed at](../projects/scriptorium/sessions/2026-09-22-the-chip-and-the-lines-it-pointed-at.md)
