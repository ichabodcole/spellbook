---
type: item
title: The map opens as the document pane's app view
description:
  Move Scriptorium's map (MapOverlay and forceLayout) into DocumentPane's
  appView, fed from the kit's LinkGraph joined with docMeta, opened from a set's
  menu.
status: draft
lifecycle: triage
id: 01a14dc5-7029-765d-aac9-d090db989e62
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [scriptorium, kit, map]
parent: feature/workspace-kit
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

- [ ] "Show map" on a set opens the map in the document pane's centre, with the
      same two layouts and draw cap as the shipped one.
- [ ] The map's nodes and edges come from the kit's `LinkGraph`, joined with
      `docMeta`, and a test pins the mapping.
- [ ] Nothing on the map reads `unverified` because a field is missing (E69).
- [ ] The shipped map is unchanged.
