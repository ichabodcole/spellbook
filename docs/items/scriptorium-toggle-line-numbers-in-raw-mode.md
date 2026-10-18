---
type: item
title: "Toggle line numbers in the raw editor"
description:
  A viewer toggle for a line-number gutter in the kit document pane's raw
  editor, remembered like the view mode, so the human can check a line reference
  by eye.
tags: [scriptorium, editor, ux]
status: stable
lifecycle: backlog
id: 01a0d4b7-de98-724e-8498-d806a64b6369
kind: task
generated: { by: claude-opus-5.5, at: 2026-09-24 }
---

# Toggle line numbers in the raw editor

## Asked

Cole, in the app, 2026-09-24, while testing the cycle's features on a copy of
`house-style.md`: "add the ability to toggle line numbers in edit mode."

## Why it fits

The chip, notes and the agent all speak in source lines ("lines 435–436"), and
the raw pane shows none. A gutter lets the human check a line reference by eye
instead of counting or asking.

## Shape

Re-aimed on 2026-10-18 at the kit's document pane: Cole took it into the
document-pane cycle, so it is built once in the kit, not in the shipped surface.

- A toggle in the document heading, shown in raw and split only. The rendered
  view has no source lines to number.
- On or off is a viewer preference, remembered as the kit remembers the view
  mode (`viewModeKey`), so it survives a reload.
- The raw editor is CodeMirror (`src/kit/document/DocumentView.tsx` once
  ported), and its `lineNumbers()` extension draws the gutter. It is toggled
  through a compartment, so the editor is not rebuilt and keeps its scroll,
  selection and undo history. The `rawExtensions` slot is read only when the
  editor is built, so it cannot carry the toggle.
- It is a kit change, offered back on kit-parity.

## Open points

- ~~Whether the gutter follows reader mode's "quieter chrome" (E64), and hides
  or fades there.~~ **Ruled (Cole, 2026-10-18):** it fades in reader mode but
  never hides. The human turned the numbers on, and that choice is respected.
- ~~Whether split's rendered half needs anything so the two halves still line up
  at a glance.~~ **Ruled (Cole, 2026-10-18):** no. Only the raw half has line
  numbers, and the rendered half is unchanged.

## Definition of done

- [ ] With `SCRIPTORIUM_KIT=1`, the raw and split views offer a line-number
      toggle. Turning it on shows a gutter whose numbers match the source lines
      the chip and notes name.
- [ ] Toggling keeps the editor's scroll, selection and undo history, and a test
      pins that.
- [ ] The choice survives a reload.
- [ ] In reader mode the gutter fades with the rest of the chrome, and stays
      visible.
- [ ] In split view only the raw half shows the gutter. The rendered half is
      unchanged.
- [ ] The change is offered on kit-parity.

## References

- `src/kit/document/DocumentView.tsx` (the kit's raw editor, once ported)
- The shipped equivalent, for comparison:
  `src/scriptorium/surface/components/DocumentView.tsx` and `App.tsx`
  (`VIEW_PREF`).
