---
type: backlog
title:
  "Backlog — Scriptorium: selection edges the reviews found and the fixes left
  alone"
description:
  A stale chip when a rendered selection cannot be placed, ctrl+click read as a
  right-click off macOS, a chip that outlives an Escape-dismissed note menu, a
  Notes-panel note that does not consume the selection, (fixed, E66) a chip that
  survived a document switch under the new document's name, a second tab wiping
  the daemon's selection, a highlight lost to the version menu, and a tree row
  that does not follow a link
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

## 0. ✅ The chip survived a document switch, and named the wrong document (fixed, E66)

Reproduced with real mouse input by the reviewer of record of
`feat/scriptorium-note-in-progress` (2026-09-22). `develop`'s `dist/` behaves
the same, so it predates that branch. **This is the most serious edge here,
because it sends the agent wrong context.** It also breaks this cycle's
appetite: "the context chip always matches the selection".

**Repro:**

1. In rendered view, drag-select a passage in `alpha.md`.
2. Click `beta.md` in the context list.
3. The chip reads `beta.md · v1 · line 5 / "<alpha's text>"`.
4. The daemon's `/state` selection holds
   `{doc: "beta", path: …/beta.md, fromLine: 5, text: <alpha's text>}`.

A `say` now would send the agent alpha's text attributed to beta, at a line
number that means nothing there. The held selection outlives the switch and is
re-labelled with the new document instead of being dropped.

**✅ Fixed on `fix/scriptorium-chip-across-documents` (E66).** Switching the
document text on screen (another document, or another version of this one)
clears the held selection in the surface and in the daemon, the same clear as
the chip's X. It is dropped, never re-labelled, and going back does not revive
it. The rule is `selectionOnScreen` in `backend/selection.ts`, shared by both
halves. The surface's selection now carries the `doc` and `version` it was made
in, and the daemon applies the rule on every read and refuses a `select` for
text that is not on screen. Driven with real mouse input across every path that
moves the open document. The list is in E66.

None of edges 1–4 fell to the same act. Each is about a selection within one
document.

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

## 5. A second tab on the same session wipes the daemon's selection

Found by the no-stake verifier of `fix/scriptorium-chip-across-documents`
(2026-09-22). It predates that branch.

**Repro:**

1. In tab 1, select a passage. The chip and `/state` both hold it.
2. Open the same session's URL in a second tab.
3. Tab 2 mounts with no selection and sends `select: null`.
4. `/state` now holds no selection, while tab 1's chip still shows the passage.
   A `say` from tab 1 sends no passage, although its chip shows one.

The daemon holds one selection per session, and every viewer writes to it. Which
viewer's selection wins is a question for real use with two tabs open.

## 6. After the version menu, the chip keeps its text with nothing highlighted

Found by the same verifier. It predates the branch.

**Repro:**

1. Select a passage in rendered view.
2. Open the version menu and choose the version that is already active.
3. The chip and `/state` still hold the passage, but the document shows no
   highlight (`getSelection()` reads empty). The press was outside the pane, so
   the pane does not count the emptied selection as its own. Closing the menu
   with Escape keeps the highlight; choosing another version clears both, as E66
   says.

The same shape as edge 3: a press outside the pane empties the paint and nothing
reports it.

## 7. After following a link, the context tree still highlights the previous document

Found by the same verifier. It predates the branch, and it is not a selection
edge but lives here because the same drive found it.

**Repro:**

1. Open a document with a link to another document in the same set.
2. In rendered view, click the link.
3. The linked document opens, and the chip and `/state` are right, but the
   context tree's highlighted row is still the document you came from.

## References

- `src/scriptorium/surface/state/selection.ts` (`renderedSelectionAct`)
- `src/scriptorium/surface/components/MarkdownView.tsx`
- Session:
  [the chip and the lines it pointed at](../projects/scriptorium/sessions/2026-09-22-the-chip-and-the-lines-it-pointed-at.md)
