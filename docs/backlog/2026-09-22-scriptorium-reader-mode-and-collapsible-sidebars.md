---
type: backlog
title: "Backlog — Scriptorium: reader mode, and sidebars that collapse"
description:
  Two related asks for more room — a minimal-chrome reader mode, and toggles
  that collapse either or both side columns for split and compare views
tags: [scriptorium, layout, reader-mode, ux]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: reader mode, and sidebars that collapse

Cole (Operator doc, 2026-09-20, §4) separates two concepts:

1. **Reader mode** — entered deliberately: rendered markdown, minimal UI.
2. **Collapsible sidebars** — hide the left (context) and/or right
   (chat/notes/tasks) column, individually or both at once, without changing the
   view mode.

(2) matters most where two documents share the centre: **split** (raw +
rendered) and **compare** (a diff against another version). Split already
refuses to show below 720 px (`DocumentPane.tsx:47`) — collapsing the side
columns is also what makes split _available_ on a smaller screen.

## What was built (branch `feat/scriptorium-collapsible-sidebars`, E64)

Both, in one branch — reader mode fell out of the collapse work, so it was not
split off. The rulings and the options not taken are in
[E64](../projects/scriptorium/decision-log.md).

- **Collapse.** `react-resizable-panels`' own collapsible panels: a collapsed
  column is a panel at width 0, so the collapsed state persists in the layout
  pref the pane sizes already used, and there is no second flag. A column's
  reopen width is kept in its own pref (`panes:open`), because the library only
  remembers it in memory. Pure pieces in `surface/state/columns.ts`, with cells.
- **Affordance.** A collapse button in each column's heading; a reopen button at
  the matching end of the document's heading; the resize handles still drag a
  column shut or back out. No keyboard shortcut yet.
- **Floating composer.** With the conversation collapsed, the same composer
  floats at the foot of the document pane, chip and all, with the latest message
  and a way to open the conversation. The draft moved up into `App`, so there is
  one draft wherever the composer is drawn.
- **Split** becomes available when collapsing gives the pane 720 px, and the
  disabled button says to collapse a column when that would make room.
- **Reader mode** is a preset (the glasses button): rendered + both collapsed,
  with the heading and status strip faded back until reached for. It is derived
  from the view mode and the columns, not stored.
- **Keeping your place** — collapsing exposed a hole in E63 (the rendered pane's
  anchors were read at the old width by the scroll anchoring's own event) and it
  is closed; see E64 for what was observed.

## The design points it opened with, answered

- Reader mode's own entry in `VIEW_MODES`, or a preset? **A preset** (Cole), and
  building the collapse first did answer it: it came out as a derived state.
- What stays reachable when the chat collapses? **A floating composer** (Cole).
  No keyboard shortcut; the reopen button is in the document's heading.
- Persist the collapsed state in the home's prefs like the pane sizes? **Yes, in
  the same pref** — a collapsed column is a width in the saved layout.

## References

- `src/scriptorium/surface/App.tsx:1` (three `resizable` panes, E11)
- `src/scriptorium/surface/state/columns.ts` (`SPLIT_MIN_PX`, moved from
  `DocumentPane.tsx` by E64)
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
