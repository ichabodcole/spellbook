# circe — Round 5 lane (surface)

Owner: circe (surface). Board card: `t-r5-surface`. Authoritative ground:
`docs/projects/mind-mapper/plan-round5.md` — "Ratified decisions & lead
rulings". This lane details the BUILD, it does not re-rule.

Two phases, hard split by engine dependency:

- **P1 (this dispatch)** — ESC, SC, SL. Zero engine dependency; all read
  existing surface state (`boardMap`, `selectedIds`, `state.edges`). Build order
  ESC → SC → SL (SL last — the edge-dim plumbing is the load-bearing cost).
- **P2 (LATER dispatch)** — SG2, IC. Blocked on Contract 9 R5 amendments
  (daedalus's submap wire + `POST /proposals/:id/zone`). Sketched below; do NOT
  start until the lead dispatches against the landed wire.

---

## P1 — full task detail

### P1.1 — ESC fix (bug #11) — RULED

Two real misses:

1. The visible `<kbd>esc</kbd>` (SearchPalette.tsx) has no `onClick` — it was
   never a button, so clicking it does nothing.
2. The Escape handler (SearchPalette input `onKeyDown`: clear query + reset
   active + blur) lives ONLY on the input. App's global keydown handles ⌘K + `/`
   (window-level) but NOT Escape — so Escape is not a global dismiss, unlike its
   summon counterparts.

Fix:

- Make the `<kbd>` a real `Button` wired to a `dismiss()` (clear query + reset
  active + blur). The keyboard-summon house rule inverted: the summoned thing
  (the permanent palette) gets a clickable dismiss twin.
- Lift Escape to a **window-level** handler in App (mirror the summon binding).
  Guarded by a pure predicate
  `shouldDismissSearch(activeTag, isSearchInput, hasQuery)` so Escape does NOT
  hijack the nodeForm / composer / dialog Escape:
  - search input focused → dismiss (true)
  - another INPUT/TEXTAREA focused → false (typing elsewhere owns its Escape)
  - focus on the board + a lingering query → dismiss (true)
  - focus on the board, no query → no-op (false)
- Empty-query Escape while search-focused → blur (no-op on query).

TDD: `state/searchDismiss.ts` pure predicate + `searchDismiss.test.ts`. The
wiring (window listener, kbd Button) is verified live.

### P1.2 — SC (select-connected) — RULED surface-only

- Add `"Select connected"` to the `NodeCommand` union (NodeContextMenu.tsx) + a
  menu item (icon `Waypoints`), placed by Focus (both are attention verbs).
- Branch in `handleNodeCommand` (App.tsx): union the node's depth-1 neighbors
  (incl. the node itself) into `selectedIds`:
  `setSelectedIds([...lensSet(boardMap, node.id, 1)])`.
- Computed over the active **boardMap** (not raw `state.edges`) so pending/zone
  context is respected.
- Nodes only (edges-in-selection is a follow-on).

Reuse refactor: `lensSet` is extracted from App.tsx into `state/neighborhood.ts`
(exported, param loosened to `{ edges: MapEdge[] }`), so the pure depth-1 derive
is unit-testable and DRY (visibleMap + SC + SL all reuse it).

TDD: `neighborhood.test.ts` — depth-1 = node ∪ neighbors, depth-0 = node only,
disconnected node = itself only.

### P1.3 — SL (spotlight lens) — RULED surface-only; NEW edge-dim plumbing

The biggest P1 item. Given 2+ selected nodes:

- Compute the intersection (common depth-1 neighbors) client-side from
  `boardMap.edges` (reuse `lensSet`). Pure derive
  `computeSpotlight(map, selectedIds)` → `{ nodes: Set, edges: Set } | null`
  (null when <2 selected). Lit nodes = selected ∪ shared-neighbors; lit edges =
  the induced subgraph over lit nodes (both endpoints lit) — the joining edges
  are exactly this subset, and a bright node-pair never shows a dim edge between
  them.
- **Own dim channel** — a NEW App `spotlight` boolean + a derived
  `spotlightSets` memo, NOT `highlightIds` (search owns that; they'd collide).
- **Node dim**: reuse the `dimmed`/opacity-20 idiom in GraphCanvas renderNodes,
  OR'd with the search dim into one `data.dimmed` (same visual, two sources).
- **Edge dim (the load-bearing work)**: `toFlowEdges` sets edge opacity by
  provenance/pending only, with no render overlay. Add a `renderEdges` memo that
  overlays a spotlight dim — non-lit edges drop to ~0.08 opacity (path + label +
  label-bg), lit edges keep their base styling. Feed `renderEdges` to ReactFlow.
- **Control**: a `SpotlightToggle` (icon `Flashlight`, `aria-pressed`) in the
  canvas Panel `panelTopRight` beside ViewToggle → **map-view only by
  construction** (panelTopRight renders only in map view; CardGrid has no edges,
  so grid is skipped per ruling). Enabled at ≥2 selected; toggling off restores.
  Auto-resets to off if selection drops below 2 (keeps the pressed state
  honest).
- No keyboard summon added (the button is the sole affordance — no orphan key);
  candidate if drive-5 wants one.
- Heat mode + promote-to-overlap are OUT of scope.

TDD: `spotlight.test.ts` — intersection (2 selected, shared neighbor lit,
non-shared dim), joining edges lit / others dim, <2 selected = null, no-shared =
selected-only lit.

---

## P2 — sketch (BLOCKED on Contract 9 R5 amendments)

Do NOT start until the lead dispatches against daedalus's landed submap wire +
`POST /proposals/:id/zone`.

### SG2 — submap surface navigation (AMENDED: client-side derive)

- Submap view = client derive `filter(anchorNodeId === activeAnchor)` slotting
  between zone and lens; `activeAnchor` is view-local (like `activeZone`).
- Enter via `onNodeDoubleClick` (an anchor node) OR a NodeCommand; breadcrumb =
  client parent-walk (which server-scoping would hide — the clincher).
- Badge "has submap" from server-derived `submapChildCount`.
- Create-into-submap tags `activeAnchor` post-ratify.
- Consumes: `state.nodes[].anchorNodeId`, `submapChildCount`, `node.anchored`
  event (Contract 9 R5).

### IC — intent-composer affordances (RULED)

- (a) add-node = right-click-pane → free-text modal →
  `proposeAsUser("node", author:"user")`; DROP "at click position"; retire the
  old pane double-click structured form (gesture cleanup: node double-click →
  enter submap; pane right-click → add-node).
- (b) drag-connect = bind `onConnectEnd` → chain node-proposal then
  edge-proposal with `target` = the new proposal id (needs `proposeAsUser` to
  return the id, or one `propose-batch`).
- (c) zone-create = empty-zone affordance now (`createZone`, zero change); group
  selected-in via NEW `POST /proposals/:id/zone {zoneId|null}` (daedalus adds).

Gesture cleanup is the cross-cutting note: double-click's job moves from "sketch
a node" to "enter submap" — coordinate the SG2 + IC(a) landing so the
double-click handler is only rewired once.
