# circe — Round 6 lane (surface)

Owner: circe (surface). Branch `feature/mind-mapper-round6`. Board card
`t-r6-surface`. Authoritative rulings: `plan-round6.md` "Ratified decisions &
lead rulings". This lane fills that skeleton for the surface slice.

Two dispatches. **P1** (this build) = the three items with ZERO engine
dependency. **P2** = deferred until daedalus lands the R6 wire (ratify-batch,
DEL deletes, `proposal.rejected`) + writes the Contract 9 R6 amendments.

---

## P1 — no engine dependency (BUILD NOW)

Build order: MENU(b) (warm-up) → EF (the alarming bug) → RENDER (the burst bug).
Each: TDD the pure logic, full suite green before commit, biome on changed
tsx/ts, semantic tokens both themes, file-scoped commits.

### MENU(b) — long-title context-menu clamp (surface-only)

Finding #3(b). Two unclamped title sinks span the page on a long title:

1. `ui/context-menu.tsx` `ContextMenuContent` Popup — has `min-w-[10rem]`, no
   max. Add a `max-w` (chose `max-w-xs`, 20rem — wide enough for the verb rows,
   bounds the label).
2. `NodeContextMenu.tsx` — `<ContextMenuLabel>{node.title}</ContextMenuLabel>`
   renders the title unclamped. Add `truncate` at the call site (one-line +
   ellipsis; the popup max-w gives it the bound). Not baked into the vendored
   default — the "agent suggests" label is flex and must not truncate.
3. `GraphCanvas.tsx` node-card title (`~167`) — add `line-clamp-2` (cards are a
   fixed `NODE_W=190`; two lines then ellipsis reads better than one on a card).

No logic → no new test; verified by pixels (a seeded long-title node) in both
themes.

### EF — edge-follows-ratify (surface-only; the alarming bug)

Finding #8. A pending EDGE proposal's `draft.source`/`draft.target` hold
endpoint PROPOSAL ids. When a NODE proposal ratifies it gets a NEW minted node
id; the still-pending edge keeps naming the OLD proposal id, which names no real
node → the edge renders to nothing, and `pendingEdgesFrom`'s emptiness filter
does not even catch it (the id is non-empty, just stale) → the edge dangles /
vanishes. This is silent knowledge loss.

Fix (ratified mechanism — no events, no reducer state, no engine change): the
post-ratify snapshot already carries `resultNodeId` on ratified proposals (R5
wire, `proposals.result_node_id`). Re-point endpoints through a
`proposalId→nodeId` map BEFORE the drop-filter.

- `types.ts` — surface `resultNodeId?: string` on `Proposal` (absent while
  pending; the minted node id once ratified).
- `state/pendingOverlay.ts` — add pure `resultNodeIdMap(proposals)` →
  `Map<proposalId, nodeId>` from proposals carrying `resultNodeId`; extend
  `pendingEdgesFrom(proposals, resolve?)` to re-point each endpoint
  (`resolve?.get(id) ?? id`) BEFORE the `.filter(e => e.source && e.target)`.
  `resolve` optional → zoneView's call is untouched (a zoned proposal can't
  ratify while zoned — Contract 9 R3 "promote first" — so the zone view never
  needs the re-point).
- `App.tsx` `mapWithPending` — build the map over the FULL `state.proposals` (a
  pending main edge can name a ratified proposal from anywhere), pass it into
  `pendingEdgesFrom(main, resolve)`.
- TDD in `pendingOverlay.test.ts`: map-build; re-point pending edge to the real
  node id; endpoint with no mapping passes through unchanged; a re-pointed edge
  is NOT dropped.

### RENDER — canvas batch-render fix (surface-only; the burst bug)

Finding #5. `GraphCanvas.tsx` layout effect (`~388`) does
`setNodes(layout(mode, map, …))` — a wholesale replace on every `map` change. A
`propose-batch` burst fires many `proposal.added` events, each its own render
tick; the blind replace races React Flow's async ResizeObserver `onNodesChange`
and earlier nodes get dropped from view (grid view is fine → not the derive).

Fix (ratified — merge-by-id): pure exported `mergeLayout(prev, fresh)` — known
id keeps its on-screen position + `selected` (drag-safe; burst-race can't drop
it), new id takes the freshly-computed layout position, departed id is dropped
(absent from `fresh`). Data always refreshed (pending→ratified, title,
submapChildCount, the identity-stable command closure). The effect distinguishes
a MODE toggle (full replace — recompute all positions) from a MAP change (merge)
via a `prevLayoutMode` ref, so tree↔physics still re-lays-out.

- TDD in `GraphCanvas.test.ts`: new ids get fresh positions; known ids keep
  position + selection, take fresh data; departed ids dropped; a burst (fresh
  superset merged onto prev) preserves every earlier node.
- Export `IdeaNodeData` for the test to construct nodes.

Bonus (ratified): stops a re-layout clobbering a manual drag position.

---

## P2 — BLOCKED on Contract 9 R6 amendments (daedalus lands the wire first)

Sketch only; do NOT start until the lead dispatches against the landed wire.
Refined task list at the end of this doc / returned to the lead.

- **DEL-surface** — Delete item in `NodeContextMenu`; reducer drops on thin
  `node.deleted`/`proposal.deleted` (mirror the `doc.deleted` filter). Confirm
  dialog renders the `NodeCitedError` citing set (edges + submap children). App
  view-heal effects (submap-anchor-gone, selection-by-presence) self-heal.
- **REJECT(a) reducer** — daedalus adds thin `proposal.rejected {id}`; reducer
  drops/flips so a rejected proposal leaves the canvas without a refetch.
- **PROC** — a pending `author:"user"` proposal renders distinctly ("curating" /
  spinner, raw text provisional) — client-only off `author` (no schema change).
  Refine-in-place = agent DELETEs raw + proposes curated.
- **QUEUE** — new `IngestionTray` panel fed by pure
  `state/ingestionQueue.ts → processingItems(proposals)` (pending
  author:"user"), decoupled from the canvas; item leaves on ratify-or-delete.
  Named seam for the multi-agent drop-in: future `proposals.claimed_by`.
- **SUBMAP-CREATE** — select RATIFIED nodes → "group under X" → per-node
  `POST /nodes/:id/anchor` (net-new fetch; the surface calls anchor nowhere
  today). Real-nodes-only (opposite of group-into-zone's pending scope). Reuse
  the group-into-zone modal chassis. Pending-selection case composes via RB's
  ratify-then-anchor — defer to it.

Blocking dependencies: `node.deleted`/`proposal.deleted`/`proposal.rejected`
EventKinds + `resultNodeId` on the proposal wire (already emitted) + the
`DELETE` routes' typed errors — all daedalus, Contract 9 R6.
