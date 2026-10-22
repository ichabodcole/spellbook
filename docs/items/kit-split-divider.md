---
type: item
title: The split view's divider can't be moved or kept
description:
  The kit's split view is a fixed 50/50 with no divider, where the shipped
  Scriptorium lets the human drag it and keeps its width across sessions.
status: stable
lifecycle: done
id: 01a157b8-b9f8-73ee-af86-5ebf6388782f
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-shell
cycle: 2026-10-cutover
---

# The split view's divider can't be moved or kept

The shipped Scriptorium's split view has a divider the human drags, and its
width is kept in prefs (`SPLIT_LAYOUT_ID`, `src/scriptorium/surface/App.tsx`).
The kit's document pane splits raw and rendered into two fixed halves with no
divider at all. Found by `scriptorium-kit-shell` and the Atlas comparison (D5),
on 2026-10-20.

## Definition of done

- [x] The split view has a divider the human can drag, by pointer and by
      keyboard.
- [x] Its width is kept through the shell's storage slot, so it survives a new
      session.
- [x] Offered on kit-parity. _(Offered on kit-parity, message 47, 2026-10-22.)_

## Done and verified

Commits `feb75ea1`, `05a2b418` and `4862b094` on `impl/kit-split-divider`. The
split in `src/kit/document/DocumentPane.tsx` is a `react-resizable-panels`
group, as the shell's columns are. Its width is kept through `useDefaultLayout`
in the workspace's `storage`, under `doc-split`. On the flagged Scriptorium that
is `prefsStorage`, so the pref is `panes:doc-split:doc-raw:doc-rendered`.

**It matches the shipped split** (`SPLIT_LAYOUT_ID`, shipped
`DocumentPane.tsx`):

- It opens at 50/50, and neither half can be narrower than 25%.
- The keyboard is the library's: the arrows move it 5%, and Home and End take it
  to either minimum.
- Double-click is the library's, as in the shipped app.
- The panel ids are the shipped ones. The layout id is the kit's own
  `doc-split`, so the shipped `scriptorium:doc-split` value is not read (ruling
  5: pane sizes reset once).

**Deliberate choices:**

- **The group is drawn in raw and rendered too, one panel wide.** If it were
  drawn only in split, the editor would sit under a different parent and remount
  on every switch. The shipped app does that today: its split is a separate
  tree.
- **Only a two-panel layout is kept** (`isSplitLayout`). The hook keys each
  layout by its own panels, so a one-panel layout would not overwrite the width.
  It would still add one more pref write on every switch, which nothing reads.
- **The handle draws the line between the halves,** so the rendered half's
  `border-l` is gone. The shipped app drew both.

**Verified:**

- Unit tests in `DocumentPane.test.tsx` and `pane.test.ts`. Eight planted
  regressions each turned a test red, and the code was restored byte for byte
  each time.
  - The first five: saving every layout ungated, a remounting raw key, no
    `defaultLayout`, no handle, and `isSplitLayout` using `some`.
  - Three more, after a verifier found them surviving: no `onLayoutChanged` (the
    width never saved), `SPLIT_MIN_SIZE` 10 and `SPLIT_DEFAULT_SIZE` 60.
  - Those three are caught by a test that moves the divider by keyboard in
    happy-dom and asserts the store holds 55/45. To make the keyboard work
    there, the test lays the row out (`offsetLeft`, rects and `ariaDisabled`).
    The test also asserts the first 50/50 and the divider's 25 to 75 bounds.
  - `SPLIT_DEFAULT_SIZE` gave both halves the same default, so any value drew
    50/50. It is now the raw half's share, and the rendered half takes the rest
    (`05a2b418`).
- A Playwright drive on the flagged path (`SCRIPTORIUM_KIT=1`, scratch homes,
  `NODE_ENV=test`):
  - Mouse drag: 50% to 36.6%.
  - ArrowRight: +5%. Home went to 25% and End to 75%.
  - The editor element was the same object across raw, split, raw and split
    again, and an undo after the switches removed text typed before them.
  - Prefs held only the two-panel key.
  - After `close` and a new `open` (a new session, not a restore), the split
    came back at 35%.

**Not done:** the kit-parity offer. That is the lead's message at cycle close.
The Port-back notes below are what it carries.

## Port-back notes

For Story Studio's agent to weigh:

- **The split is now a resizable group** (`DocumentPane.tsx`). It is the
  `ResizablePanelGroup`, `ResizablePanel` and `ResizableHandle` from
  `ui/resizable.tsx`, which the kit already has.
  - The panel ids are `doc-raw` and `doc-rendered`. They become DOM ids, as the
    library sets them.
  - The halves open at 50/50, with a 25% minimum each.
  - The handle's `aria-label` is "Resize raw and rendered".
- **The width is kept in the workspace's `storage`**
  (`w.storage ?? safeStorage`, where the view mode already lives). Its key is
  `react-resizable-panels:doc-split:doc-raw:doc-rendered`.
  - Without an app store, that is the browser's localStorage with no
    `storageKey` prefix, as the view mode's key already is.
  - Studio's own store, if it passes one, gets the bare key.
- **The group is always drawn, even in raw and rendered** (one panel). Raw and
  rendered keep their raw and rendered keyed cells inside it, so the editor
  survives a switch to and from split. The `data-slot="split-view"` marker is
  still there only in split.
  - The rendered half's image drop handlers moved onto an inner `div` in the
    panel.
- **New in `pane.ts`:** `SPLIT_LAYOUT_ID`, `SPLIT_PANES`, `SPLIT_DEFAULT_SIZE`
  (the raw half's share; the rendered half takes the rest), `SPLIT_MIN_SIZE`,
  and `isSplitLayout`, which keeps a one-panel layout from being written.
- **The tests' `panelsLaidOut` gives happy-dom a layout.** It sets the panels'
  and divider's `offsetWidth`, `offsetLeft` and rects, plus `ariaDisabled`.
  Without them the library sorts the divider before the panels, or reads it as
  disabled, and its keyboard does nothing. Studio's tests may want the same
  helper.
- **A thin `ResizeObserver` stub breaks this group.** The library reads each
  entry's `target` and `borderBoxSize`, so a test stub without them throws.
  `paneWidth` in `DocumentPane.test.tsx` now gives both.
- **The shell's group double-click** (`WorkspaceShell.tsx`,
  `onGroupDoubleClick`) also sees this nested handle. It ignores it, because the
  handle has no `data-handle-for`. Nothing in the shell changed.
