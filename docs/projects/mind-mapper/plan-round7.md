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

(fills at ratify)

## Open questions

- TAGS storage: reuse the `node_actions`-shaped target-keyed table pattern (so
  pending proposals carry tags + re-home on ratify like actions), or a column?
  (lean: target-keyed table, mirrors A1 actions exactly.)
- BACKLINKS: client-derive only, or also an agent-facing `doc <id>` read-field?
  (lean: client-derive for UI; add read-field only if the casting agent needs
  it.)
- FILTER semantics: within a facet OR, across facets AND? (lean: AND across
  facets, OR within — standard faceted search.)
