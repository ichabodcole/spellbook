---
type: backlog
title: "Backlog — Scriptorium: toggle line numbers in raw mode"
description:
  A viewer toggle for a line-number gutter in the raw (edit) pane, remembered in
  the home's prefs like the view mode
tags: [scriptorium, editor, ux]
status: draft
lifecycle: open
generated: { by: claude-opus-5.5, at: 2026-09-24 }
---

# Scriptorium: toggle line numbers in raw mode

## Asked

Cole, in the app, 2026-09-24, while testing the cycle's features on a copy of
`house-style.md`: "add the ability to toggle line numbers in edit mode."

## Why it fits

The chip, notes and the agent all speak in source lines ("lines 435–436"), and
the raw pane shows none. A gutter lets the human check a line reference by eye
instead of counting or asking.

## Shape

- A toggle in the document heading, raw and split only. The rendered view has no
  source lines to number.
- Off or on is a viewer preference, kept in the home's prefs like `doc:view`
  (`src/scriptorium/surface/App.tsx`, `VIEW_PREF`), so it survives a reload.
- The raw pane is CodeMirror, whose `lineNumbers()` extension provides the
  gutter. Toggle it through a compartment, so the editor is not rebuilt and
  keeps its scroll position, selection and undo history.

## Open points

- Whether the gutter follows reader mode's "quieter chrome" (E64), and hides or
  fades there.
- Whether split's rendered half needs anything so the two halves still line up
  at a glance.

## References

- `src/scriptorium/surface/components/DocumentView.tsx` (the raw editor)
- `src/scriptorium/surface/App.tsx` (`VIEW_PREF`, prefs)
