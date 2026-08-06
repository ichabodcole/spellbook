# daedalus R7 lane — TAGS engine + PORT flag

Owner: daedalus (engine). Branch `feature/mind-mapper-round7`. Authoritative
framing: `plan-round7.md` "Ratified decisions & lead rulings" + "Build order".
This lane is the fill; the contract lands in seams.md (Contract 9 R7) BEFORE
circe's P2 consumes the tags wire.

## What I'm building (adopted order)

### 1. PORT (cli-only, first — server already binds `--port`)

`open` verb gains `--port <n>` (`port: {type:"string"}` in its parseArgs
options), forwarded through `ensureDaemon(port?)` → spawn args
`[..., ...(port ? ["--port", String(port)] : [])]`. Server ALREADY parses +
binds `--port` (default "0"=ephemeral, server.ts main:437) — ZERO server change.
Two documented wrinkles (benign for reap-resilience):

- `open --port N` against a LIVE daemon IGNORES N — `ensureDaemon` returns the
  existing `livePort()` before it ever spawns. The stable URL holds only if the
  FIRST open set `--port`.
- Port already in use → the daemon exits (Bun bind error) and the cli poll times
  out ("daemon did not come up within 10s"). No graceful degrade — pick a free
  stable port.

cli.test.ts: spawn a fresh HOME with `open --port N`, assert `daemon.port` file
== N.

### 2. TAGS — freeform per-target tags, the exact twin of `node_actions` (A1)

Storage is a target-keyed table, NOT a column: a column on `nodes` can't hold a
PENDING proposal's tags; the table gives pending-carry + re-home for free
(ruling, plan-round7:136). FREEFORM — the engine stores strings; agent-curation
(reuse-suggest / autocomplete over existing tags) is circe's surface concern.

Dependency order (tests green each step), mirroring `node_actions` verbatim:

- **db.ts** — `node_tags (target_id TEXT PRIMARY KEY, tags_json TEXT NOT NULL)`
  via CREATE TABLE IF NOT EXISTS (twin of node_actions:200). New table, additive
  by construction — no ADDITIVE_COLUMNS entry needed.
- **tags.ts** — `setTags/clearTags/readTags`, `resolveTarget` (node or PENDING
  proposal → else null/404), `parseTags` (freeform `string[]`, parse guard like
  parseActions), a `TAGS_BYTE_CAP` (16KB serialized).
  `tags.set {targetId, tags}` event (FULL array — wholesale metadata, not a
  patchable entity). NO soft-cap warning (a folksonomy is naturally small; the
  byte-cap is the only gate).
- **state.ts** — `tags?: string[]` on Node AND Proposal, attached in `readState`
  on BOTH nodes[] and proposals[] via `readTags(db)` (absent=none), AND in
  **`readProposalById`** — the clobber catch: IC-c's zone-move re-emit runs
  through readProposalById, so tags MUST ride it beside actions or a move-into-
  zone drops them (the full-shape-on-re-emit lesson).
- **propose.ts** — `tags?: string[]` on `ProposeInput` + `BatchNodeInput`;
  `buildProposal` validates via parseTags (pure, pre-txn), writes the node_tags
  row in its `insert` closure (runs inside batchPropose's db.transaction), AND
  attaches `tags` to the returned Proposal (so post-commit proposal.added
  carries them).
- **ratify.ts** — re-home/delete beside the node_actions sites: node accept
  `apply()` UPDATE node_tags SET target_id (beside :265); reject `apply()`
  DELETE (beside :146); edge accept `apply()` DELETE (beside :298).
- **del.ts** — deleteNode detritus (beside :60) + deleteProposal cascade (beside
  :80).
- **zones.ts** — deleteZone cascade, delete tags BEFORE proposals (:76-79).
- **server.ts** — `PUT/DELETE /tags/:targetId` (twin of /actions/, :636); `tags`
  passthrough on the `/proposals` body. `/proposals/batch` rides for free (it
  forwards the whole `nodes` array typed as `BatchInput["nodes"]`, which now
  carries tags).
- **cli.ts** — top-level `tags <targetId> (--set <json> | --stdin | --clear)`
  verb (twin of the `actions` verb :962). Propose-time tags flow through the
  existing `--stdin` JSON body (no new propose flag).

Tests: tags.test.ts (lifecycle: pending-carry → re-home on ratify; reject/edge/
zone-delete cleanup; **zone-move re-emit keeps tags**) + db.test.ts pinning
(pre-node_tags store → node_tags created, fresh-equals-migrated) + server/cli
round-trips.

### 3. Contract 9 R7 amendment (seams.md) — BEFORE circe's P2

TAGS: node_tags table, `/tags/:targetId`, `tags.set`, `tags` on nodes[]+
proposals[], the re-home lifecycle + the readProposalById catch. PORT: cli
forwards --port, server already binds. BACKLINKS/FILTER/RATIFYFIX/DIRSELECT/
MDVIEW/SUBMAPPEND are surface-only (no engine work — confirmed).

### 4. casting-draft.md amendment

(a) no `suggestedTier:"cast"` — state the vocab so the agent never emits it; (b)
clarify "background" (casting-draft:439) is a steeping-context STANCE, not a
suggestedTier that maps to a ruling; (c) tier vocabulary explicitly
`canon | thread | story-local`; (d) document the `tags <targetId>` verb +
tags-on-propose.

## Absent (this lane)

No tag vocabulary enforcement (freeform, ruled). No tag column on nodes/edges.
No tag search facet (circe's FILTER, surface-only). No propose `--tags` CLI flag
(rides the stdin JSON). No dist rebuild.
