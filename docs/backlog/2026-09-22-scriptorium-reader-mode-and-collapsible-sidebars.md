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

## Open design points

- Is reader mode just "rendered + both sidebars collapsed + quieter chrome", or
  its own mode in `VIEW_MODES`? Building (2) first may answer this.
- ⚠ Conversation-primary: collapsing the chat column must not remove the human's
  way to talk to the agent. Decide what stays reachable (a floating composer, a
  keyboard shortcut to reopen) before hiding it.
- Persist the collapsed state in the home's prefs like the pane sizes.

## References

- `src/scriptorium/surface/App.tsx:1` (three `resizable` panes, E11)
- `src/scriptorium/surface/components/DocumentPane.tsx:47` (`SPLIT_MIN_PX`)
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
