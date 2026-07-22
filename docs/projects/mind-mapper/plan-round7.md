# mind-mapper Round 7 — plan skeleton (metadata, filter & polish)

**Status: SKELETON — seams awaiting owner ratify.** Lead: prospero. Seats:
daedalus (engine), circe (surface), cassandra (gate). Source:
`drive6-findings.md` triage (Cole "close out and implement"). Branch:
`feature/mind-mapper-round7`, cut from develop @ b5c99c8.

## How this plan is authored

Prospero owns the skeleton + seam claims + gate framing. Each owner
ratifies-or-falsifies its seams BEFORE first doing, then authors its lane.
Claims are hypotheses — falsify with evidence.

## Scope (drive-6 metadata/filter/polish cluster)

Explicitly NOT this round: the async job queue (#3 — its own round next), images
(queued), force view, multi-agent runtime.

**Data+view:** #1 tags (controlled folksonomy) + #8 faceted filter. **Bug:** #7
ratify tier-picker (+ casting-draft tier-vocab fix). **Polish:** #2 directional
select · #6 backlinks · #9 markdown doc-view · #5 submap-create-on-pending · #4
stable-port.

## Integration order

P1 engine (TAGS model + PORT) + surface no-engine-dep fixes (RATIFYFIX,
DIRSELECT, MDVIEW, BACKLINKS) — parallel. → P2 surface consumes TAGS wire (tag
chips/add + FILTER tag facet) + SUBMAPPEND. → P3 cold gate.

## Shared interfaces — ratify on the vine, then fill

### Claim TAGS — node tags, agent-curated (CLAIM — awaiting daedalus + circe)

Nodes gain freeform **`tags: string[]`** (additive column, json-encoded like
`node_actions`). `propose-node` / `propose-batch` accept optional `tags`;
`PUT /nodes/:id/tags` (wholesale array, like actions) + CLI
`node tags <id> --set <json> | --clear`; also applies to a PENDING proposal
(target-keyed like actions — a proposal carries tags pre-ratify, re-home on
ratify). Wire: `tags` on `state.nodes[]` AND `state.proposals[]`.
`tags.set {targetId, tags}` event. FREEFORM (no enforced vocab). Agent-curated
is a SURFACE concern (reuse-suggestion = autocomplete over existing tags; the
engine just stores strings). Owner (daedalus): rule storage (own table vs column
vs reuse node_actions-shaped table) + the pending/re-home lifecycle (mirror A1
actions).

### Claim FILTER — faceted metadata filter (CLAIM — awaiting circe; engine no change)

A filter control (Status / Tier / Tags) narrowing the visible map (HIDE
non-matching — a filter, distinct from spotlight's dim). Status
(pending/ratified/rejected) + Tier (canon/thread/story-local) are ALREADY on the
wire (zero engine); Tags facet consumes TAGS. Composes with the lens/visibleMap
algebra (submap, zone, spotlight). Surface-only. Status-filter is the cheapest
first cut (pure client derive over `status`).

### Claim RATIFYFIX — ratify tier-picker fallback (CLAIM — awaiting circe; + lead casting-draft)

Finding #7. `ratifyAs = ACCEPT_RULINGS.has(suggestedTier) ? … : null` leaves a
proposed node with an unrecognized tier (e.g. the mis-used "cast") with NO
ratify action — a dead end. Fix: when suggestedTier isn't a valid ruling, the
menu shows a **"Ratify as → canon / thread / story-local" submenu** (human
picks) instead of hiding the action; the one-keystroke ratify stays when the
suggestion IS valid. Surface-only. **Lead (prospero): fix casting-draft** — the
tier vocabulary is `canon | thread | story-local`, NOT "cast" (my casting error;
document it so the agent stops emitting invalid tiers).

### Claim DIRSELECT — directional select (CLAIM — awaiting circe; engine no change)

Finding #2. NodeContextMenu gains **"Select children"** (depth-1 OUTGOING) and
**"Select parents"** (depth-1 INCOMING) alongside "Select connected" (both),
computed from directed `boardMap.edges` (reuse `neighborhood.ts`, filter by edge
direction). Distinct from submap-anchor nesting (edge-direction only).
Surface-only.

### Claim BACKLINKS — doc "referenced by" (CLAIM — awaiting circe; engine no change unless read-field)

Finding #6. The doc viewer shows a **"Referenced by"** section = nodes/proposals
whose `evidence.docId === thisDoc`. Pure DERIVATION from state (client-side; the
forward links already exist) — no stored backlink, auto-maintained by
construction. Distinguish ratified vs pending. Surface-only (optional: fold
backlinks into the agent-facing `doc <id>` read — daedalus rules if worth it).

### Claim MDVIEW — markdown doc rendering (CLAIM — awaiting circe; engine no change)

Finding #9. The context-doc viewer renders content as **markdown** (reuse the
chat's micromark renderer + the TreeWalker span-flash so the evidence-span
highlight/jump still lands on rendered output — chat already solved this).
Surface-only.

### Claim SUBMAPPEND — submap-create on pending (CLAIM — awaiting circe; uses R6 ratify-batch)

Finding #5. Extend SUBMAP-CREATE (R6, ratified-only) to a **pending selection**:
"group these into a submap under X" ratify-then-anchors via R6's `ratify-batch`
`anchors[]` (atomic ratify+nest). Plus the **"empty submap under a node"**
gesture (make X a container; new nodes created "inside" get anchor=X — SG2
activeAnchor). Surface-only (ratify-batch endpoint exists).

### Claim PORT — stable daemon port (CLAIM — awaiting daedalus)

Finding #4. A `--port <n>` flag so a drive daemon binds a STABLE port → a
browser refresh reconnects after an environment-reap + restart (today the port
changes → the surface can't self-heal). Small; server.ts arg parse + bind.

## Slices

- **daedalus** — TAGS engine (storage + propose/verb/event/wire, pending +
  re-home lifecycle), PORT flag, (optional) BACKLINKS read-field; Contract 9 R7
  amendments; casting-draft (tags + the RATIFYFIX tier-vocab correction). Lane
  `plan/daedalus-r7.md`.
- **circe** — RATIFYFIX, DIRSELECT, MDVIEW, BACKLINKS (P1); TAGS surface
  (chips/add/reuse-suggest) + FILTER + SUBMAPPEND (P2). Lane `plan/circe-r7.md`.
- **cassandra** — P3 cold drive: tags (propose w/ tags, set/clear, pending +
  re-home on ratify), filter (status/tier/tag), ratify tier-picker, directional
  select, backlinks, markdown view, submap-create-on-pending, stable-port.
  Two-round gate shape.

## Verification gate

1087+ tests green; mind-mapper tsc-clean; every new wire shape in Contract 9
BEFORE P2 consumes it (zero-wire-guess, held 4 rounds); casting-draft amended
(tags verbs + the tier-vocabulary correction).

## Asserted ABSENT

No job queue, no images, no force view, no multi-agent. No new persistence
beyond `tags`. Ratify mechanics unchanged (RATIFYFIX is menu-only). Filter HIDES
(distinct from spotlight DIM). Tags stay freeform (no vocab enforcement;
curation is surface-side suggestion).

## Ratified decisions & lead rulings

Both owners ratified with measured repros (daedalus scratch `daedalus-port*`;
circe against live components). All 7 surface claims + TAGS/PORT engine
ratified. Single-sourced here; Contract 9 R7 amendments are daedalus's to write
BEFORE circe P2 consumes the tags wire.

- **TAGS RATIFIED, storage AMENDED to a table (not a column):** target-keyed
  `node_tags (target_id TEXT PRIMARY KEY, tags_json TEXT NOT NULL)` — the exact
  twin of `node_actions` (a column on `nodes` can't hold a PENDING proposal's
  tags; the table gives pending-carry + re-home for free). **Route corrected:**
  `PUT/DELETE /tags/:targetId` (NOT `/nodes/:id/tags` — the target is a node OR
  pending proposal) + top-level CLI `tags <targetId> (--set|--stdin|--clear)`,
  twins of the actions verb. `tags.set {targetId, tags}` event (full array).
  Wire `tags?: string[]` on `state.nodes[]` AND `state.proposals[]` (absent =
  none). Re-home lifecycle mirrors actions at the named
  ratify/reject/edge-accept/delete/zone-delete sites; **critical:
  `readProposalById` MUST attach tags** (else IC-c's zone-move re-emit clobbers
  them — the full-shape-on-re-emit lesson). propose-batch:
  `BatchNodeInput.tags` + `buildProposal` writes the row in-txn + attaches to
  the emitted Proposal. FREEFORM (engine stores strings; agent-curation =
  surface autocomplete over existing tags).
- **PORT RATIFIED — server already binds `--port`; build is CLI-ONLY.**
  server.ts already parses `--port` (default "0"=ephemeral) + binds it. Build:
  `open` verb gains `--port`, forwards through `ensureDaemon` → spawn args.
  Documented wrinkles (benign for reap-resilience): `open --port N` against a
  LIVE daemon ignores N (returns existing); port-in-use → daemon exits 2, cli
  poll times out. The stable-URL-across-reap holds as long as the FIRST open set
  `--port`. Zero server change.
- **BACKLINKS read-field FALSIFIED → client-derive only, ZERO engine.** The
  agent already holds `/state` (every `nodes[].sources[].docId` +
  `proposals[].evidence.docId`); baking backlinks into `readDoc` duplicates
  derivable data (thin-read-path taste). Surface:
  `backlinksFor(docId, nodes, proposals)` derive + a "Referenced by" section in
  DocViewer (pass `nodes`/`proposals`/`onNavigate`; distinguish ratified vs
  pending). Revisit the read-field only if a context-budgeted
  read-without-/state path emerges.
- **FILTER RATIFIED (zero engine), slotting RULED:** a new `filteredMap` memo
  **terminal to the chain, AFTER `visibleMap`** (circe — filtering BEFORE the
  lens BFS would distort the neighborhood; after keeps the lens honest and rides
  R6 `mergeLayout` so positions/selection survive). Semantics **AND across
  facets, OR within** (standard). Wrinkles: there's **no literal `status`
  field** — the status facet derives from `n.pending`/`n.processing` (ratified =
  real node, pending = synthetic); **rejected never renders on the canvas**, so
  a "rejected" facet is moot there (drop it or grey it). Tier = `n.tier`. Tags =
  the wire.
- **RATIFYFIX RATIFIED (zero engine); FLAT fallback, not a submenu** (circe —
  the vendored context-menu has no Submenu primitive; three flat
  `ContextMenuItem`s "Ratify as canon/thread/story-local" gated on
  `author==="agent" && ratifyAs===null` is the lower-risk cut; growing the
  vendored Submenu is the alternative). **Lead casting-draft fix (mine):** kill
  `suggestedTier:"cast"`; AND — daedalus found a second trap — **"background" is
  listed as a tier in casting-draft:438 but isn't a valid ruling either** (same
  dead-end); clarify it's a steeping-context stance, not a suggestedTier. State
  the vocab explicitly: `canon | thread | story-local`.
- **DIRSELECT RATIFIED (zero engine):** "Select children" (OUTGOING:
  edge.source===id) / "Select parents" (INCOMING: edge.target===id) / "Select
  connected" (both), from directed `boardMap.edges` (directed `lensSet` siblings
  in neighborhood.ts). **Ruling on `direction:"both"` edges: they count for BOTH
  children AND parents** (a bidirectional edge makes the neighbor both).
- **MDVIEW RATIFIED (zero engine), NOT a drop-in:** the markdown DOM +
  TreeWalker span-flash is module-PRIVATE in `MessageBubble.tsx`
  (`AgentMarkdown`/wrap-unwrap). Extract it into a shared
  `<Markdown text highlightSpan>` component that BOTH MessageBubble and
  DocViewer consume; repoint DocViewer off its raw `<pre>`+hand-rolled
  highlight; trim DocViewer's now-redundant `normalize()` (leading-`#` strip +
  hard-unwrap) since micromark renders paragraphs.
- **SUBMAPPEND RATIFIED (zero engine):** the **pending-group case is the build**
  — select ≥2 pending proposals → pick a parent → the surface's FIRST
  `ratify-batch` call `{ruling, ids, anchors:[{node,parent}]}` (verified:
  anchors resolve pending-or-real via idMap; a single top-level `ruling` neatly
  sidesteps the RATIFYFIX per-proposal-tier problem — human picks the group's
  tier once). The **"empty submap under a node"** case is NOT pure surface
  (can't anchor a pending node; `enterSubmap` gates on `submapChildCount>0`) →
  it's the **intent-composer path** (agent ratify-then-anchors) — DEFER the
  standalone-surface version to the job-queue/intent-composer round; this round
  ships the pending-group case (the concrete need).

## Build order (post-ratify)

- **daedalus P1:** PORT (cli-only, ~20min) → TAGS (db `node_tags` → tags.ts twin
  of actions → state.ts attach on nodes+proposals+readProposalById → propose.ts
  tags on ProposeInput/BatchNodeInput+buildProposal → ratify.ts
  re-home/reject/edge sites → del.ts/zones.ts cascade → server.ts
  `/tags/:targetId` + propose passthrough → cli.ts `tags` verb → tests incl. db
  pinning + zone-move-keeps-tags). Contract 9 R7 amendment BEFORE circe P2.
  **casting-draft: kill "cast" + clarify "background", state tier vocab.**
- **circe P1** (no engine dep): RATIFYFIX (flat items) · DIRSELECT (directed
  siblings, both-counts-both) · MDVIEW (extract shared `<Markdown>`) · BACKLINKS
  (derive + DocViewer section).
- **circe P2** (after TAGS wire + Contract 9 R7): TAGS surface (chips own-row +
  detail + reuse-suggest autocomplete) · FILTER (filteredMap terminal memo;
  status-via-pending) · SUBMAPPEND (pending-group ratify-batch call).
- **cassandra P3:** cold drive off the amended casting draft; two-round shape.

## Open questions (closed)

- TAGS storage → target-keyed table (mirrors actions). BACKLINKS →
  client-derive, no read-field. FILTER → AND-across/OR-within, terminal memo
  after visibleMap.
