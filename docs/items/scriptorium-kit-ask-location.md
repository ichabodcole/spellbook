---
type: item
title: Flagged Scriptorium asks where to create when nothing is selected
description:
  "Build the panes-cycle requirement recorded in
  scriptorium-no-default-workspace: New File, New Folder and a drop with nothing
  selected ask for a location among the session's sets, with the last one used
  preselected, and offer a new folder at a path."
status: stable
lifecycle: review
id: 01a14bca-18cc-72b3-8890-08d709c255a9
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# Flagged Scriptorium asks where to create when nothing is selected

[scriptorium-no-default-workspace](scriptorium-no-default-workspace.md) removed
the hidden default workspace. Its "Requirement for the panes cycle" section says
what the surface does instead. In short:

- **With a selection,** New File and New Folder create beside the selected
  document, or inside the selected folder or set, without asking.
- **With nothing selected,** the surface asks where to create, offering the
  session's sets and their folders, with the last location used preselected.
- **The last location** is remembered for the session. If it's gone, nothing is
  preselected.
- **A drop** onto the context list with no set or folder under it asks the same
  way.
- **The dialog can make room:** a new folder at a path (`folder.add`), and a
  pointer to `make-set`.
- **Every create, import and drop sends a `dir`.** The daemon already refuses
  one that names no place.

## Definition of done

- [x] Each rule in that requirement section holds in the flagged Scriptorium's
      surface, with a test or a browser check per rule.
- [x] No surface request reaches the daemon without a `dir`. A test fails if one
      does.

## Done and verified

Built on `impl/scriptorium-kit-ask-location`, from the interim frame's tip after
its verification fixes (`1e1b4a11`), in two commits: the kit slot and dialog,
then the frame that fills it (the commit carrying this note is the third). No
Story Studio code was ported: this is our own kit change, written to port back.

- **The kit slot.** `ContextSidebar` takes an optional `askLocation`. Given, and
  with no `workspace`, the list offers New document… and New folder… (and New
  <bundle>… per registered type) in its top row and its background menu, and a
  file dropped on the list itself asks before it is copied. Every op then
  carries the place chosen as `dir`; backing out sends nothing. Without the
  slot, or with a workspace (Story Studio), the sidebar is unchanged: every
  existing context test passes untouched.
- **The dialog.** `useAskLocation` (`src/kit/context/AskLocation.tsx`) answers
  the slot: every set and its folders (the places "Move to…" offers),
  searchable, the place chosen last highlighted so a run of creates is one Enter
  each. A new folder at a path (`folder.add`) makes room; it is highlighted, and
  the focus goes back to the search, once the context shows it, and a refusal is
  said in the dialog. The app's own words go under the list: Scriptorium's point
  to Turn into a set.
- **Where "last location" lives:** in the hook's state, in the surface, for as
  long as the page lives. Each session is its own page on its own port, so
  nothing is kept by origin and nothing outlives the session. A reload starts
  with nothing preselected, which is the rule's own fallback. A place that has
  left the context is never highlighted.
- **With a selection nothing asks.** The kit already makes inside a set (its
  row's menu, its header) and inside a folder (the folder's menu). It offers
  nothing on a document's row, by Story Studio's choice (its test says so), so
  "beside the selected document" did not hold. Scriptorium adds New document
  beside it and New folder beside it there, through its menu-action slot.
- **The list's words** no longer promise that a drop "here" copies it in: "Drop
  documents or images, then choose a set", and the empty state says a drop is
  copied into a set you choose.
- **A frame fix the ask exposed.** The frame built `created` and `moved` afresh
  on every render, and the sidebar acts on a new one, so after any create the
  next snapshot pulled the view back into the set the human had left. Both are
  memoised on the daemon's `done`.

Verified: kit tests (`AskLocation.test.tsx`, fixtures) and frame tests against a
real flagged daemon (`Frame.test.tsx`). Every frame test is watched, and fails
when a `doc.create`, `folder.create`, `bundle.create`, `import` or image import
reaches the daemon without a `dir`. Each addition was mutation-checked (eleven
plants, each red, then restored). A real-browser pass (Playwright) on a scratch
home covered every rule: the ask with nothing preselected, the remembered place
and Enter, a place gone from the context, a folder made at a path and its
refusal, a dropped document and image copied into the set chosen, and the three
creates with a selection, none of which asked. The shipped Scriptorium's parity
holds, and the full gate is green.

After a no-stake verification, three small fixes, each its own commit with a
test that goes red under its mutation:

- **A folder made at a path with `.`, `..` or `//`** was made but never
  highlighted: the dialog looked for it under the path as typed. It now resolves
  the path as the context names places (`placePath`), and also looks for the
  `path` the daemon's answer gives.
- **The move dialog** promised that the chat names the links left pointing at
  the old place; the chat only counts them. It now says so, and that the list in
  the dialog is them.
- **The Notes tab's empty list**, with `addUnavailable`, no longer asks the
  human to select text the surface cannot show.

## Port-back notes

- `ContextSidebar`: the optional `askLocation` prop; with it and no `workspace`,
  the list's New document…, New folder… and New <bundle>… buttons and
  background-menu items, the asking drop on the list itself, and the changed
  words. `importFiles` is split, so a drop's files are read off the event before
  the ask.
- `AskLocation.tsx` (new): `LocationAsk`, `AskLocation`, `locationTargets`,
  `LocationDialog`, `useAskLocation`. The dialog reuses `MoveToDialog`'s classes
  and `AddPath`.
- `model.ts`: `moveTargets` takes `item: string | null`. Null means nothing is
  moving, so no place is left out.
- `index.ts` exports the new module.
- `AskLocation.tsx`: `placePath` resolves a typed path (`~/`, `.`, `..`, `//`)
  before the dialog looks for the folder it made, and the `path` in
  `addFolder`'s answer is looked for too.
- `chat/NotesPanel.tsx`: with `addUnavailable`, the empty list says "No notes on
  this document." instead of asking for a selection. Without the prop, as
  before.
