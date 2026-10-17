---
type: item
title: A kit tree-scan filter, and Scriptorium's hide and unhide on it
description:
  Let an app filter what the kit's tree scan shows, kept in the app slot, and
  build Scriptorium's hide and unhide on it.
status: stable
lifecycle: ready
id: 01a1478f-338b-7095-b5ea-8cbd6a9b8edd
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# A kit tree-scan filter, and Scriptorium's hide and unhide on it

Scriptorium can hide a document, folder or set without touching the disk, and
bring it back. The kit has no such state, on purpose: its only removal is
`trash`, which is the human's alone (E68). The kit's mirror scan is internal to
the session, so an app can't filter what it shows
([write-up, 3a](../items/workspace-stack-port-shape/write-up.md#3a-the-wiki-layer-against-the-four-extension-points)).

Story Studio's `kit-suite-bundle-kinds` item would show other apps' bundles as
one guarded entry in the same scan (kit-parity message 42). The filter should
sit where that rule would go.

## Definition of done

- [x] An app can filter the kit's tree scan. A filtered path is absent from the
      tree, search and the link graph, and stays on disk.
- [x] The flagged Scriptorium's `hide` and `unhide` work on it, with the hidden
      list in the app slot. The kit's own `trash` is unchanged.
- [x] A hidden path survives a restart and a rescan, with a test.
- [ ] Where the filter sits is agreed with Story Studio on kit-parity, against
      `kit-suite-bundle-kinds`.

## Done and verified

`ab52229b` adds the kit slot: `AppDeclaration.scan(at)` answers a `ScanRule`
whose `skip(rel, isDir)` leaves a path out of a set's scan, before it is read or
counted toward the cap. Every scan of a set goes through it: a restore, a
rescan, an outside change and an add. `refilter(entryId?)` rescans after the app
changes what the rule reads, and `shownAt(path)` locates a path for an app act.
`3601ce3d` builds the kit path's `hide` and `unhide` on it. The hidden lists are
in the app slot (`app.hidden` by entry id, slot version 2) and in the state as
`appState.hidden`, and `trash` is untouched. Tests cover the kit session, the
daemon's watcher rescan, and Scriptorium's launchers through a close and
restore.

Deliberate choices:

- The rule is asked only of a set's own paths, never of a bundle's insides.
- A whole entry's `hide` removes it with no undo, as the kit's own context
  remove does; an in-set hide and an unhide go on the undo history.
- The rule is an object so that a node transform can join it later. Story
  Studio's current `kit-suite-bundle-kinds` asks for something else: a stage's
  copies stay in the tree and the link check, and leave only the whole-project
  views. That needs a per-view exclusion beside this slot, not a scan skip.
