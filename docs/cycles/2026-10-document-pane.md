---
type: cycle
title: The document pane
description:
  "Port the kit's document pane and put it in the flagged Scriptorium's centre,
  with the map as its app view: the fourth of five workspace-stack cycles."
tags: [kit, scriptorium, story-studio]
status: draft
lifecycle: planned
started: 2026-10-17
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
  E35's "Add a block" on the kit path, if Cole keeps it (below).
- **[item/kit-docmeta-push-cost](../items/kit-docmeta-push-cost.md)**: the pane
  makes typing constant, and the tree and map make the surface `docMeta`'s first
  real reader.

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

## Rulings wanted before convene

1. **Where profile schemas live.** The kit reads `_meta/profiles/` inside a set,
   nearest folder first, and never above the set. The options:
   - **(a) Keep that convention.** No code, and both kits stay the same.
   - **(b) Add an app-level fallback root**, such as `~/.scriptorium/profiles/`.
     This needs a new kit slot, and it breaks "never above the set".
   - **(c) Ship profiles with the spell**, for pdocs' own types.
   - **(d) Cut profiles and relations** (about 2.3k lines).

   Recommended: (a) for this cycle. The shipped app has no profiles, so nothing
   regresses, and (b) or (c) can be filed for later.

2. **E35's "Add a block".** Bring it across (`scriptorium-kit-suggest-meta`), or
   let it go and leave frontmatter to the agent's `meta-init`? Recommended:
   bring it across. It is small, and it is the human's only path to frontmatter
   without the agent.
3. **An outside change** is a Reload/Keep toast in the kit
   (`chat/OutsideChangeToasts.tsx`). It has no diff. The shipped app shows a
   banner with "See the difference" (E54). Recommended: add "See the difference"
   to the kit's toast, opening compare against the file on disk. It's generic,
   so it can be offered back, and a warning needs an act that answers it.
4. **Candidates:**
   - [scriptorium-toggle-line-numbers-in-raw-mode](../items/scriptorium-toggle-line-numbers-in-raw-mode.md)
     (neither editor has line numbers);
   - [kit-mdx-documents](../items/kit-mdx-documents.md) (`.mdx` files vanish on
     the kit path).

   Take either, or leave them?

## Outcome

_Written at close, not before._

## Sessions
