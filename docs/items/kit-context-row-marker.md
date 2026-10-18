---
type: item
title: Tree rows carry an app's status mark
description:
  A rowMarker slot on ContextSidebar (Story Studio's WorkspaceShell prop from
  1dd40cc, held on the sidebar because our kit has no shell), so Scriptorium's
  tree shows draft, stale, deprecated and unreadable marks from docMeta, as the
  shipped tree does.
status: stable
lifecycle: review
id: 01a14dc5-6efd-75c7-aaed-1b2bec2cdc3a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, context, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-document-pane
---

# Tree rows carry an app's status mark

The shipped Scriptorium marks tree rows from each document's frontmatter: draft,
stale, deprecated and unreadable (`statusMark` in
`surface/components/context/model.ts`, drawn by `EntryTree.tsx`). The kit's
`ContextSidebar` has no way to do that. Story Studio has a `rowMarker` prop on
its `WorkspaceShell`, introduced in `1dd40cc` with Atlas's canvas row marks. The
shell composes it into the badge it hands its sidebar. Our kit has no shell yet,
so the prop goes on `ContextSidebar`.

We take only the prop, not the plugin host that `3d029f0` carried it through.
The flagged Scriptorium fills it from `appState.docMeta`, which already carries
`status`, `lifecycle`, `stale` and `error` for each document.

## Definition of done

- [x] `ContextSidebar` takes an optional `rowMarker`, shaped as Story Studio's
      is. Without it, rows are unchanged.
- [x] The flagged Scriptorium's tree shows the same four marks the shipped tree
      does, for the same documents.
- [x] The prop's port-back note says it is Story Studio's own shape, taken
      without the plugin host.

## Done and verified

Ported from Story Studio develop `b6d5956`. The prop is in `998e63c5`
(`ContextSidebar.rowMarker.test.tsx`) and the frame's marks in the next commit
(`Frame.rowMarker.test.tsx`).

**Where the prop came from.** It was not in `3d029f0`'s
`packages/kit/src/context`, which that commit does not touch. `rowMarker` is a
`WorkspaceShell` prop. It arrived in `1dd40cc`, the Atlas canvas row marks, and
is unchanged at `b6d5956`. The shell composes it into the `badgeFor` it hands
its sidebar. Our kit has no shell yet, so the prop sits on `ContextSidebar`,
with the same name and shape: `(path: string) => ReactNode`. It marks a
document, image or bundle row, asked by the row's own absolute path (for a
bundle, its folder), after the row's badge. The composition, `withRowMarker`, is
the shell's inline code. Without the prop, `badgeFor` passes through as it is.

**The frame.** `scriptoriumRowMarker(docMeta)` calls the shipped `statusMark` to
decide the mark, so both trees decide the same way by construction. It draws the
shipped `StatusDot`'s classes, less `ml-auto`, because the kit row's trailing
span already places the dot. It covers a document listed on its own as well as
the rows in a set's tree, as the shipped tree does. A bundle's row is asked by
its folder, which `docMeta` does not key, so it has no mark. The shipped tree
has no bundles.

## Port-back notes

- **`rowMarker` is Story Studio's own shape, taken without the plugin host.** It
  has the same name, the same `(path: string) => ReactNode` signature and the
  same composition after the badge, and the bundle row is still asked by its
  folder. None of `3d029f0`'s `StudioPlugin` or `SurfacePlugin`, nor its
  combining rules, came with it.
- **It moved from `WorkspaceShell` to `ContextSidebar`.** The shell's inline
  `badgeFor` composition is now `withRowMarker`, exported from
  `ContextSidebar.tsx`. To take it back, the shell passes `rowMarker` through to
  its sidebar and drops the composition from its own `badgeFor`. Rows come out
  the same. The gain is that an app that composes the sidebar without the shell
  can mark rows too.
- **New: `ContextSidebar.rowMarker.test.tsx`.** Story Studio's kit has no test
  of the row marker. Its only check is `plugins.test.tsx`, which covers the
  combining. This file covers the sidebar: rows are unchanged without a marker,
  the paths each kind of row is asked by, and the order after the badge.
