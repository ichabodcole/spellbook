---
type: item
title: The map opens as the document pane's app view
description:
  Move Scriptorium's map (MapOverlay and forceLayout) into DocumentPane's
  appView, fed from the kit's LinkGraph joined with docMeta, opened from a set's
  menu.
status: stable
lifecycle: active
id: 01a14dc5-7029-765d-aac9-d090db989e62
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [scriptorium, kit, map]
parent: feature/workspace-kit
cycle: 2026-10-document-pane
---

# The map opens as the document pane's app view

The shipped map is a dialog opened from a set's menu:
`surface/components/context/MapOverlay.tsx` and `forceLayout.ts`, about 640
lines, fed by the shipped `graph` message. The plan
([port shape](workspace-stack-port-shape/write-up.md#2b-the-cycles), row 4)
moves it into `DocumentPane`'s `appView`, the app's own centre view beside raw,
rendered, split and compare, and feeds it from the kit's `LinkGraph`.

**What the feed changes:**

- The kit's graph has no `stale` or `tags` on a node. They are joined from
  `appState.docMeta`.
- Frontmatter references arrive as edges with `source: "frontmatter"`.
- Kit edges are folded with a count. They have no per-edge state (in the set,
  outside it, a folder, missing) and no dangling or unsupported lists. The map
  drops those, or takes them from `link-check`; the implementer says which, and
  why.

**Trust on the map:** `docMeta`'s `trust` reads `unverified` both when
`verified` is absent and when it is empty. So if the map shows trust at all, it
needs `docMeta` to tell those apart, or it breaks E69.

Story Studio's own map is now a plugin (about 2.9k lines, on the plugin host and
shaped for Atlas). Re-feeding ours is the smaller job, and the one the plan
sized.

## Definition of done

- [x] "Show map" on a set opens the map in the document pane's centre, with the
      same two layouts and draw cap as the shipped one.
- [x] The map's nodes and edges come from the kit's `LinkGraph`, joined with
      `docMeta`, and a test pins the mapping.
- [x] Nothing on the map reads `unverified` because a field is missing (E69).
- [x] The shipped map is unchanged.

## Done and verified

`2e0d2ac5` adds the feed: `surface/kit/mapGraph.ts`, a pure function from the
kit's `LinkGraph` (asked with `link.graph`, `within` the set's root) and
`docMeta` to the map's shape, pinned by `mapGraph.test.ts`. `8317e3ea` adds the
view: `MapView.tsx` is the shipped `MapOverlay`'s body taken out of its dialog,
with the same columns and physics layouts, the 140 draw cap and the dense-edge
threshold, and it imports the shipped `forceLayout.ts` unchanged. The wiring is
`useMapView.tsx`. "Show the map of this set" (the shipped words) is a
`menuActions` entry on a set's row; it is not offered on a document listed on
its own. Choosing it picks the set and makes the map the pane's `appView`.
Clicking a node opens its document and leaves the map, and the pane's toggle
goes back to it. The frame's own change is three lines. `14cdb6cb` rebuilds the
kit's `dist`.

The choices:

- **Dropped, not taken from `link-check`:** per-edge state and the dangling and
  unsupported counts. `within` keeps only the set's own documents, so every edge
  left is in the set, which is the only state the shipped map drew. "Leaving the
  set" and "dangling" were header counts with no act attached to them.
  `link-check` already names each dangling link, with its line.
- **Trust is not shown,** as it is not on the shipped map, so E69 holds without
  changing `docMeta`. **Status** is the frontmatter's own: an absent one stays
  absent, where the shipped graph wrote `stable`.
- **Frontmatter references** reach the kit graph as `edge: "frontmatter"`, not
  as `source`, and are drawn dashed. Folded edges are drawn once each, and the
  header counts their links.
- **The draw cap picks different documents:** the kit answers best connected
  first, where the shipped graph answers in file order. On `docs/items` (378
  documents), the kit map draws 234 links among its 140 and the shipped map
  draws 54. The kit header also says when the kit's own 500 cut left documents
  out.
- **The view is a copy of the shipped overlay's body,** because the shipped
  surface must not change. A fix to one is a fix to make in both, until the
  shipped surface retires.

The tests are `mapGraph.test.ts` (8) and `Frame.map.test.tsx` (5, on a real kit
daemon), and 14 planted mutations each turn a test red. Checked in a real
browser (Playwright, 127.0.0.1, scratch home, `open` stubbed) on a copy of
`docs/items` and on a three-document set, and compared with the shipped map on
the same copy.

## Port-back notes

- Nothing. No kit file changed and nothing was ported from Story Studio. The map
  lives in Scriptorium's flagged surface (`src/scriptorium/surface/kit/`), on
  the kit's existing `appView` slot and `link.graph` op.
