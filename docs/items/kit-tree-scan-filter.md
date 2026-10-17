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

- [ ] An app can filter the kit's tree scan. A filtered path is absent from the
      tree, search and the link graph, and stays on disk.
- [ ] The flagged Scriptorium's `hide` and `unhide` work on it, with the hidden
      list in the app slot. The kit's own `trash` is unchanged.
- [ ] A hidden path survives a restart and a rescan, with a test.
- [ ] Where the filter sits is agreed with Story Studio on kit-parity, against
      `kit-suite-bundle-kinds`.
