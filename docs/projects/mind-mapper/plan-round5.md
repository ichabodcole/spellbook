# mind-mapper Round 5 — plan skeleton (subgraphs + drive-4 cluster)

**Status: RATIFIED 2026-07-21 — see "Ratified decisions & lead rulings" (the
authoritative delta; claim texts above are the superseded hypotheses).** Lead:
prospero. Seats: daedalus (engine), circe (surface), cassandra (gate). Source:
`drive4-findings.md` triage (Cole approved the cluster, "Sounds right!").
Branch: `feature/mind-mapper-round5`, cut from develop @ 29e27df.

## How this plan is authored

Prospero owns this skeleton + seam claims + gate framing. Each owner
ratifies-or-falsifies the seams it touches BEFORE moving its first card to
doing, then authors its lane. Claims are hypotheses — falsify with evidence.

## Scope (build items — the tractable cluster)

**Subgraphs first** (Cole wants it testable). Then the rest. Explicitly NOT this
round (own later proposals): media/images (#1), live force view (#7),
multi-agent runtime (#9).

1. **Subgraphs / node-anchored submaps** (drive-2 #8 / drive-3 #6 / drive-4) —
   headline.
2. **Select-connected** (#3) — surface.
3. **Shared-connection spotlight lens** (#4, RULED) — surface.
4. **Intent-composer affordances** (#8): human add-node (#5), drag-to-connect
   (#6), zone-create affordance — mostly surface (human authoring) + a
   casting-draft behavior clause.
5. **ESC-button bug** (#11) — surface, trivial.
6. **CLI: batch-propose + message-read** (#10) — engine.
7. **Activity stall-window widening** (#2) — engine, tuning.

## Integration order

P1 engine (SG1 submap model + CLI1 batch/read + SW1 stall-window) alongside
surface P1s with no engine dep (SC select-connected, SL spotlight lens, ESC fix
— all read existing state). → P2 surface consumes the submap wire (SG2
enter/exit/breadcrumb/badge) + IC intent-composer affordances. → P3 cold gate.

## Shared interfaces — ratify on the vine, then fill

### Claim SG1 — submap engine model (CLAIM — awaiting daedalus)

Node-anchored containment, additive + doctrine-safe:

- `ADDITIVE_COLUMNS.nodes = ["anchor_node_id"]` (nullable TEXT; a node's parent
  in the submap tree). Legacy rows null = top-level. NOT on proposals (a
  proposal ratifies into a node, THEN can be anchored) — or is anchor set at
  ratify? **Owner to rule**: simplest is anchor is a property of real nodes
  only; proposals are always top-level until ratified, then `node anchor` moves
  them in.
- `/state?anchor=<nodeId>` scopes the snapshot to that node's submap: nodes
  whose `anchor_node_id === nodeId`, the edges among them, AND the anchor node
  itself (as context/breadcrumb root). No anchor param = top-level view (nodes
  with null anchor) OR the full graph — **owner to rule** (lean: top-level =
  null-anchor nodes, so submaps nest cleanly; a separate `?all` for the flat
  everything view).
- Verb: `node anchor <nodeId> --to <parentId> | --clear`; endpoint
  `POST /nodes/:id/anchor {parentId|null}`. Guard: no cycles (a node can't be
  its own ancestor), no self-anchor.
- Wire: `state.nodes[].anchorNodeId` + a derived `submapChildCount` (so the
  surface can badge "has submap" without a second query).
- Event: `node.anchored {nodeId, anchorNodeId}` (new EventKind member).
- Zones orthogonal (anchor is independent of zone_id); resolves the open
  question — a ratified zone's nodes can be `node anchor`'d under an anchor.

### Claim SG2 — submap surface navigation (CLAIM — awaiting circe)

- "Enter submap" via double-click an anchor node OR context-menu item → canvas
  re-scopes via `/state?anchor=` (or a client-side filter on anchorNodeId —
  **owner to rule**: server-scoped is honest at scale, client filter is cheaper;
  lean server-scoped reusing the lens/scope machinery).
- **Breadcrumb** back up (anchor → parent → … → root); the anchor node renders
  as the submap's root/context.
- Create-into-submap: a node created while inside submap X gets `anchor=X`.
- Anchor nodes badge "has submap" (submapChildCount > 0) — a folder affordance.

### Claim SC — select-connected (CLAIM — awaiting circe; engine no change)

NodeContextMenu gains "Select connected": union the node's depth-1 neighbor ids
into `selectedIds`. Computed client-side from `state.edges` (no engine call
needed — daedalus ratifies no-change). Nodes only (edges-in-selection is a
follow-on).

### Claim SL — spotlight lens (CLAIM — awaiting circe; engine no change)

A new lens mode: given 2+ selected node ids, compute the intersection (common
depth-1 neighbors) client-side from `state.edges`; dim everything to low opacity
except the selected nodes, their shared neighbors, and the joining edges. Fits
the existing lens/visibleMap machinery (doc-lens/node-lens precedent). Pure
surface — daedalus ratifies no engine change. Heat mode + promote-to-overlap are
follow-ons (out of scope).

### Claim IC — intent-composer affordances (CLAIM — awaiting circe + daedalus)

Human-authoring gestures, each bottoming out in EXISTING daemon capability (the
drive-4 #8 principle — the UI composes; intelligence stays with the agent, but
the mechanical create is human authoring where no intelligence is needed):

- **Add-node** (#5): right-click canvas → free-text modal (dictation-friendly) →
  creates a **human-authored node proposal** at the click position with the raw
  text (Track A human-authoring path). Its `proposal.added` event IS the agent's
  refine signal (no separate message) — casting-draft documents the agent
  behavior: on a raw human node proposal, refine draft + propose edges.
- **Drag-to-connect** (#6): React Flow onConnectEnd over the pane → same modal →
  creates the human node proposal AND a human-authored edge proposal
  source→newNode (unlabeled; agent labels at refine). Fixes the dead drag.
- **Zone-create affordance**: multi-select → "Group into zone (name…)" → calls
  existing `zone create` + moves the selected proposals in (mechanical, no agent
  intelligence → direct human authoring). Closes the drive-3
  first-zone-agent-only gap.
- **daedalus ratifies**: do these need ANY new endpoint, or do the existing
  propose/zone endpoints accept human-authored writes as-is? (Track A built
  human proposal authoring; expected no-change — owner confirms.)

### Claim CLI1 — batch-propose + message-read (CLAIM — awaiting daedalus)

- **Batch propose**: `propose --stdin` (or `propose-batch`) accepting
  `{nodes:[{ref,draft,suggestedTier,evidence}], edges:[{draft:{source,target, label},…}]}`
  where an edge's source/target may be a **local ref** (e.g. "n1") resolved to
  the just-minted id server-side in one transaction. Returns the ref→id map.
  Kills the N-subprocess casting script (finding #10). Emits the normal
  per-proposal events.
- **message-read**: `read <messageId>` / `message <id>` → full message JSON
  (grapevine `read` precedent), so the casting agent stops scraping the tail
  log.

### Claim SW1 — stall-window widening (CLAIM — awaiting daedalus)

The auto-`received`→`stalled` grace is too tight (60s; false-fired twice in
drive #4 during normal agent deliberation). Widen the AUTO path grace
(`MIND_MAPPER_ACTIVITY_TTL_MS` default 60s → propose ~150s) while keeping the
explicit stall path unchanged; OR gate escalation on tail-liveness (a connected
tail = not stalled) — **owner to rule** (lean: widen default + keep it env
tunable; the liveness-gate is more correct but bigger). Update presence.test.ts.

## Slices

- **daedalus** — SG1, CLI1 (batch-propose + read), SW1; Contract 9 R5
  amendments; casting-draft updates (submap verbs, batch-propose shape, the
  refine-a-human-node behavior, message-read). Lane `plan/daedalus-r5.md`.
- **circe** — SC, SL, ESC fix (P1); SG2, IC (P2). Lane `plan/circe-r5.md`.
- **cassandra** — P3 cold drive off the amended casting draft: enter/exit a
  submap + create-into-submap; select-connected; spotlight lens; human
  add-node + drag-connect + zone-create; batch-propose; message-read; stall
  window. Two-round gate shape stands.

## Verification gate

984+ tests stay green; mind-mapper tsc-clean; every new wire shape in Contract 9
BEFORE P2 consumes it (the zero-wire-guess bar, held two rounds running);
casting-draft amended for submaps + batch-propose + human-node-refine so the
gate drives off the doc.

## Asserted ABSENT

No media/images, no force-view render mode, no multi-agent runtime, no derive
layer this round. No new persistence beyond `nodes.anchor_node_id`. Zones
unchanged (anchor is orthogonal to zone_id). Spotlight lens is intersection only
(no heat, no promote-to-overlap). Select-connected is depth-1 nodes only.

## Ratified decisions & lead rulings

Both owners ratified with measured repros (daedalus
`2026-07-21-r5-ratify-repro.ts` + `-cli1-repro.ts`, ALL PASS; circe against live
components). Single-sourced here; Contract 9 R5 amendments are daedalus's to
write BEFORE circe P2 consumes any wire.

- **SG1 AMENDED — both owners independently falsified the skeleton's
  null-anchor/`?all` scoping** (both cited the R3 zones precedent). Adopted:
  default `/state.nodes[]` stays INCLUSIVE, every node tagged `anchorNodeId` (as
  `proposals[]` carry `zoneId`); top-level = `anchorNodeId == null`; edges
  filter by both-endpoints-visible; NO `?all`. `/state?anchor=<id>` is a
  server-side CLI/agent narrow, NOT the surface path. `submapChildCount`
  server-derived on every node. `ADDITIVE_COLUMNS.nodes = ["anchor_node_id"]`.
  Strict tree (one anchor); orthogonal to zone_id. Anchor is real-nodes-only —
  proposals stay top-level until ratified; `ratify()` UNCHANGED. Cycle guard =
  ancestor-walk + defensive `seen`. `POST /nodes/:id/anchor {parentId|null}` +
  CLI `node anchor`. `node.anchored` new THIN EventKind.
- **SG2 AMENDED — circe falsified the server-scoped lean; RULED client-side**
  (zones precedent: inclusive + client-derive, no refetch). Submap view = client
  derive `filter(anchorNodeId === activeAnchor)` slotting between zone and lens;
  `activeAnchor` view-local. Enter via `onNodeDoubleClick`/NodeCommand;
  breadcrumb = client parent-walk (which server-scoping would hide — the
  clincher); badge from `submapChildCount`; create-into-submap tags
  `activeAnchor` post-ratify.
- **SL RULED surface-only; "fits lens machinery" FALSIFIED** — the lens hides,
  the spotlight dims. Intersection computed client-side from `boardMap.edges`;
  reuse the search-dim idiom for nodes on its OWN dim channel (not
  `highlightIds`); NEW edge-dim plumbing in GraphCanvas is the real cost.
  Map-view only. Heat/promote out of scope.
- **SC RULED surface-only** — union depth-1 neighbors
  (`lensSet(boardMap, id, 1)`) into `selectedIds` over the active boardMap.
  Nodes only.
- **IC RULED — zero new endpoints for (a)/(b); one small add for (c):** (a)
  add-node = right-click-pane → free-text modal →
  `proposeAsUser("node", author:"user")`; DROP "at click position"
  (placement-honesty ratified — positioned by layout); retire the old pane
  double-click form. (b) drag-connect = bind `onConnectEnd` → chain
  node-proposal then edge-proposal with `target` = the new proposal id
  (pending-endpoint pattern); needs `proposeAsUser` to return the id (daedalus
  confirms `POST /proposals` carries it), or one `propose-batch` call. (c)
  zone-create = empty-zone affordance now (`createZone`, zero change); for
  group-selected-in, **daedalus adds `POST /proposals/:id/zone {zoneId|null}`**
  (inverse of promote — completes the in-door), CLI to match.
- **SW1 RULED WIDEN, liveness-gate REJECTED** (daedalus: a connected tail proves
  transport not agent liveness — a hung agent keeps its tail open). Split the
  knob: new `MIND_MAPPER_STALL_TTL_MS` (default 150000) for `received→stalled`;
  `MIND_MAPPER_ACTIVITY_TTL_MS` (60000) still governs `thinking→idle`. Update
  presence.test.ts.
- **CLI1 RULED (measured atomic)** — `POST /proposals/batch` +
  `propose-batch --stdin` taking
  `{nodes:[{ref,draft,tier,evidence}], edges:[{draft:{source,target,label}}]}`;
  mint→refToId→insert in one `db.transaction()`, resolve endpoints via
  `refToId.get(x) ?? x`, return ref→id map, emit `proposal.added` after commit
  (no new event kind; local refs never persist). `GET /message/:id` +
  `read`/`message` verb (404 unknown). Keep single propose verbs.
- **ESC (bug #11) RULED** — the `<kbd>esc</kbd>` has no onClick; Escape handler
  lives only on the input. Fix: make the kbd a real Button (clear+blur) AND lift
  Escape to a window-level handler.
- **Gesture cleanup** (circe): node double-click = enter submap; pane
  right-click = add-node; retire the pane double-click structured form.
- **Open questions closed**: submap = strict tree; top-level = inclusive-tagged
  (no `?all`); add-node = direct human proposal positioned by layout.

## Build order (post-ratify)

- **daedalus P1** (engine, additive): SW1 → CLI1 → SG1 +
  `POST /proposals/:id/zone` (IC-c). Contract 9 R5 amendments per item, landed
  BEFORE circe P2. casting-draft: `node anchor`, `propose-batch`,
  `read`/`message`, refine-a-human-node behavior, submap semantics.
- **circe P1** (parallel, no engine dep): ESC → SC → SL (edge-dim plumbing is
  the real work).
- **circe P2** (after daedalus + Contract 9 R5): SG2 (client derive) → IC
  (a/b/c).
- **cassandra P3**: cold drive off the amended casting draft; two-round shape.
