---
type: cycle
title: The document pane
description:
  "Port the kit's document pane and put it in the flagged Scriptorium's centre,
  with the map as its app view: the fourth of five workspace-stack cycles."
tags: [kit, scriptorium, story-studio]
status: stable
lifecycle: active
started: 2026-10-18
appetite:
  Stop when the flagged Scriptorium opens, edits, versions, compares and notes a
  document in the kit's pane, and shows the map, with the gate and acc green;
  the shell and the cutover wait for cycle 5.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-17 }
---

# The document pane

## Why now

The [panes cycle](2026-10-panes.md) landed on 2026-10-17. The flagged
Scriptorium now has chat, sets and moves on the kit, but no way to read or edit
a document. The
[port-shape write-up](../items/workspace-stack-port-shape/write-up.md#2b-the-cycles)
puts the document pane fourth, before the shell, so that the floating composer
has something to dock under.

**The port base, read again on 2026-10-17** (`git log` and `git show` only;
Story Studio's `develop` is at `b6d5956`):

- **The document module comes from `develop` whole.** Of the ten commits since
  `027d7a3` that touch it, the two we leave out elsewhere (copy-in and the
  plugin host) change only its tests.
- **Every op and type the pane uses is already in our daemon**, and every kit
  module it imports is already ported. What's missing is a test helper, the
  stylesheet rules for notes, find and embeds, and declared dependencies.
- **Story Studio's plugin rework doesn't change the pane's API.** Their plugins
  fill the same slots (`appView`, `formatViews`) from above.
- **Size:** about 9.0k lines plus 10.0k of tests, against the plan's 8.9k.

## Scope

The port runs first. The kit's two small slots can run beside it. The
Scriptorium items come last, on top.

- **[item/kit-port-document](../items/kit-port-document.md)**: Story Studio's
  document module at `develop`, with its stylesheet rules and dependencies.
- **[item/kit-backlinks-reference-edges](../items/kit-backlinks-reference-edges.md)**:
  "Linked from" keeps the frontmatter references the wiki layer added.
- **[item/kit-context-row-marker](../items/kit-context-row-marker.md)**: the
  tree's status marks, through Story Studio's `rowMarker` prop without their
  plugin host.
- **[item/scriptorium-kit-document-centre](../items/scriptorium-kit-document-centre.md)**:
  the pane in the frame's centre, with a small workspace context, the held
  selection, trust and stale.
- **[item/scriptorium-kit-map-view](../items/scriptorium-kit-map-view.md)**: the
  map as the pane's app view, fed from the kit's `LinkGraph`.
- **[item/scriptorium-kit-suggest-meta](../items/scriptorium-kit-suggest-meta.md)**:
  E35's "Add a block" on the kit path.
- **[item/kit-docmeta-push-cost](../items/kit-docmeta-push-cost.md)**: the pane
  makes typing constant, and the tree and map make the surface `docMeta`'s first
  real reader.
- **[item/scriptorium-toggle-line-numbers-in-raw-mode](../items/scriptorium-toggle-line-numbers-in-raw-mode.md)**:
  a line-number gutter on the kit's raw editor, toggled.

Out of scope, deliberately:

- **The shell, header search and the floating composer's dock.** These are
  cycle 5.
- **Story Studio's map plugin** (about 2.9k lines, built on their plugin host
  and shaped for Atlas). Re-feeding our own map is the smaller job.
- **Compare navigation (#133) and link health in the status bar (#129).** They
  land on the ported panes, but after this cycle. Story Studio's `compareNav`
  arrives with the port and covers part of #133.
- **Profile schemas anywhere but the set** (below).
- **The shipped Scriptorium.** It stays as it is until the cutover.

## Rulings (Cole, 2026-10-18, in Scriptorium)

Cole took the recommendation on each of the first three questions.

1. **Profile schemas live in the set,** in `_meta/profiles/`, as the kit reads
   them now. An app-level fallback root, profiles shipped with the spell, and
   cutting profiles were not taken. Any of them can be filed later.
2. **"Add a block" (E35) comes across,** as
   [scriptorium-kit-suggest-meta](../items/scriptorium-kit-suggest-meta.md). Not
   taken: leaving frontmatter to the agent's `meta-init`.
3. **The kit's outside-change toast gains "See the difference",** which opens
   compare against the file on disk. It is generic, and offered back. This rides
   with
   [scriptorium-kit-document-centre](../items/scriptorium-kit-document-centre.md).
   Not taken: keeping the toast as it is.
4. **Candidates:**
   - [scriptorium-toggle-line-numbers-in-raw-mode](../items/scriptorium-toggle-line-numbers-in-raw-mode.md)
     joins, on the kit's editor.
   - [kit-mdx-documents](../items/kit-mdx-documents.md) is skipped for now.

## Outcome

_Written at close, not before._

## Sessions

- cycle/document-pane (open)
