---
type: item
title: The map opens as the document pane's app view
description:
  Move Scriptorium's map (MapOverlay and forceLayout) into DocumentPane's
  appView, fed from the kit's LinkGraph joined with docMeta, opened from a set's
  menu.
status: stable
lifecycle: done
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

**The commits.**

- `2e0d2ac5` adds the feed: `surface/kit/mapGraph.ts`, a pure function from the
  kit's `LinkGraph` and `docMeta` to the map's shape, pinned by
  `mapGraph.test.ts`.
- `8317e3ea` adds the view. `MapView.tsx` is the shipped `MapOverlay`'s body
  taken out of its dialog: the same columns and physics layouts, the 140 draw
  cap and the dense-edge threshold. It imports the shipped `forceLayout.ts`
  unchanged. The wiring is `useMapView.tsx`.
- `553559ae` makes each showing one moment, after the verifier found a node
  drawn with its new stale mark and tags beside its old status.
- `14cdb6cb` and `fd9e0c6b` rebuild `dist`.

**How it works.** "Show the map of this set" (the shipped words) is a
`menuActions` entry on a set's row. A document listed on its own does not get
it. Choosing it makes the map the pane's `appView`.

- Clicking a node opens its document and leaves the map.
- The pane's toggle goes back to the map, and Escape leaves it, as Escape closed
  the shipped overlay.
- The layout mode (columns or physics) survives leaving and coming back.
- Taking the set out of the context withdraws its map.

**One moment per showing.** The map makes one ask, `scriptorium.map`
(`backend/kit/map.ts`, a flagged-backend verb). It returns the kit's `linkGraph`
within the set and the documents' `docMeta`, read in the same handler. Every
showing asks again, by the menu or by the toggle, and the latest ask wins.

The page's own `docMeta` is not used, because it can be older than the graph. A
change on disk to a document the session does not hold sends no state push, only
`context.changed`. That gap also leaves the tree's row markers stale until the
next push. It is a kit-path finding, not fixed here.

The frame's change is +8 −4 lines (`git diff --stat`). The flagged server's
change is one import and one spread.

**The choices.**

- **Trust is not shown,** as it is not on the shipped map. So E69 holds without
  changing `docMeta`.
- **Status is the frontmatter's own:** an absent one stays absent, where the
  shipped graph wrote `stable`.
- **Frontmatter references** reach the kit graph as `edge: "frontmatter"`, not
  as `source`, and are drawn dashed.
- **Folded edges** are drawn once each, and the header counts their links.
- **The view is a copy of the shipped overlay's body,** because the shipped
  surface must not change. A fix to one is a fix to make in both, until the
  shipped surface retires.

**Where it differs from the shipped map.**

- **No sign of broken links reaches the human.** The header no longer shows
  "leaving the set" or "dangling", so the human surface now shows no sign of
  broken links at all. `link-check` and `doctor` are agent verbs. This needs
  Cole's ruling.
- **"N out" counts only links inside the set.** The kit counts links within the
  graph it was asked for. The shipped map counted every link the document makes,
  including those leaving the set and dangling ones.
- **Untitled documents take their H1.** A document with no frontmatter `title`
  is named by its first heading, then its file name. The shipped map went
  straight to the file name.
- **The draw cap picks different documents.** The kit answers best connected
  first, where the shipped graph answered in file order. The header now says
  "drawing the 140 best-connected", not "drawing the first 140". On a copy of
  `docs/items` (378 documents), the kit map draws 234 links among its 140; the
  shipped map draws 54 among its own.
- **Column order follows the new node order.** Columns are still sorted by size,
  so columns of equal size come in the order their first document arrives.
- **The kit's own cut is said:** "N more not read" when a set passes its 500.
- **Pre-existing, in both maps:** physics draws every document, but only the
  edges among the 140 the columns place.

**Tests.** The tests are:

- `mapGraph.test.ts` (8);
- `MapView.test.tsx` (6);
- `useMapView.test.tsx` (5, on a fake daemon whose answers the test releases);
- `Frame.map.test.tsx` (7, on a real kit daemon).

25 planted mutations each turn at least one test red. Among them are the four
that survived the first round: the earlier set's answer winning the race, the
dense threshold counting lines, the cut missing from the header, and stale not
colouring the dot.

The frame's physics test checks the canvas, not the bodies. `d3-timer` binds the
window's animation frame once, when it first loads, so in a run where another
test file loaded it under a DOM since removed, its ticks never come. The bodies
were checked in the browser instead.

**Browser checks.** Playwright, 127.0.0.1, a scratch home, `open` stubbed.

- The first round checked a copy of `docs/items` and a three-document set, and
  compared them with the shipped map on the same copy.
- After `553559ae`:
  - physics kept across Escape and the toggle;
  - a status, stale and tag change made on disk between showings, all shown on
    the next showing;
  - the map withdrawn when its set was removed.

## Port-back notes

- Nothing. No kit file changed and nothing was ported from Story Studio. The map
  lives in Scriptorium's flagged surface (`src/scriptorium/surface/kit/`) and
  backend (`backend/kit/map.ts`). It uses the kit's existing `appView` slot, its
  app-verb reply, and `session.linkGraph`.
