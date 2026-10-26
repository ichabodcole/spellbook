---
type: item
title: A dropped file can be added where it already lives
description:
  Dropping a file on the context pane always asks where its copy should go;
  offer to add the original where it lives instead, as a listed document and
  never its folder. A browser drop can't name the file's path, so the human
  picks it in the native file picker.
status: stable
lifecycle: done
id: 01a16627-61ce-7244-baf2-627b2b9340b6
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
cycle: 2026-10-polish
---

# A dropped file can be added where it already lives

Cole, 2026-10-22. He dragged a screenshot from his desktop onto Scriptorium's
context pane. The dialog asked where `<name>.png` should go: one of the current
sets or folders, or a new folder at a path. Most of the time he wants neither.
He wants the file brought in from where it already is, as a set if that's
needed, without choosing a destination.

**The constraint:** a browser drop hands the page the file's bytes and name,
never its path (`src/kit/workspace/picker.ts`, header). So the page can't know
where the dropped file lives, and copying it somewhere is all a plain drop can
do. The daemon's native picker returns a real path (the "Choose..." act).

**The shape (Cole, 2026-10-22):**

- The drop dialog gets one more act: **add the original file**. It opens the
  native **file** picker, where Cole selects the very file he dropped. That file
  is added as a listed document where it lives, with no copy. It is never its
  folder: choosing a file in Downloads adds that one file, not Downloads as a
  set.
- The picker opens wherever the OS opens it by default; no folder is
  preselected. That keeps it the same on every platform.
- The dialog doesn't explain the browser's limit; the act speaks for itself.
- **Copying into a folder that already holds the file:** if the chosen
  destination already has a file of that name, the dialog says so. If it holds
  the same bytes, the dialog offers to add that existing file instead of making
  a second copy, so dropping a file from Downloads and choosing Downloads ends
  with the original added, not `name 2.png`.
- **Platforms:** the native picker works on macOS (AppleScript) and Linux
  (zenity) today. Windows has no picker yet (`picker.ts` returns none). There
  the act is hidden, and the dialog offers the copy only.

## Definition of done

- [x] The drop dialog offers adding the original file, through the native file
      picker. The chosen file is added as a listed document where it lives, with
      no copy and never its folder.
- [x] Copying into a chosen place still works. A destination that already holds
      the same file offers to add that one instead of copying it again, and one
      that holds a different file with that name says so before writing.
- [x] Where the platform has no native picker, the act is hidden.
- [x] Tested, checked in a real browser on macOS; offered on kit-parity. (Tested
      and browser-checked; the kit-parity offer is the lead's.) Offered on
      kit-parity, message 48 (2026-10-23).

## Done and verified

Commit `6f1a1f11`. The drop dialog has "Add the original file…" ("files" for
several). It opens the OS's file dialog with no folder preselected (`pick` with
want `choose-file`), and the files chosen are added by path. The daemon drops
any folder the dialog lets through. A dismissed dialog leaves the ask open.
Before a copy into a chosen set or folder (from the dialog, or from a drop on a
set's row), the page asks the daemon's new `fs.same` whether the name is taken,
comparing size and SHA-256. Deliberate choices:

- Same bytes: "Add the one there" or "Don't copy". Backing out copies nothing,
  so a stray Escape never makes `name 2.png`. Since the destination is a place
  the context shows, the file there is usually listed already. A file a set
  already shows is then selected, not listed a second time; the same rule covers
  a file chosen through the original-file act.
- A different document of that name: "Copy under a new name" or "Don't copy",
  before anything is written. A different image goes on to the import's own
  replace-or-keep-both ask, which already speaks before writing, so it is not
  asked twice.
- A drop with no chosen place (an app with a workspace) is unchanged.

The item's description said "or its folder as a set" and "preselected"; it now
matches the shape section, which overrules both.

Tests: `AskLocation.test.tsx` ("a drop can add the original file where it
lives", "a copy into a place that already holds that name"), and
`server.test.ts` (the file pick, `fs.same`). Each was shown red with a planted
regression. The browser check ran a real Scriptorium daemon and Chromium. The OS
dialog was stubbed through the `pick` seam. The file drop was a DataTransfer
dispatched in the page, because Playwright cannot drag from the OS. The clicks
and keys were real.

## Port-back notes

- `protocol.ts`: `pick` want `choose-file` (not Story Studio's `folder`; see
  kit-location-dialog-native-picker), answered with `chosen`. A dialog that
  returns only a folder is refused in words ("is a folder, not a file").
- `fs.same { dir, name, size, sha256 }`, answered
  `fs.same { dir, name, exists, same }`. It answers only for a name in a folder
  the session shows (a set, a folder in one, or the workspace:
  `session.shownFolderOrDie`, the destination rule). Any other folder, a name
  with a slash or `..`, a field of the wrong type, a negative size, or a hash
  that is not 64 hex digits is refused, so it cannot be used to probe
  `/etc/passwd` or `~/.ssh`. A link is not followed.
- `tree.ts`: `sameFileAt` is async. A size that differs is answered without
  reading. One that matches is hashed as a stream; its `open` parameter is the
  test seam that shows it. A file over `SAME_FILE_MAX_BYTES` (1 GB) is refused
  unread.
- `daemonClient.ts`: `fileAlreadyAt(request, dir, file)` and `sha256Hex(file)`
  hash the bytes in the page (`crypto.subtle`).
- `ContextSidebar.tsx`: optional `fileAt(dir, file)` prop; `beforeCopy` runs
  ahead of every copy with an `into`, including a drop on a set's row. This
  reaches Story Studio too, once it wires `fileAt`. The drop's ask carries
  `original`.
- `AskLocation.tsx`: `LocationAsk.original?: { files, add }`.
- `WorkspaceShell.tsx`: wires `fileAt` from the daemon client.
