---
type: backlog
title:
  "Backlog — Scriptorium: the chat's context chip stops mirroring the selection"
description:
  Two ways the attached context diverges from the selection — dismissing it
  sticks for new selections, and a click-to-deselect in rendered mode leaves it
tags: [scriptorium, selection, chat, bug]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: the chat's context chip stops mirroring the selection

The rule Cole states (Operator doc, 2026-09-20, §2): **the context chip should
mirror what is actually selected.** Two ways it does not.

## A. Dismissing the chip sticks — raw and rendered

1. Select text; the chip shows it. Send a message (selection still live).
2. Click the chip's **X** ("Send without this selection").
3. Select a _new_ passage, in either mode.
4. **No chip appears**, and nothing rides along with the next message.

**Probable cause (read, not yet run):** `ChatComposer.tsx:44–48` holds `dropped`
as component state and resets it **only in `submit`**. Its own comment says a
drop is "per-message: the next one starts attached again" — but a new
_selection_ is not a new message, so the refusal outlives the passage it was
about. Likely fix: reset `dropped` when `attachable`'s range changes, and cover
it with a cell.

## B. Clicking to deselect leaves the chip — rendered only (Cole's reading)

1. Select text in rendered mode; the chip shows it.
2. Click elsewhere in the rendered text. The highlight goes; **the chip stays**
   and will still be sent.

Cole believes raw mode gets this right. `MarkdownView.tsx:116–128` keeps a
remembered "last selection this pane resolved" (so the context menu survives a
click that collapses the DOM selection), and the `selectionchange` handler at
`:141` may not report a _collapse_ as a clear. Check both before choosing.

## Found (2026-09-22, branch `fix/scriptorium-selection-context`)

Both reproduced in a real browser, and a third: after the X, re-selecting the
**same** passage reported nothing, because the rendered pane deduped against its
own memory of the last range it resolved — memory the clear never reached. That
is Cole's "rendered selection stops working until you switch to raw and back":
switching modes remounts the pane and wipes the memory.

- **A** was `ChatComposer`'s `dropped` flag, as read. The fix is not to reset
  it: the X now **clears the held selection itself**, so the daemon is told
  (`select`, `selection: null`) and the chip has no second state to drift from.
  Confirmed with `scriptorium state` after an X: `"selection": null`.
- **B** was the rendered pane never speaking on a collapse (the raw view clears
  because CodeMirror reports the empty range). It now reports a collapse as a
  clear — **except** a right-click over the selection, which is the note menu
  collapsing the passage it is about to act on. A right-click elsewhere is an
  ordinary click and clears. The note card still opens over a selection and
  still does not open where there is neither selection nor note.

The rules are now `surface/state/selection.ts` (`heldAfter`,
`renderedSelectionAct`) with cells, rather than three components each holding
their own idea of what is selected.

Commit: `645a52c2`.

**Second pass.** Cole ruled on the residual: "if you clear the context from the
chat, that to me should basically be treated as clearing the selection." A drop
(the X, or a note consuming the passage) now collapses the pane's own selection
too — the browser's in the rendered half, CodeMirror's in the raw one, where it
takes both the model and the browser's, since CodeMirror only syncs the DOM
selection while focused and the X is a button outside the editor (`dff26fda`).
And the context-press flag that excuses the note menu's collapse was only
recomputed on a pointer press, so after one right-click a keyboard collapse left
the chip behind; a key now ends it (`contextPressAfter`, `ee8b97be`).

**Third pass.** A reviewer found the inverse: in split view a click in the
rendered half cleared the chip but left CodeMirror holding its range and
painting it. Cole ruled — "clicking in either clears the selection, it's the
simpler ux pattern" — so a clear reaches both panes' paint however it arrives,
not only on a drop (`applySelectionEvent`, `0f0a75c5`). The X's label, which
still read "Send without this selection" from the old per-message semantics, now
says it clears the selection (`11bc993f`), so the repro step above names a
button that no longer goes by that name.

## Acceptance Criteria

- [x] A: after dismissing, a new selection re-attaches, in both modes
- [x] B: a click that collapses the selection clears the chip in rendered mode,
      and the context menu still works over a remembered selection
- [x] The daemon's held selection (`App.tsx:257`) is cleared too — `say`
      attaches what the **daemon** holds, so a surface-only fix would still send
      the stale passage

## References

- `src/scriptorium/surface/components/ChatComposer.tsx:44`
- `src/scriptorium/surface/components/MarkdownView.tsx:116`, `:141`
- `src/scriptorium/surface/App.tsx:257`
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
