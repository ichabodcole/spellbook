# mind-mapper Round 6 — plan skeleton (drive-5 fixes + tooling + UX)

**Status: SKELETON — seams awaiting owner ratify.** Lead: prospero. Seats:
daedalus (engine), circe (surface), cassandra (gate). Source:
`drive5-findings.md` triage (Cole "Sounds good"). Branch:
`feature/mind-mapper-round6`, cut from develop @ 4e4571f.

## How this plan is authored

Prospero owns the skeleton + seam claims + gate framing. Each owner
ratifies-or-falsifies its seams BEFORE moving its first card to doing, then
authors its lane. Claims are hypotheses — falsify with evidence.

## Scope (the drive-5 cluster)

Bugs first, then tooling, then UX. Explicitly NOT this round: images (Round 7,
`proposal-images.md`), force view, multi-agent runtime.

**Bugs:** #8 edge-follows-ratify · #5 canvas batch-render · #3 rejected-lingers

- long-title menu. **Tooling:** #10 ratify-batch + `ratify --anchor` · #7 node
  deletion. **UX:** #1 add-node processing phase · #4 ingestion queue · #6 human
  submap-create affordance. **Doc:** #2 context-doc facilitator touchpoint
  (casting-draft/skill guidance — lead).

## Integration order

P1 engine (RB ratify-batch, DEL deletion) + surface bug-fixes with no engine dep
(EF edge-follows-ratify, RENDER batch-render, REJECT+MENU) — parallel. → P2
surface consumes RB/DEL wire + the UX cluster (PROC processing phase, QUEUE
ingestion tray, SUBMAP-CREATE affordance). → P3 cold gate.

## Shared interfaces — ratify on the vine, then fill

### Claim RB — ratify-batch + ratify --anchor (CLAIM — awaiting daedalus)

`POST /proposals/ratify-batch` + CLI `ratify-batch --stdin` taking an ordered
set (or {nodes:[ids], edges:[ids], anchors:[{nodeRef,parentRef}]}); ratify nodes
first (mint ids), then edges (resolve endpoints to minted ids via the existing
result_node_id path), optionally apply anchors — all in one transaction —
returning the **old→new id map**. Mirrors propose-batch's atomicity +
emit-after-commit (per-proposal `node.ratified`/`edge.ratified` events). Also
`ratify <id> --anchor <parentId>` (ratify-and-nest one-step). Owner: rule the
input shape (id-list vs full spec) + whether edges auto-include when both
endpoints are in the node set.

### Claim DEL — node/proposal deletion (CLAIM — awaiting daedalus + circe)

Hard delete for the human AND agent (equal-capabilities), the missing retract:
`DELETE /nodes/:id` + `DELETE /proposals/:id` + CLI `node delete` /
`proposal delete`; emit `node.deleted` / `proposal.deleted` (thin) events the
reducer + agent consume. **Provenance-aware** (mirror doc-delete's CitedError):
deleting an anchor node with a submap → guard/cascade ruling; deleting a node
with edges → cascade the edges or 409 with the citing set. Rejected proposals
also become deletable (subsumes part of #3). Owner: rule cascade-vs-guard for
anchors + edges.

### Claim EF — edge-follows-ratify (CLAIM — awaiting circe; engine no change)

Finding #8. When a node proposal ratifies, its still-pending edge proposals
reference the OLD proposal id and dangle → vanish. The
`node.ratified {proposalId → nodeId}` event already reaches the reducer; the
surface must **re-point** a pending edge's endpoint from the ratified proposal
id to the minted node id so the edge keeps rendering (as a pending edge to a
now-real node). Engine: no change (daedalus ratifies — the mapping is on the
event; ratify already resolves endpoints at edge-ratify time). Surface-only.

### Claim RENDER — canvas batch-render fix (CLAIM — awaiting circe; engine no change)

Finding #5. A `propose-batch` burst of `proposal.added` events drops earlier
canvas nodes from view (grid unaffected → not the derive). Make the canvas
layout re-run deterministically over the FULL visible node set on any pending
change (fix the layout effect's stale-closure / dependency). Surface-only.

### Claim REJECT+MENU — rejected-lingers + long-title menu (CLAIM — awaiting circe)

Finding #3. (a) Rejected proposals stay in `/state` and the canvas draws them —
exclude `status !== "pending"` from the pending overlay (or drop on a reject
event); once DEL lands, rejected can also be hard-deleted. (b) The node context
menu spans the full page on a long title — clamp menu width (max-w) +
truncate/line-clamp the title in the menu header; truncate long titles on the
node card. Surface-only.

### Claim PROC — add-node processing phase (CLAIM — awaiting circe + daedalus)

Finding #1. A human add-node should NOT instantly render as a finished full-text
node. It enters a **processing** state (distinct rendering — spinner/"agent is
curating", raw text provisional), the agent refines, and the curated node
replaces it **in place**. Load-bearing: the free-text box is a COMMAND channel
(the raw text may be an instruction → the agent executes it, producing
doc+nodes+threads, and the raw item resolves away). Owner split: is "processing"
a client-only visual on the pending `author:"user"` proposal (surface-only), or
does it want an engine `processing` status flag on the proposal so it's
authoritative + agent-legible? Lean: a proposal `author:"user"` +
not-yet-agent-touched IS the processing signal (surface renders it distinctly;
no schema change) — daedalus confirms or adds a flag.

### Claim QUEUE — ingestion queue/tray (CLAIM — awaiting circe + daedalus)

Finding #4. A human firing several adds in succession needs a **processing
tray** — the raw/processing items visualized as "being ingested, not on the
board yet," decoupled from the canvas; each lands + leaves the tray as the agent
finishes. Serial for one agent; **designed as the work-list a future agent fleet
drains** (drive-4 #9 — don't build single-agent-only). Owner: is the tray a pure
client view over `author:"user"` un-refined proposals (surface-only), or a
first-class engine queue construct? Lean: client view now, but name the
work-queue seam so multi-agent is a drop-in. daedalus rules whether any engine
queue state is needed.

### Claim SUBMAP-CREATE — human submap-create affordance (CLAIM — awaiting circe; engine no change)

Finding #6 (the zone-gap pattern). Select nodes → "group under <node> as a
submap" (or "anchor these under X") → the surface issues the anchors via the
existing `POST /nodes/:id/anchor` (per-node; or one ratify-batch anchor set).
Engine: no change (anchor endpoint exists — daedalus ratifies). Surface-only
intent-composer gesture.

## Slices

- **daedalus** — RB (ratify-batch + `ratify --anchor`), DEL (delete endpoints +
  events + provenance guards); PROC/QUEUE engine rulings (flag or none);
  Contract 9 R6 amendments; casting-draft (ratify-batch, delete, the
  refine-a-human-node processing semantics). Lane `plan/daedalus-r6.md`.
- **circe** — EF, RENDER, REJECT+MENU (P1); PROC, QUEUE, SUBMAP-CREATE, DEL
  surface (P2). Lane `plan/circe-r6.md`.
- **cassandra** — P3 cold drive: ratify-batch (node+edge set, one call, old→new
  map, atomicity), ratify --anchor, node/proposal delete + provenance guard,
  edge-follows-ratify (ratify a node, its pending edge stays attached),
  batch-render (batch-add onto a populated canvas), rejected-leaves-canvas,
  long-title menu clamp, add-node processing state, ingestion tray,
  submap-create. Two-round gate shape.

## Verification gate

1038+ tests green; mind-mapper tsc-clean; every new wire shape in Contract 9
BEFORE P2 consumes it (the zero-wire-guess bar, held three rounds);
casting-draft amended (ratify-batch, delete, processing semantics, the #2
context-doc facilitator touchpoint prose — lead).

## Asserted ABSENT

No images (Round 7), no force view, no multi-agent runtime, no derive layer. No
new persistence beyond DEL's deletes + (maybe) a processing flag. Anchor/zone
mechanics unchanged (SUBMAP-CREATE reuses the existing anchor endpoint).

## Ratified decisions & lead rulings

Both owners ratified with measured repros (daedalus `r6-repro.ts`; circe against
live components). **Both independently surfaced the root cause of finding #3:
reject emits NO bus event** (ratify.ts:109-114) — that's why rejected nodes
linger. Rulings single-sourced here; Contract 9 R6 amendments are daedalus's to
write BEFORE circe P2.

- **RB AMENDED (mechanism correction — the propose-batch lesson again):**
  `ratify()` can't loop in a txn as-is (inline emits + `appendFileSync`
  changelog + `--doc-edit` fs writes leak on rollback). **Extract
  `buildRatify`** (validate + anchorGuard + a db-only `apply()` + the changelog
  line + a deferred `emit()`) exactly as `buildProposal` was extracted; single
  `ratify()` keeps inline behavior.
  `POST /proposals/ratify-batch {ruling, ids:[proposalId], anchors?:[{node,parent}]}`
  → `{idMap:{old→new}, ratified:[...]}`; engine **auto-partitions** (nodes
  ratify before edges — no caller ordering), **NO auto-include** of unlisted
  edges (explicit only — no silent ratifications), one top-level `ruling`
  (`ids:[{id,ruling?}]` is an additive future), `anchors[]` refs resolve via
  idMap then real node ids, anchorGuard per anchor before the txn. All `apply()`
  in one `db.transaction()`; changelog appends +
  `node.ratified`/`edge.ratified`/`node.anchored` emits AFTER commit; the idMap
  IS the collected per-proposal `{proposalId→nodeId}`.
  `ratify <id> --anchor <parent>` = the single-call twin (node-proposals only).
  Reject excluded from batch. Atomicity test: throwing batch → zero rows /
  events / changelog lines.
- **DEL RATIFIED — guard-with-force, children re-parent (not cascade-delete):**
  `DELETE /nodes/:id[?force=1]` → typed `NodeCitedError` 409
  `{error:"cited", citedBy:{edges:n, children:n}}` when unforced+cited (edges +
  anchored submap children are the citing set the confirm dialog renders).
  `force` cascades: delete both-direction edges, **re-parent children to
  top-level (clear anchor_node_id — do NOT recursively delete the submap; the
  children are real ratified knowledge)**, delete owned detritus
  (sources/message_sources/node_actions), clear a lens pointing at it; leave the
  ratified proposal's `result_node_id` history-intact (doc-delete precedent).
  `DELETE /proposals/:id` = **thin, no guard** (a dependent pending edge lives
  only in opaque draft_json and already fails safe at its own ratify; drop row +
  cascade node_actions). Both equal-capability (human + agent); events
  `node.deleted`/`proposal.deleted` (thin) — new EventKinds. Rejected AND
  pending proposals both deletable → the litter-clearing path (route "clear my
  raw node" through DELETE, not reject).
- **REJECT RECLASSIFIED — (a) is NOT surface-only (both owners caught my
  mis-scope).** The daemon emits nothing on reject, so the human's board never
  learns of an agent-side reject. **Ruling: daedalus adds a thin
  `proposal.rejected {id}` event** (fold into the DEL event family); circe's
  reducer drops/flips it. This makes reject live (leaves the canvas without
  refetch) — the proper fix for finding #3(a). Keep reject
  (declined-with-history) distinct from DELETE (hard remove); both now emit. (b)
  long-title menu = surface-only (max-w on the Popup + line-clamp the label +
  truncate the node-card title).
- **PROC RATIFIED client-only — NO engine flag in R6 (daedalus's lean over
  circe's add-the-flag).** A pending `author:"user"` proposal IS the processing
  signal (surface renders it distinctly — "curating"/spinner — off `author`
  which is already on the wire). Refine-in-place = the agent **DELETEs the raw +
  proposes the curated** (remove+add; DEL makes this clean now — there is no
  proposal-edit endpoint, and R6 doesn't add one). Drain is observable via
  ratify-OR-delete (both fire events). The `processing`/`claimed_by` engine flag
  is deferred to the multi-agent round (see seam below) — YAGNI now that DEL
  makes drain observable and the just-add-straight ambiguity is parked. Circe's
  authoritative-flag concern noted for that round.
- **QUEUE RATIFIED client-view — zero engine state R6.** New `IngestionTray`
  panel fed by a pure `state/ingestionQueue.ts → processingItems(proposals)` =
  pending author:"user" proposals, decoupled from the canvas; an item leaves on
  ratify-or-delete. **NAME the seam** for the multi-agent drop-in: a future
  additive-nullable `proposals.claimed_by TEXT` (+ thin `proposal.claimed`
  event) — the ONE field PROC, QUEUE, and the drive-4 #9 fleet-lease all share
  ("who is refining/leasing this item"). Not built in R6; named so it's a
  drop-in.
- **EF RATIFIED surface-only (mechanism corrected by circe):** the reducer does
  NOT need a proposalId→nodeId map from events — the post-ratify snapshot
  already carries `resultNodeId` on ratified proposals (R5 wire). Build the map
  in `App.mapWithPending` from `state.proposals[].resultNodeId`; **re-point**
  `source`/`target` in `pendingOverlay.pendingEdgesFrom` through it before the
  drop-filter. Surface `resultNodeId?: string` on the `Proposal` type. No engine
  change.
- **RENDER RATIFIED surface-only (diagnosis sharpened):** not a stale closure —
  the layout effect blindly `setNodes(layout(...))` on every `map` change,
  racing React Flow's async ResizeObserver `onNodesChange` across a burst. Fix:
  **merge-by-id** in the layout effect (preserve positions for known ids, place
  new ids, drop departed) instead of wholesale replace — deterministic over the
  full set, and a bonus fix for clobbered drag positions. `GraphCanvas.tsx`
  ~388.
- **SUBMAP-CREATE RATIFIED surface-only (two corrections):** (1) the surface
  calls anchor NOWHERE today — this is a net-new `POST /nodes/:id/anchor` fetch
  (per-node, or RB's `anchors[]`); (2) anchor is **real-nodes-only** — the
  gesture scopes to **ratified** nodes + a ratified parent (opposite of the
  group-into-zone pending scope). Reuse the group-into-zone modal chassis. The
  **pending-selection** case ("group these pending proposals under X") composes
  via **RB's ratify-then-anchor** (`anchors[]`) — a clean composition, defer to
  it.
- **DEL-surface RATIFIED:** Delete item in `NodeContextMenu`; reducer drops on
  thin `node.deleted`/`proposal.deleted` (mirror the existing `doc.deleted`
  filter). Existing App view-heal effects (submap-anchor-gone,
  selection-by-presence) self-heal on delete.
- **Contract 9 R6 additions:** ratify-batch req/resp + idMap; `node.deleted` /
  `proposal.deleted` / `proposal.rejected` EventKinds (3 new, keep union total);
  `resultNodeId` on the proposal wire (already emitted per R5 — surface the
  type); the deferred `claimed_by` work-queue seam (named, not built).
- **#2 context-doc facilitator touchpoint** → casting-draft prose (daedalus
  amends casting-draft anyway; fold it in): guidance that on node creation the
  agent decides, as facilitator, whether background research earns its own
  context doc (subject nodes tend to; thread nodes don't) — optional,
  agent-judged, not one-per-node.

## Build order (post-ratify)

- **daedalus P1:** (1) extract `buildRatify` (re-green ratify.test.ts) → (2)
  **RB** ratify-batch + `ratify --anchor` → (3) **DEL** node/proposal delete +
  guards + `node.deleted`/`proposal.deleted` + the **`proposal.rejected`** event
  (RB and DEL parallel after buildRatify). Contract 9 R6 amendments per item
  BEFORE circe P2; casting-draft (ratify-batch, delete,
  refine-via-delete-and-repropose, #2 touchpoint).
- **circe P1** (no engine dep): **EF** (resultNodeId re-point) · **RENDER**
  (merge-by-id) · **MENU(b)** (clamp). [REJECT(a) reducer waits for daedalus's
  `proposal.rejected` → P2.]
- **circe P2** (after daedalus + Contract 9 R6): **DEL-surface** · **REJECT(a)**
  reducer · **PROC** (distinct render) · **QUEUE** (IngestionTray) ·
  **SUBMAP-CREATE** (ratified-nodes gesture).
- **cassandra P3:** cold drive off the amended casting draft; two-round shape.
