---
type: item
title: "Toggle line numbers in the raw editor"
description:
  A viewer toggle for a line-number gutter in the kit document pane's raw
  editor, remembered like the view mode, so the human can check a line reference
  by eye.
tags: [scriptorium, editor, ux]
status: stable
lifecycle: active
id: 01a0d4b7-de98-724e-8498-d806a64b6369
kind: task
generated: { by: claude-opus-5.5, at: 2026-09-24 }
cycle: 2026-10-document-pane
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
      the chip and notes name. _(The kit pane offers it with `lineNumbers`; the
      flagged frame does not mount the kit pane yet, so it still has to pass
      that prop.)_
- [x] Toggling keeps the editor's scroll, selection and undo history, and a test
      pins that.
- [x] The choice survives a reload.
- [ ] In reader mode the gutter fades with the rest of the chrome, and stays
      visible. _(Left unticked. In the kit, reader mode is always the rendered
      view, so the gutter can never be on screen there today. The fade is built
      (40%, never hidden) and waits for reader mode to cover raw. Cole rules
      whether it ever should.)_
- [x] In split view only the raw half shows the gutter. The rendered half is
      unchanged.
- [ ] The change is offered on kit-parity.

## Done and verified

Built on `impl/scriptorium-toggle-line-numbers-in-raw-mode` from
`cycle/document-pane` at `bcc3fd89`, in `992813f0` (the editor: compartments for
the gutter and its fade), `35bd21d4` (the pane's toggle and its remembered
choice) and `9a7b6fae` (a fixup for `992813f0`). The work is new to the kit, so
there is no Story Studio sha to port from. Its `develop` (`b6d5956`) has no
line-number toggle, only JSON's gutter, which is always on.

- `DocumentView` takes `lineNumbers` and `quiet`, and holds each in a CodeMirror
  compartment. A change reconfigures the editor in place, so the editor is the
  same one and keeps its scroll, selection and undo history.
- `DocumentPane` takes `lineNumbers` (offer the toggle, off by default) and
  `lineNumbersKey` (default `spellbook:line-numbers`, beside `viewModeKey`).
- The toggle is shown in raw and split only. It is not shown in rendered, for
  JSON (always numbered), or over an app's own view.
- **Reader mode.** In the kit, reader mode is always the rendered view
  (`reader.ts`: rendered with both columns shut), so the gutter can never be on
  screen there today. The fade is built and waits for reader mode to cover raw:
  the pane passes `quiet={reader}`, and the editor fades the gutter to
  `QUIET_FADE`'s 40%, never hidden, full again under the pointer. Cole rules
  whether reader mode should ever cover raw.
- **Focus.** A pointer press on the toggle is `preventDefault`ed on mousedown,
  so focus and the caret stay in the editor and the next key types there. The
  keyboard still reaches it by Tab and works it with Enter or Space.
- Checked in a real browser (Chromium via Playwright) on a temporary page that
  mounted the kit pane on the fixture daemon, never the frame. The page was
  removed afterwards. The checks were:
  - typing, selecting and scrolling, then clicking the toggle, kept the same
    editor element, the scroll (1528 px), the selection, and a Mod-Z undo;
  - the number beside an edited line matched its source line (87);
  - the choice survived a reload;
  - in split, only the raw half had a gutter;
  - with the quiet class on, the gutter's computed opacity was 0.4 and its
    display stayed flex;
  - after clicking the toggle with the caret in a line, focus stayed in the
    editor and the next key landed there; focused by keyboard, Enter toggled it.

## Port-back notes

- `jsonMode.ts`: the gutter and its theme moved into an exported
  `numberedLines()`, which `jsonHighlighting()` now uses. JSON looks the same.
- `DocumentView.tsx`:
  - new props `lineNumbers` and `quiet`, two compartments, and two effects that
    reconfigure them;
  - an exported `QUIET_GUTTER_CLASS` (`cm-quiet`), and two theme rules that fade
    the gutter.
  - CodeMirror holds the gutter once, so turning numbers on for JSON adds no
    second gutter, and turning them off leaves JSON's gutter.
- `DocumentPane.tsx`:
  - new props `lineNumbers` and `lineNumbersKey`, an exported
    `LINE_NUMBERS_LABEL`, and the header toggle
    (`data-slot="line-numbers-toggle"`, between the view modes and the reader
    toggle), whose mousedown is prevented so a pointer press keeps focus in the
    editor;
  - it passes `lineNumbers` and `quiet={reader}` to `DocumentView`.
- `pane.ts`: `DEFAULT_LINE_NUMBERS_KEY`, `readLineNumbers` and
  `storedLineNumbers`. Story Studio would rename the key to its own prefix.
- **Opt-in by a prop, not on by default.** Story Studio's pane gains nothing it
  did not ask for: no new button, and no gutter. This is the same precedent as
  `splitView`. An app that offers it still starts with the gutter off, until the
  human turns it on.

## References

- `src/kit/document/DocumentView.tsx` (the kit's raw editor, once ported)
- The shipped equivalent, for comparison:
  `src/scriptorium/surface/components/DocumentView.tsx` and `App.tsx`
  (`VIEW_PREF`).
