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

## Acceptance Criteria

- [ ] A: after dismissing, a new selection re-attaches, in both modes
- [ ] B: a click that collapses the selection clears the chip in rendered mode,
      and the context menu still works over a remembered selection
- [ ] The daemon's held selection (`App.tsx:257`) is cleared too — `say`
      attaches what the **daemon** holds, so a surface-only fix would still send
      the stale passage

## References

- `src/scriptorium/surface/components/ChatComposer.tsx:44`
- `src/scriptorium/surface/components/MarkdownView.tsx:116`, `:141`
- `src/scriptorium/surface/App.tsx:257`
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
