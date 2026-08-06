# Mind Mapper V1 — Plan Skeleton

**Status:** Seams RATIFIED (2026-07-16) — lanes authoring **Created:**
2026-07-16 **Lead:** prospero · **Owners:** daedalus (engine), circe (surface) ·
**Verify:** cassandra engages at the phase gates (not end-of-line)

From `proposal.md` (V1 scope + "Phase 0 Spike — Findings" roadmap). The spike is
merged to develop; V1 builds on its skeleton, wire baseline (seams Contract 7),
and vendored component layer.

## How this plan is authored

Prospero owns this skeleton — the integration order, the cross-seam contracts
(written as CLAIMS to falsify), and the verification gate. Each owner ratifies
the seams it touches **before moving its first card to doing**, then authors its
own lane (`plan/daedalus.md`, `plan/circe.md`) against the ratified seams.

## The load-bearing architectural claim (ratify first — it shapes every seam)

**CLAIM A — The daemon is a dumb state authority; ALL intelligence lives in the
casting agent.** No LLM calls inside the daemon. The daemon owns state (docs,
graph index, staging, conversation log, lens), serves it, and emits events; the
**casting agent** (the Claude session that cast the spell) tails events and does
everything intelligent — extraction, relate-checks, drafting doc edits,
conversation replies — via CLI verbs. This is the house co-presence pattern
(imago/glamour; board = ambient state pulled, agent events = intent bus) applied
as-is. **(RATIFIED — daedalus × circe, vine msgs 3/6)**

**CLAIM B — Storage split per the map-as-view + staging resolution.** Docs
(markdown files under the daemon's project dir,
`~/.mind-mapper/projects/<id>/docs/`) own all prose/knowledge; `bun:sqlite`
(same dir) owns the graph index (nodes/edges with doc+anchor provenance), the
staging store (proposals), the conversation log, and FTS5 search. Anchors are
whitespace-tolerant excerpts (seams Contract 6) in V1; offset-based source-log
is deferred. Rebuild semantics stated honestly: re-index from docs recovers
authored `[[wikilinks]]` and re-anchors stored claims; it does NOT re-run
extraction (that's agent work). **(RATIFIED — daedalus, vine msg 6;
honest-rebuild clause underlined: doc-rebuild is never claim-recovery)**

## Integration / dependency order

1. **P1 — Real state.** SQLite schema + project model + docs store; `/state`
   snapshot + WS event stream; core CLI verbs; surface rewired from stub fetch
   to live state (read path). _Gate: spike surface renders a real persisted
   project; kill/restart daemon loses nothing ratified._
2. **P2 — Ingest + conversation + staging.** Intake (brain-dump text, file
   drop, + new-doc) → source docs; conversation bus live (surface chat ⇆ agent);
   agent extraction loop (SKILL-draft-driven) → propose verbs → pending overlay
   live on the board. _Gate (cassandra): a real brain-dump becomes a pending map
   with provenance, driven end-to-end by a cold agent._
3. **P3 — Ratification + search + lens verbs.** Ratify write-path (rulings → doc
   writes + changelog); review-queue UI (batch, one-keystroke vocabulary);
   FTS5(+similar later) search wired to palette and agent verb; agent lens /
   look-here verbs. _Gate (cassandra): the full loop — ingest → map → converse →
   ratify → doc holds the sentence → restart → still true._
4. **P4 — Hardening + experiments.** Contract 1 release-mode (dist build via
   Contract 2); force-layout toggle (parked card); dogfood rounds (real
   brain-dump session; linked-Hollowbrook via Operator `extract_links` when
   their deploy lands — stretch, not gated on).

## Shared interfaces — ratify on the vine, then fill

### daedalus ↔ circe — V1 wire schema (RATIFIED — daedalus × circe)

Evolves StubMap v3 (Contract 7 baseline) additively. `GET /state` returns the
full project snapshot:
`{ project, docs[], nodes[], edges[], proposals[], conversation[], lens, cursor }`
— docs still content-free (content via `GET /doc/:id`, unchanged envelope). New:
**WS `/events`** pushing `{ seq, kind, payload }` incremental events
(`doc.added`, `node.ratified`, `proposal.added`, `message.posted`, `lens.set`,
…); the surface applies patches and falls back to snapshot refetch on gap.
Proposals are staging-tier objects
`{ id, kind: "node"|"edge", draft, evidence: {docId, span}, suggestedTier, status }`.

### daedalus ↔ casting-agent — CLI verb set (RATIFIED — daedalus, + `projects [--create]` added)

`open` / `state [--skeleton]` / `tail` (Monitor-shaped, self-echo-suppressed) /
`send <text>` (conversation) / `ingest --title T (--file P | --stdin)` /
`search <query>` / `neighbors <nodeId> [--depth 1]` /
`propose-node|propose-edge (--stdin JSON draft + evidence)` /
`ratify <proposalId> --ruling canon|thread|story-local|reject --doc-edit <file>`
/ `lens set|clear (--node --depth)` / `look-here <nodeId>`. Agent identity
stamped on events. Skeleton mode returns ids/titles/degree only (context
budgeting — landscape constraint).

### daedalus ↔ circe — ratification review queue (RATIFIED — daedalus × circe)

The review UI renders `proposals[]` grouped by source doc (batch-by-source, per
bobbin's ratification-UX spec); one-keystroke rulings post
`POST /proposals/:id/ruling`; **the doc edit itself is drafted by the agent**
(attached to the proposal as `draft`), so ruling = accept-the-draft, never
compose-in-UI. Reject requires no justification.

### daedalus ↔ circe — intake (RATIFIED — daedalus × circe)

Surface intake (drag-drop via the glamour/imago `fileIntake` pattern, brain-dump
textarea, "+ new document") all converge on `POST /ingest` (multipart or JSON) →
daemon stores the source doc, emits `doc.added` — and does nothing else.
Extraction is the agent reacting to the event (Claim A).

### prospero — casting SKILL draft (not a seam; asserting ABSENCE of one)

The V1 conversation loop needs a minimal casting doc (how the agent tails,
extracts, proposes, converses). Prospero drafts it; it is deliberately NOT the
shipped SKILL.md (that's coalescence work, thoth's when seated). No seat should
build against its wording.

## What is ABSENT in V1 (asserted so nobody hunts mirrors)

No Operator write-back (read-snapshot ingest only, and only if their deploy
lands — stretch). No embeddings/`similar` verb (FTS5 lexical only; sqlite-vec is
V2 — but the search verb's response shape should not preclude it). No
multi-agent team (single casting agent). No file versioning/diff engine (value
boundary ≈ C). No sub-maps. No mobile/remote access (localhost).

## Ratified decisions & edge cases

Standing rulings from the proposal apply (directed-claim edges; asserted/derived
never blended; tier read not owned; view-state never holds knowledge). Ratify
pass (2026-07-16, vine msgs 3–6) added:

- **Events are per-entity patches, never wholesale array replaces** (circe's
  applyNodeChanges addendum — hard constraint on every event kind); snapshot
  refetch is the sole gap-recovery path, daemon remembers only `cursor`.
- **Two transports, one bus:** browser gets `WS /events`; the agent's `tail` CLI
  verb wraps a resumable SSE-shaped `GET /events?since=<cursor>` — one `emit()`
  fans out to both, no duplicated logic.
- **Conversation log lives in SQLite** (`messages` table, in
  `/state .conversation`) and is **FTS5-indexed alongside docs** — search finds
  things _said_, not just things written.
- **`projects [--create]`** added to the verb set (unblocks circe's P1-stretch
  project picker; additive).
- `/ingest` JSON body key is **`text`** (not `content`) — pinned here after a
  cold-reader guessed wrong (vine msg 27).
- **node.ratified / edge.ratified events carry `{id, proposalId}` ONLY** (thin
  event; consumers flip the proposal by proposalId and backfill the full entity
  via a follow-up snapshot fetch — pinned after the P3 badge bug, vine msg 46).
  Proposal terminal status string is **"ratified"**, not "accepted".
- **Self-echo suppression on `tail` is re-ratified as DEFERRED** (plan-alignment
  review, finalize): V1's mechanism is role-filtering by the consumer
  (message.posted carries role); identity-stamped events are a V2 item.
- **look.here is its own event kind** (never lens.set): fire-once nudge, no
  state; the surface maps it to focusRequest (review fix, finalize flow).
- Ratify write-path: ruling = persist + (on accept) apply the agent-authored
  draft to the doc + changelog line + emit `node.ratified` — the daemon never
  composes prose.

## Verification gate

Cassandra engages at the P2 and P3 gates (cold-agent end-to-end drives, per the
gate lines above), not only at the end. The P3 gate is the V1 acceptance test
and maps to the proposal's success criterion: a real brain-dump in, a saved,
navigable, source-traceable map out, built WITH the agent, surviving restart.

## Open questions (settle during ratify or build)

- Where does the agent's extraction _prompt shape_ live so it stays consistent
  across sessions (casting doc vs a `references/` file)? prospero, with thoth at
  coalescence.
- Project switching UX (multiple saved projects) — circe, can land as a simple
  picker in P1 or defer.

## Slices

- **daedalus — `plan/daedalus.md`:** everything under Claims A/B server-side —
  schema, docs store, snapshot+events, all CLI verbs, ingest, ratify write-path
  (doc write + changelog line), FTS5, release-mode serve (P4).
- **circe — `plan/circe.md`:** live-state rewiring, intake UX, conversation
  panel against the real bus, review-queue UI, search-palette backend wiring,
  agent-lens/look-here rendering (violet FocusBar finally earns its tint), P4
  force-layout toggle.
