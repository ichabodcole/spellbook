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

**Mid-cycle rulings (Cole, 2026-10-18):**

5. **The typing race joins this cycle.** A verifier found that typing right
   after opening a document can be lost on the kit path when the daemon is slow.
   [kit-read-reply-reverts-sent-edit](../items/kit-read-reply-reverts-sent-edit.md)
   was approved as written, and it is fixed before landing. Not taken: landing
   now and fixing it before the cutover.
6. **Broken links must be visible to the human.** The kit map drops the shipped
   header's "leaving" and "dangling" numbers, and lands as it is. A visible sign
   with an act attached is filed as
   [kit-broken-links-visible](../items/kit-broken-links-visible.md). Not taken:
   restoring the map's numbers now, or leaving it to the agent's verbs.
7. **Reader mode should cover the raw editor too.** That is filed as
   [kit-reader-mode-covers-raw](../items/kit-reader-mode-covers-raw.md). Until
   it lands, the line-number gutter's fade is built but cannot be seen. Not
   taken: keeping reader mode rendered-only.

## Outcome

**What shipped:**

- **The kit's document pane,** ported whole from Story Studio's `develop`
  (`b6d5956`), with its own stylesheet. The other spells' stylesheets are
  unchanged, byte for byte.
- **The flagged Scriptorium edits documents in it:**
  - versions, compare and merge;
  - raw, rendered and split views;
  - the held selection going to chat and Notes;
  - the trust and stale chips;
  - line numbers;
  - "Linked from", including frontmatter references;
  - the map as the pane's own view;
  - "Add a block" (E35);
  - "See the difference" on an outside change.
- **The kit gained six optional slots,** each to be offered back on kit-parity:
  `rowMarker`, `textOffer`, `lineNumbers`, `onShowDiff`, `onOpenEdge` and
  `appStateUnchanged`. The last is a change to the wire: `docMeta` is only
  resent when it changed.
- **A data-loss race the port carried** is fixed: typing right after opening a
  document could be lost. Story Studio has the same code.

**What was cut, or changed scope:**

- **The map lost its "leaving the set" and "dangling" numbers.** Cole ruled that
  broken links must be visible to the human some other way
  (`kit-broken-links-visible`).
- **The reader-mode fade for line numbers is built but can't be seen yet.** Cole
  ruled that reader mode should cover the raw editor
  (`kit-reader-mode-covers-raw`).
- **A selection's `about.path` is now the version file,** not the original on
  disk. This is an agent-facing change for the cutover.
- **`.mdx` was skipped** (ruling 4).

**What was learned:**

- **A port carries its source's bugs, including data loss.** The race came from
  the shared client. It surfaced only because a verifier added network lag in a
  real browser. That is worth doing for every pane that edits.
- **Decide from shared state, not a tab's copy.** "Add a block" first decided
  from its own tab's text, and a stale tab overwrote another tab's typing. The
  kit not syncing edits across tabs (`kit-second-tab-misses-edits`) makes every
  per-tab decision suspect.
- **Every verifier found something its implementer couldn't:**
  - CSS that grew in five other spells;
  - a Story Studio reader of `docs[].hash`;
  - a false port-back claim;
  - a map node showing two moments.

  Seven of eight invented mutations that survived the author's tests.

- **Gates run under the load of three agents gave false reds.** The verdict came
  from each verifier's own gate on the committed tip. The combined gate on
  `cycle/document-pane` ended at 6,585 pass, 0 fail.

## Sessions

- cycle/document-pane (open)
