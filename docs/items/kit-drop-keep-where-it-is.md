---
type: item
title: A dropped file can be added where it already lives
description:
  Dropping a file on the context pane always asks where its copy should go;
  offer to add the original where it lives instead (as a listed document, or its
  folder as a set), which a browser drop can't name, so through the native
  picker preselected for that file.
status: draft
lifecycle: ready
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

- [ ] The drop dialog offers adding the original file, through the native file
      picker. The chosen file is added as a listed document where it lives, with
      no copy and never its folder.
- [ ] Copying into a chosen place still works. A destination that already holds
      the same file offers to add that one instead of copying it again, and one
      that holds a different file with that name says so before writing.
- [ ] Where the platform has no native picker, the act is hidden.
- [ ] Tested, checked in a real browser on macOS; offered on kit-parity.
