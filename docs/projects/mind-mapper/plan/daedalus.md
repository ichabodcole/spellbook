# daedalus's lane — mind-mapper V1 engine

Authored against the seams ratified on the `spellbook` vine (msgs 5–6): Claims
A + B, the wire schema (+ circe's per-entity-patch addendum), the CLI verb set
(+ `projects [--create]` addition), the review-queue contract, the intake
contract, and my two open-question rulings (WS for the browser / SSE-shaped
`tail` for the agent; conversation log in `bun:sqlite`). Integration order
follows `plan.md`'s P1–P4. All paths are under
`plugins/spellbook/skills/mind-mapper/scripts/` unless noted; the spike's
`server.ts`/`cli.ts` are replaced in place, not forked — the spike's
`readStubMap`/`readDoc` shape survives as the read path for docs, extended with
the sqlite-backed pieces.

## P1 — real state (schema, docs store, snapshot + events, read-path CLI)

**Goal:** replace the spike's stub-JSON `/state` with a real per-project store:
`bun:sqlite` for graph/staging/conversation, markdown files for doc prose, a WS
event stream circe's reducer can consume, and the CLI verbs that read it back.

1. **`db.ts` (new)** — opens/creates `~/.mind-mapper/projects/<id>/store.sqlite`
   (env-overridable via `MIND_MAPPER_HOME`, matching the spike's discovery-path
   convention) and applies the schema on open (idempotent
   `CREATE TABLE IF NOT EXISTS`, no separate migration runner in V1 — one file,
   one version, per proposal.md's "V1-lean, one SQLite file" stance):
   - `nodes(id, kind, tier, title, synopsis, created_at)`
   - `edges(id, source, target, label, provenance, direction, created_at)`
     (`provenance: asserted|derived`; `direction` nullable, `"both"` for
     symmetric — seams Contract 7's StubMap v3 shape, promoted from JSON fields
     to columns)
   - `sources(node_id, doc_id, span)` (nullable `span` — entity nodes may have
     no span, per proposal.md's claims-within-docs model)
   - `proposals(id, kind, draft_json, evidence_doc_id, evidence_span, suggested_tier, status, created_at)`
   - `messages(project_id, seq, role, text, ts)` — the conversation log (my
     ruling: sqlite, not a JSONL sidecar)
   - `docs(id, title, kind, path, created_at)` — doc _metadata_ only; prose
     stays in the file at `path` (Claim B: docs own prose, sqlite owns index)
   - an FTS5 virtual table (`docs_fts`) over doc content + `messages.text`, kept
     in sync via `INSERT`-time triggers or explicit dual-writes (pick the
     simpler one when I'm actually writing this — not a seam, no need to
     pre-decide)
   - TDD: `db.test.ts` — schema applies cleanly to a fresh temp dir; re-opening
     an existing store.sqlite doesn't error or duplicate tables (the
     honest-rebuild path Claim B commits to).
2. **`project.ts` (new)** — project lifecycle: `resolveProject(id?)` (default
   project if none named — V1 doesn't need multi-project UX to be load-bearing
   day one, just not-broken), `listProjects()` (scans
   `~/.mind-mapper/projects/*/` for the picker verb), `createProject(title)`.
   Keep dumb: a project is a directory name + a `store.sqlite` + a `docs/`
   subfolder, nothing fancier.
3. **`state.ts` (new)** — `readState(projectId): ProjectState` assembles
   `{ project, docs[], nodes[], edges[], proposals[], conversation[], lens, cursor }`
   from the sqlite tables in one read (docs still content-free, same envelope as
   the spike's `/doc/:id` — zero change to that endpoint's shape). `lens` is
   view-state, not knowledge (per plan.md's standing ruling) — held in a small
   `lens` table (`project_id, owner, node_id, depth`) or a single-row config
   table; not derived from nodes/edges.
   - TDD: `state.test.ts` — seed the tables directly, assert the assembled
     snapshot shape matches the ratified schema exactly (this is the contract
     circe's `types.ts` is written against — a shape mismatch here is a seam
     break, not a bug).
4. **`events.ts` (new)** — a tiny in-process event bus: `emit(kind, payload)`
   assigns the next `seq`, appends nothing durable itself (events are
   derived-from-state, replayable via snapshot — no event-log table in V1), and
   fans out to (a) all open WS connections and (b) the SSE-shaped buffer the
   `tail` CLI verb reads from `GET /events?since=<cursor>`. Per-entity patch
   payloads only —
   `{seq, kind: "doc.added"|"node.ratified"| "proposal.added"|"message.posted"|"lens.set", payload}`
   — never a full-array payload (circe's addendum is a hard constraint here, not
   a suggestion).
   - TDD: `events.test.ts` — seq monotonicity, late-subscriber gets only events
     after their `--since` cursor, unknown `since` (a gap) is the subscriber's
     problem to detect via cursor arithmetic, not the bus's.
5. **`server.ts` rewrite** — keep the spike's dev-mode serve (Contract 1) and
   `readDoc` shape verbatim; replace `GET /state` with `readState()`; add
   `GET /events?since=<cursor>` (SSE) and a `WS /events` upgrade path, both
   backed by the same `events.ts` bus so there's one emit path, two transports
   (my WS-vs-SSE ruling). Route additions bake at boot — bump the daemon in dev
   after landing new routes (my own scar from the spike; a `restart` CLI verb
   pays for itself here, see Candidates below).
   - TDD: extend `server.test.ts` — boot against a seeded temp project dir,
     assert `/state` matches the new shape, assert a WS client receives a
     `doc.added` event when `POST /ingest` fires (this is also the P2 ingest
     test, landing here as a smoke check since the transport is P1's job).
6. **`cli.ts` verbs (read-path only this phase):** `open` (unchanged),
   `state [--skeleton]` (skeleton mode returns ids/titles/degree only — the
   context-budgeting constraint from proposal.md's Technical Approach), `tail`
   (Monitor-shaped: `GET /events?since=<cursor>` SSE, self-echo suppressed by
   agent-id stamp on events), `projects [--create <title>]` (my addition —
   unblocks circe's P1-stretch picker; falls back cleanly to P2 if her picker
   isn't ready first).
   - TDD: `cli.test.ts` (new) — each verb against a live spawned daemon (matches
     the house pattern's existing `server.test.ts` style), `--skeleton` asserts
     synopsis/content fields are absent.

**Gate (per plan.md):** the spike surface renders a real persisted project;
kill/restart the daemon loses nothing ratified. My side: `state.test.ts` + a
live kill/restart verified against a seeded sqlite file (restart re-reads from
disk, nothing in-memory is load-bearing for ratified data — `lens` and any
in-flight proposal drafts are the only things that could be lost, and neither is
"ratified" yet, so this is honest, not a gap).

## P2 — ingest + conversation + staging

1. **`ingest.ts` (new)** — `POST /ingest` handler: multipart (file drop) or JSON
   (`{title, text}` for brain-dump/"+ new doc") → writes `docs/<slug>.md`,
   inserts a `docs` row, emits `doc.added`. Does nothing else — no extraction,
   no chunking, no embedding (Claim A: that's the casting agent reacting to the
   event). Slug derivation reuses the spike's id-guard regex (`readDoc`'s
   `^[a-z0-9][a-z0-9-]*$`) so ingested docs are addressable the same way stub
   docs already are.
   - TDD: `ingest.test.ts` — JSON ingest writes file + row + emits event;
     multipart ingest same; a duplicate title gets a disambiguating slug suffix,
     not an overwrite (silent data loss is the failure mode to guard).
2. **`propose.ts` (new)** — `propose-node`/`propose-edge` CLI verbs (`--stdin`
   JSON draft + evidence, per house-style's stdin-for-natural-text rule) insert
   a `proposals` row (`status: "pending"`), emit `proposal.added`. The draft is
   opaque JSON to the daemon — it doesn't validate the agent's extraction, only
   stores it (dumb daemon, Claim A).
   - TDD: `propose.test.ts` — round-trip a node draft and an edge draft, assert
     the stored evidence `{docId, span}` survives verbatim.
3. **`send.ts` (new)** — `send <text>` CLI verb appends a `messages` row, emits
   `message.posted`. Agent identity is a `role`/`author` field on the message,
   not a separate table — matches the spike's flat-provenance taste.
   - TDD: covered by `db.test.ts`'s messages-table assertions + a live verify
     (send while a WS client is attached, confirm the patch arrives).

**Gate (cassandra, per plan.md):** a real brain-dump becomes a pending map with
provenance, driven end-to-end by a cold agent. My side is fully covered by P2's
three pieces landing together — nothing further needed from the daemon for this
gate; the "cold agent" part is the casting SKILL prospero is drafting, not my
lane.

## P3 — ratification + search + lens verbs

1. **`ratify.ts` (new)** —
   `ratify <proposalId> --ruling canon|thread|story-local|reject --doc-edit <file>`
   CLI verb. On accept: applies the agent-supplied doc edit (a plain file write
   — the agent computed the new file content, the daemon just writes it, per the
   review-queue contract's "draft, never compose-in-UI" split), appends a
   one-line changelog entry (`docs/<id>.md`'s edit history — a flat text log
   next to the doc, not its own table; keep this the cheapest thing that works),
   inserts/updates the `nodes`/`edges` rows from the proposal's draft, marks the
   proposal `status: "ratified"`, emits `node.ratified` (or the edge
   equivalent). On reject: marks `status: "rejected"`, no doc write, no
   justification required (ratified contract).
   - TDD: `ratify.test.ts` — accept path writes file + updates graph rows +
     emits event; reject path touches nothing but the proposal row; a ratify
     against an already-ratified id is a 409, not a silent double-apply
     (idempotency guard the contract doesn't explicitly demand but a doc-write
     side effect does).
2. **`search.ts` (new)** — `search <query>` CLI verb: FTS5 query over `docs_fts`
   (lexical only in V1 per proposal.md's explicit absence —
   sqlite-vec/embeddings are V2), returns doc + message hits ranked by FTS5's
   built-in rank. Response shape leaves room for a future `similar` verb (an
   extra `kind: "lexical"` tag on each hit now, so V2 can add `kind: "vector"`
   hits into the same shape without a breaking change — proposal.md's explicit
   non-precluding requirement).
   - TDD: `search.test.ts` — seed docs + messages, assert query terms present in
     either surface as hits, assert an absent term returns empty (not an error).
3. **`neighbors.ts` (new)** — `neighbors <nodeId> [--depth 1]` CLI verb: graph
   traversal over `edges` (both directions, since edges are directed claims —
   "neighbors" means anything connected, not just outgoing), depth-bounded BFS.
   Skeleton-shaped response (ids/titles/edge reasons) per the context-budgeting
   constraint.
   - TDD: `neighbors.test.ts` — depth 1 vs depth 2 on a small seeded graph,
     confirm directed-pair edges surface from both endpoints.
4. **`lens.ts` (new)** — `lens set --node <id> [--depth <n>] | lens clear` CLI
   verb writes the `lens` table row, emits `lens.set`. `look-here <nodeId>` CLI
   verb writes a `focusRequest`-shaped event (`{nodeId, seq}` per plan.md's
   ratified surface object) — this is a fire-once nudge, not persisted state, so
   it's an event with no backing table, emitted and forgotten (distinct from
   `lens`, which is addressable and persisted).
   - TDD: `lens.test.ts` — `set`/`clear` round-trip through `/state.lens`;
     `look-here` asserts the event payload shape a live WS client receives, no
     table assertion needed.

**Gate (cassandra, per plan.md):** the full loop — ingest → map → converse →
ratify → doc holds the sentence → restart → still true. My side: chain
`ingest.test.ts` → `propose.test.ts` → `ratify.test.ts` assertions into one
integration test that ends with a fresh `readState()` (post-restart equivalent)
still showing the ratified node/edge and the doc file containing the sentence.

## P4 — hardening + experiments

1. **Contract 1 release-mode** — `bun run build` (per seams Contract 2, circe
   owns the build call itself against `src/mind-mapper/surface/`) produces
   `dist/`; `server.ts`'s mode resolution (dev iff no `dist/`, else release) is
   the same logic astrolabe's `server.ts` already proves — port it, don't
   redesign it. Emit the resolved mode on the daemon's `ready` stdout line
   (seams Contract 1's verifier requirement).
   - TDD: a release-mode boot test with `surface/`/`bunfig.toml` absent from a
     copied temp tree (cassandra's Seam D recipe, reused here) — daemon serves
     `dist/index.html` and never touches the surface source path.
2. **Force-layout toggle** — no daemon involvement; parked card, circe's lane.
   Noting only in case a "physics seed" persisted field turns out to be wanted
   (view-state, `lens`-adjacent) — not committing to it now.

## Candidates (not committing yet, flagging for the vine)

- A `restart` CLI verb (or dev-route hot-reload) if P1–P3 route iteration is as
  frequent as the spike's was — the routes-bake-at-boot scar says this pays for
  itself early rather than late.
- Whether `docs_fts` syncs via triggers or explicit dual-writes at insert-time —
  implementation detail, not a seam, deciding when I write it.
- `/doc/:id` echoing the requesting node's spans for highlight pre-computation
  (my own open offer from the spike, vine msg 18) — still circe's to pull if she
  wants it; not building it speculatively.
