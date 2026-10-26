---
type: item
title: The location dialog offers the native folder picker
description:
  When a new document or folder asks where it goes, the human can pick a folder
  in the tree or type a path, but not browse with the OS's own folder dialog,
  which the daemon can already open.
status: stable
lifecycle: done
id: 01a16581-e023-765d-9eec-11f717383451
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
---

# The location dialog offers the native folder picker

Cole, in his cutover trial (2026-10-22): when adding a new document or folder,
the dialog that asks where it goes lets him choose an item in the tree or type a
path. He wants a button that opens the native file navigator too, for when he
isn't sure exactly where something lives and would rather browse.

The daemon already has a native picker (`src/kit/workspace/picker.ts`, the
"Choose..." act: AppleScript on macOS, zenity elsewhere, one dialog at a time),
which returns a real path. The location dialog
(`src/kit/context/AskLocation.tsx`) doesn't offer it yet.

## Definition of done

- [x] The location dialog has a button that opens the native folder picker, and
      the folder chosen fills in the location; cancelling changes nothing.
- [x] Typing a path and choosing from the tree still work.
- [x] Tested, and checked in a real browser on macOS; offered on kit-parity.
      (Tested and browser-checked; the kit-parity offer is the lead's.) Offered
      on kit-parity, message 48 (2026-10-23).

## Done and verified

Commit `050d1720`. "Where should it go?" has a "Choose a folder…" button that
opens the OS's folder dialog through the daemon (`pick` with the new want
`choose-folder`, which answers the asker with the path and adds nothing). The
daemon names the path the way the context names it, so a symlinked or realpath
form of a shown place matches it. Deliberate choices:

- "Fills in the location" means the chosen folder is highlighted in the list,
  with the focus back in the search, so Enter or a click puts the new thing
  there. The path box is "New folder at a path", which makes a folder, so an
  existing folder does not go there.
- A folder outside every set cannot take a new document, so the dialog names it
  ("~/x is not in a set yet") with the act that answers it, "Add it as a set".
  It is highlighted once the context shows it.
- The state carries `picker`: false on Windows and on a Linux without zenity,
  where the button is hidden.

Tests: `AskLocation.test.tsx` ("the OS's own folder dialog"), and
`server.test.ts` (the folder pick, `state.picker`). Each was shown red with a
planted regression. The browser check ran a real Scriptorium daemon and Chromium
on scratch homes. Only the OS dialog was stubbed, through the daemon's `pick`
seam.

## Port-back notes

- `protocol.ts`: `PickWant`/`PickAnswerWant`; `pick` takes
  `want: "choose-folder"` (and `"choose-file"`, see kit-drop-keep-where-it-is).
  **Named so as not to clash:** Story Studio's `pick` already has
  `want: "folder"`, meaning "open the chosen folder as the project" (its
  `openFolder`). Both answer with their own frame,
  `{ op: "chosen"; paths; cancelled? }`, **not** Story Studio's `picked`. Story
  Studio's `WorkspaceShell` brings the paths of every `picked` frame into the
  context, and the daemon client hands a request's reply to the frame listeners
  too, so a `picked` answer would add what was only asked for. `chosen` answers
  a dismissed dialog too (`paths: []`, `cancelled: true`), because the page
  waits on it as a request. Any other `want` (`folder`, `file`, anything
  unknown) is refused before a dialog opens; the refusal names the four it takes
  (`PICK_WANTS`). `PublicState.picker?: boolean`.
- `context.add` now answers its asker with `{ op: "context.added"; ids }`, so a
  page can wait on it as a request; a refusal is the usual `error`. A `path`
  that is not text is refused in words.
- `server.ts`: `openPicker` answers those wants without adding; `hasPicker`
  computed once, beside the zenity lookup (moved up from the picker section).
- `session.ts`: `namedAsContext(path)`, a public wrapper on `contextForm`.
- `daemonClient.ts`: `pickPaths(request, want)` with a one-hour wait
  (`PICK_WAIT_MS`).
- `AskLocation.tsx`: `LocationDialog`/`useAskLocation` take optional `pick` and
  `addPlace` (a promise: its refusal shows in the dialog, as `addFolder`'s
  does). A dismissed folder dialog gives the focus back to the search. Story
  Studio has a workspace and does not render this dialog, so it changes nothing
  there until it does.
