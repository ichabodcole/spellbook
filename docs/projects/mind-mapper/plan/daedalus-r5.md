# daedalus's lane — mind-mapper Round 5 engine (SW1 · CLI1 · SG1 · IC-c)

Authored against `plan-round5.md`'s **Ratified decisions & lead rulings** (the
authoritative contract — the claim texts above it are superseded hypotheses)
after my own ratify pass (measured repros in
`.anthill/scratch/daedalus/2026-07-21-r5-ratify-repro.ts` + `-cli1-repro.ts`,
ALL PASS). Build order **SW1 → CLI1 → SG1 → IC-c** (the adopted P1 sequence —
smallest/safest first, submap model last since it is the headline and the
biggest wire touch). One chapter commit per item; Contract 9 R5 amendment
accreting in `.anthill/dev/seams.md` as each lands, BEFORE circe's P2 consumes
any wire. casting-draft.md amended for the agent-facing verbs before hand-off.
All paths under `plugins/spellbook/skills/mind-mapper/scripts/` unless noted.
TDD per slice; full suite green before each commit; baseline 199 engine tests
(984+ full).

## SW1 — split stall TTL

`received → stalled` and `thinking → idle` currently share `activityTtlMs()`
(60s) in `postActivity` (server.ts). Ruling: a NEW knob
`MIND_MAPPER_STALL_TTL_MS` (default 150000) governs `received → stalled` ONLY;
`MIND_MAPPER_ACTIVITY_TTL_MS` (60000) still governs `thinking → idle`. The
liveness-gate was REJECTED (a connected tail proves transport, not agent
liveness).

1. **server.ts** — add `stallTtlMs()` alongside `activityTtlMs()` (same
   env-parse-with-fallback shape, fallback 150_000). In `postActivity`, the
   `received` arm uses `stallTtlMs()`; the `thinking` arm keeps
   `activityTtlMs()`. ~4 lines.
   - TDD (presence.test.ts): the ACT1 stall rig drives the NEW knob. Add
     `MIND_MAPPER_STALL_TTL_MS: "150"` to the spawned env and confirm
     received→stalled still fires on the stall knob; the existing thinking→idle
     test stays on `MIND_MAPPER_ACTIVITY_TTL_MS`. Add a test that proves the two
     knobs are independent (a short stall knob + long activity knob → stalled
     fires, no premature idle, and vice-versa).

## CLI1 — batch-propose + message-read

Two additive capabilities. Neither touches the single propose verbs.

### `POST /proposals/batch` + CLI `propose-batch --stdin`

Body:
`{nodes:[{ref, draft, suggestedTier?, evidence?}], edges:[{draft:{source, target, label?}}]}`.
Mechanism (measured, `-cli1-repro.ts`):

- Build `refToId` = Map. Inside ONE `db.transaction()`: for each node, mint a
  UUID, `refToId.set(ref, id)`, insert the node proposal row (reusing the same
  intake guards as `proposeNode` — draft presence, evidence XOR, slug). Then for
  each edge, mint a UUID, resolve `source`/`target` via `refToId.get(x) ?? x`
  (local ref → minted id; a real node/proposal id passes through unchanged —
  opacity preserved), insert the edge proposal.
- **Events emit AFTER commit, never mid-transaction** — a rollback must leak no
  `proposal.added`. Collect the full Proposal objects during the txn (in insert
  order), then `bus.emit("proposal.added", …)` per proposal once `run()`
  returns. No new event kind.
- Return `{refToId: {<ref>: <id>}, proposals: [...]}` — the ref→id map is the
  casting win (an edge in the SAME batch can name a node by its local ref).
- Local refs are opaque strings, never persisted (disjoint from UUIDs — the edge
  draft stores the RESOLVED id). Node drafts stay opaque.
- New file `propose-batch.ts` (`batchPropose(db, bus, input)`), or extend
  propose.ts — lean: new function in propose.ts reusing `insertProposal`'s guard
  logic factored into a guard-only helper so the txn path and single path share
  validation. **Atomicity note:** `insertProposal` currently emits inside
  itself; the batch path must NOT reuse that (it emits mid-txn). Factor a
  `buildProposalRow` (validate + compute columns, no insert/emit) used by both;
  batch inserts + emits itself.
  - TDD (propose-batch.test.ts): (a) 2 nodes + 1 edge, edge endpoints are local
    refs → resolved to minted ids in the stored draft; refToId returned. (b)
    atomicity — a throwing batch (e.g. an edge draft that trips a guard, or a
    forced failure) leaves ZERO rows AND emits ZERO events. (c) opacity — a node
    draft with arbitrary keys round-trips verbatim. (d) mixed refs — an edge
    naming a real existing node id AND a local ref resolves both correctly.

### `GET /message/:id` + CLI `read <id>` / `message <id>`

Project-scoped full message row, mirroring grapevine's `read`. 404 unknown.

- **server.ts** — `GET /message/:id`:
  `SELECT id, seq, role, kind, text, ground_json, ts FROM messages WHERE id = ? AND project_id = ?`;
  shape the ground_json → `ground: string[] | null` exactly as readState does;
  404 JSON for unknown id (project-scoped — a message from another project is a
  404 here).
- **cli.ts** — `read <id>` (alias `message <id>`) → GET, print body, exit 2 on
  non-ok.
  - TDD (server.test.ts): hit returns the full row (text, role, ground); 404 for
    an unknown id; 404 for a real id under the wrong `?project=`.

## SG1 — submap engine model (node-anchored containment)

The headline. Additive + doctrine-safe. Anchor is **real-NODES-only** —
proposals stay top-level, `ratify()` UNCHANGED (do NOT fold anchor into ratify).

1. **db.ts** — `ADDITIVE_COLUMNS.nodes = ["anchor_node_id"]` (nullable TEXT;
   kind_author precedent). Legacy rows null = top-level.
   - TDD (db.test.ts): hand-mint the PRE-anchor nodes shape with a populated
     row, open with current code, assert `anchor_node_id` lands nulled and the
     row survives; fresh-equals-migrated `PRAGMA table_info(nodes)`.
2. **state.ts** — `Node.anchorNodeId: string | null` (ALWAYS carried; null =
   top-level) + server-derived `Node.submapChildCount: number` (GROUP-BY over
   the FULL nodes table `WHERE anchor_node_id IS NOT NULL`, applied to EVERY
   node in EVERY response including scoped). `/state.nodes[]` stays INCLUSIVE —
   every node tagged, top-level = `anchorNodeId == null` (the R3 zones
   precedent; both owners falsified the skeleton's null-anchor/`?all` scoping).
   Edges filter by both-endpoints-visible only in the `?anchor` narrow (below),
   never in the default inclusive snapshot.
   - TDD (state.test.ts): a small tree reads `anchorNodeId` on each node and
     `submapChildCount` correct (parent = child count, leaf = 0).
3. **server.ts** — new route `POST /nodes/:id/anchor {parentId: string | null}`
   (the FIRST `/nodes/*` route). Cycle guard = ancestor-walk from the proposed
   parent with a defensive `seen` set (reject self-anchor, direct cycle, deep
   cycle, unknown parent, unknown node). `parentId: null` clears (always safe).
   Emit `node.anchored {nodeId, anchorNodeId}` (new THIN EventKind member — keep
   the union total). New file `anchor.ts`
   (`anchorNode(db, bus, nodeId, parentId)` + the guard) — mirrors the guard I
   proved in the ratify repro.
   - `/state?anchor=<id>` = server-side narrow
     (`WHERE anchor_node_id = ? OR id = ?` for nodes; edges filtered to
     both-endpoints-in-set) for CLI/agent — mirror the `?zone` filter site in
     the /state handler. NO `?all` (default IS flat/inclusive). This is
     CLI/agent-only; the SURFACE consumes the inclusive snapshot +
     `submapChildCount` and derives the submap client-side.
   - TDD (server.test.ts): anchor a node → 200 + event; self/cycle/unknown →
     400; clear → 200; `/state?anchor=<id>` narrows nodes+edges to the submap;
     `/state` stays inclusive with `submapChildCount`.
4. **cli.ts** — `node anchor <id> --to <parent> | --clear` → POST. First `node`
   verb.
   - TDD (cli.test.ts or a server round-trip test): anchor + clear.
5. **Pinning test** — the migration/anchor test hand-mints the pre-anchor nodes
   shape + reopens (the schema-evolution doctrine; a fresh store can't catch
   it).

## IC-c — move-a-pending-proposal-into-a-zone (completes the zone in-door)

`POST /proposals/:id/zone {zoneId: string | null}` — the inverse of promote:
move a PENDING proposal into a zone (or null = to main). Guard: only pending
proposals; unknown zone → 404.

1. **zones.ts** — `moveProposalToZone(db, bus, proposalId, zoneId)`: 404-null
   for unknown proposal; error non-pending; validate zoneId exists (unknown → a
   typed signal the server 404s) or null; `UPDATE proposals SET zone_id = ?`.
   Emit — reuse `proposal.promoted` semantics? No: promote is zone→null
   specifically. For a move INTO a zone, emit `proposal.added`? No — the
   proposal already exists. Cleanest: emit the existing THIN
   `proposal.promoted {id}` only on the null case (main-ward move IS a promote),
   and for the into-a-zone case emit a full-object re-`proposal.added` so
   inclusive consumers re-tag the zoneId (the proposal.added payload carries
   zoneId — the R3 tagging mechanism). **Decision: emit `proposal.added` (full
   object, with the new zoneId) for the into-zone move so consumers re-tag; emit
   `proposal.promoted` for the to-main move (zoneId → null), matching promote's
   existing wire exactly.** Keeps EventKind total (no new kind).
2. **server.ts** — `POST /proposals/:id/zone`: unknown zone → 404 (not 400);
   non-pending → 400; success → the moved proposal.
3. **cli.ts** — `proposal zone <id> --to <zoneId> | --clear` → POST.
   - TDD (zones.test.ts): move pending into a zone (row zoneId set, event
     carries it); move to main (zoneId null); unknown zone 404; non-pending
     rejected; unknown proposal 404.

## Contract 9 R5 amendments (accrete in seams.md per item)

New column `nodes.anchor_node_id`; `anchorNodeId`/`submapChildCount` wire;
`POST /nodes/:id/anchor`; `node.anchored` kind; `POST /proposals/batch` + ref→id
map + after-commit emit; `GET /message/:id`; `POST /proposals/:id/zone`; the
split stall TTL knob; and the INCLUSIVE-snapshot-plus-`?anchor` ruling stated
explicitly (surface consumes the inclusive snapshot; `?anchor` is
CLI/agent-only). Land BEFORE circe's P2.

## Asserted ABSENT (my lane)

No change to `ratify()` (anchor is post-ratify, real-nodes-only). No `?all`. No
anchor on proposals or edges. No new persistence beyond `nodes.anchor_node_id`.
Zones unchanged except the new in-door move. Single propose verbs unchanged.
