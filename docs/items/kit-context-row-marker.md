---
type: item
title: Tree rows carry an app's status mark
description:
  A rowMarker slot on ContextSidebar so Scriptorium's tree shows draft, stale,
  deprecated and unreadable marks from docMeta, as the shipped tree does.
status: stable
lifecycle: triage
id: 01a14dc5-6efd-75c7-aaed-1b2bec2cdc3a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, context, scriptorium]
parent: feature/workspace-kit
---

# Tree rows carry an app's status mark

The shipped Scriptorium marks tree rows from each document's frontmatter: draft,
stale, deprecated and unreadable (`statusMark` in
`surface/components/context/model.ts`, drawn by `EntryTree.tsx`). The kit's
`ContextSidebar` has no way to do that. Story Studio added a `rowMarker` prop to
its sidebar in `3d029f0`, the plugin-host commit we left out of context.

We take only the prop, not the plugin host. The flagged Scriptorium fills it
from `appState.docMeta`, which already carries `status`, `lifecycle`, `stale`
and `error` for each document.

## Definition of done

- [ ] `ContextSidebar` takes an optional `rowMarker`, shaped as Story Studio's
      is. Without it, rows are unchanged.
- [ ] The flagged Scriptorium's tree shows the same four marks the shipped tree
      does, for the same documents.
- [ ] The prop's port-back note says it is Story Studio's own shape, taken
      without the plugin host.
