---
type: item
title: The location dialog offers the native folder picker
description:
  When a new document or folder asks where it goes, the human can pick a folder
  in the tree or type a path, but not browse with the OS's own folder dialog,
  which the daemon can already open.
status: stable
lifecycle: ready
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

- [ ] The location dialog has a button that opens the native folder picker, and
      the folder chosen fills in the location; cancelling changes nothing.
- [ ] Typing a path and choosing from the tree still work.
- [ ] Tested, and checked in a real browser on macOS; offered on kit-parity.
