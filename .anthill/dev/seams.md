# seams — the shared inter-seat contracts

> **What this file is.** The single home for the truths that live _between_ seats — the boundaries
> where one seat's work meets another's. A seat doc must **point here, never restate this**. That rule
> is self-referential: a contract copied into three seat docs will drift, violating the very rule it
> states. So: one source.
>
> **What belongs here.** A contract earns a place here when it is **shared truth that more than one
> seat must agree on** and that **drifts if restated** — a data shape passed across a boundary, an
> invariant two seats both rely on, a protocol between slices. Not a seat's private taste (that's the
> seat doc), not a one-off (that's a commit message), not product docs.
>
> **This is a seed.** No contracts yet — they **accrete as they're discovered**. Start empty; add the
> first one the first time two seats have to agree on something.

## Ownership & the maintenance trigger

- **Each contract has ONE owning seat** — the seat that is authoritative for that boundary _in code_.
  The owner keeps the contract's prose true. Other seats **defer** to it.
- **The write-trigger (binds everyone):** _whoever moves a boundary updates this file **and** its
  proof_ — in the same change. A boundary moved in code but not here is a latent drift bug; the next
  agent trusts the trail and the trail lied.
- **Pin to proof where you can.** A contract backed by a test that fails when the boundary breaks
  can't silently rot. Prefer a green test; fall back to a durable concept or a commit; never a
  transient line/file reference.

---

## Contracts

_First contracts accreted during the Spell Surface Pipeline plan-ratify (session `prospero`,
2026-07-07). See `docs/projects/spell-surface-pipeline/`._

## Contract 1 — Surface serve + mode resolution

**Owner:** daedalus (server.ts) · **Pointed at from:** circe, prospero, cassandra

**The contract, stated once:** a conjuration's daemon serves its surface in one of two modes,
resolved at startup: **release** iff a `dist/` dir exists at the skill root (override via env
`SPELLBOOK_SURFACE_MODE=dev|release`), else **dev**.

- **dev:** the surface HTML entry is imported via a **dynamic, dev-only** `await import("../surface/index.html")` (string-literal specifier) reached only on the dev branch; Bun bundles the `.tsx` + Tailwind graph at serve time; `development.hmr` on.
- **release:** serve static files from `dist/` (entry `dist/index.html` + hashed assets by path); `hmr` off; zero reads of `surface/` or `bunfig.toml`.
- The daemon **emits its resolved mode** on the `ready` event so the verifier can assert `mode==="release"`.
- Release mode resolves `dist/` from an **absolute skill-root path** (not cwd).

**Why it bites:** a **top-level static** `import index from "../surface/index.html"` (astrolabe
`server.ts:63` today) forces Bun to resolve the surface build graph at daemon **load** — which
**crashes a surface-source-free / deps-free destination** before it can serve `dist/`. The dev-only
dynamic import is what makes a deps-free daemon boot. A dev-mode daemon with root deps present
renders an identical-looking board, so "looks right" ≠ "release mode" — assert the emitted mode.

**Proof:** cassandra's Seam D gate — daemon starts and serves the board with `surface/` +
`bunfig.toml` + `node_modules` all absent (the local-sim recipe in the project plan). Ratified by
daedalus × circe against astrolabe `server.ts`.

## Contract 2 — Pre-built `dist/` layout

**Owner:** circe (surface build) · **Pointed at from:** daedalus (static serve), prospero (packaging)

**The contract, stated once:** `bun run build` (a bare `build.ts` at the skill root, run with root
deps — **no per-spell `package.json`**) calls `Bun.build({ entrypoints: [".../surface/index.html"],
plugins: [tailwind], outdir: "dist", naming: "[dir]/[name]-[hash].[ext]" })`. Output is **flat at
`dist/` root**: `index.html` + content-hashed `chunk-*.css` / `chunk-*.js`, with the HTML's asset
hrefs rewired to **relative `./chunk-*`** paths. react/react-dom/tailwind are **bundled into the
chunks** — the `dist/` is inert (no deps at the destination). The Tailwind plugin (a plain
`BunPlugin`) is passed **explicitly** in `build.ts` for release (bunfig's `[serve.static]` only wires
serve-time) — same plugin, both modes, no second toolchain. The surface's `styles.css` **`@source
"./**/*.{ts,tsx}"`** directive must survive into any scaffold template (Tailwind only emits
utilities it finds as literal text; dynamically-referenced classes vanish without it).

**Amendment (mind-mapper V1, 2026-07-17):** when the entrypoint is HTML, `naming` must be the **`{entry, chunk, asset}` object form with the entry UNHASHED** (`index.html`), never a single naming string — a uniform `[name]-[hash]` hashes the HTML entry, which silently defeats Contract 1's `dist/index.html` release-mode check (daemon stays in dev mode against a real dist/; found live, mind-mapper commit 3b8b652). Chunks/assets keep the hash.

**Why it bites:** `dist/` is **gitignored** — an un-committed `dist/` never enters the marketplace
git-clone, so release mode has nothing to serve. And if the served static root doesn't match the
relative `./` asset hrefs, the board paints blank. daedalus's static serve and circe's `dist/` shape
must agree on entry name + asset rooting.

**Proof:** circe empirically built astrolabe's surface with this exact call (Bun 1.3.14, plugin
0.1.2) — success, tokens + `@source` utilities present. dist-un-ignore + commit is a hard
prerequisite (circe lane).

## Contract 3 — Backend ships as source (no build)

**Owner:** daedalus (backends) / thoth (canon wording) · **Pointed at from:** all seats

**The contract, stated once:** a spell's backend (daemon, CLI, server) ships as Bun-native `.ts` and
runs directly under Bun; no compile/bundle/transpile step. Only the surface ever builds. _Repeal
when_ a backend dependency genuinely requires a build (native addon, codegen'd client, no runnable
source dist) **and** the cost of hand-working around source-only exceeds owning a backend build —
repeal narrowly for that spell first, promote to a default only on a second independent signal.

**Why it bites:** this is the **re-scoped surviving half** of house-style's existing "Self-contained,
no build step" rule — not a new rule. Shipping a duplicate rule beside the old one, or stacking two
repeal phrasings, drifts the canon. Merge into one.

**Proof:** every daemon-backed spell runs `bun run server.ts` directly today (astrolabe
`cli.ts` spawns `process.execPath "run" SERVER_SCRIPT`). Canon: thoth's `house-style.md` amendment.

## Contract 4 — Surface source lives outside the plugin subtree (source-free by construction)

**Owner:** prospero (repo layout / release) · **Pointed at from:** circe, daedalus, cassandra, thoth

**The contract, stated once (Cole's ruling, `prospero` session):** buildable spell source lives at a
top-level **`src/<spell>/<aspect>/`** tree, outside `plugins/spellbook/`. Today the only aspect is
`surface/`: `src/astrolabe/surface/` (+ `bunfig.toml`) and `src/astrolabe/build.ts` (spell build
orchestrator). **`src/` = build-input only (Option A)** — backend source stays authored in the
deployed folder (ships verbatim); a future built backend moves to `src/<spell>/backend/` additively,
no refactor. The deployed spell folder `plugins/spellbook/skills/<spell>/` carries backend source +
a **committed `dist/`** and **no surface source**. `build.ts` reads `src/<spell>/surface/` and writes
the spell folder's `dist/`. The published plugin is therefore **source-free by construction** — there
is no packaging filter (Claude Code has none: the marketplace copies the whole git-tracked subtree)
and no release-branch; the wrong files simply aren't in the subtree.

**Why it bites:** the marketplace copies the entire git-tracked `plugins/spellbook` subtree to the
consumer cache — anything tracked under it ships. Keeping surface source *inside* the spell folder
cannot be filtered out. Relocation is the mechanism. Corollary: `dist/` must be un-ignored +
committed, or release mode has nothing to serve.

**Identity reframe:** "self-contained / zip one folder" now describes the **deployed** spell folder
(dist + backend = everything needed to run), not the dev layout — authoring is split across two
trees.

**Proof:** cassandra's dry-run rehearsal — `git clone` the branch, inspect the would-be
`plugins/spellbook/skills/astrolabe/` subtree: `dist/` present, `surface/`/`bunfig.toml` absent. And
the real release cut (Cole-gated).

## Contract 5 — Serving a src/-relocated surface (dev mode)

**Owner:** daedalus · **Pointed at from:** circe, prospero · _(refines Contracts 1 & 4; accreted mind-mapper spike session, 2026-07-16)_

**The contract, stated once:** when surface source lives at `src/<spell>/` (Contract 4), the spell's `cli.ts` must pin the spawned daemon's **cwd to `src/<spell>/`** — not the skill root — or bunfig's Tailwind plugin is **silently skipped**; and the dev-only dynamic import of `surface/index.html` becomes a deep relative specifier from the skill's `scripts/` dir.
Two operational corollaries:
- **Routes bake at boot; only data re-reads live.** A `server.ts` change is not served until the daemon restarts — "endpoint landed" ≠ "endpoint served" (phantom-404 class). Data files read per-request need no restart.
- Pre-re-home astrolabe pins cwd to the skill root; its branch hits this (plus the root-tsconfig DOM libs addition) at merge — prospero holds the merge-note.

**Why it bites:** the failure is silent (surface renders unstyled or daemon 404s a live route) and each symptom masquerades as a different bug.

**Proof:** mind-mapper `cli.ts` + green `server.test.ts` booting through the pin (commit 9d46940 and successors).

## Contract 6 — Span anchors are whitespace-tolerant by contract

**Owner:** circe (dataset/anchoring) · **Pointed at from:** daedalus, any renderer or lint consumer

**The contract, stated once:** a span anchor expressed as a verbatim excerpt must be matched into doc content with **`\s+`-joined (whitespace-tolerant) matching**, never byte-exact — the repo formatter (prettier/biome) reflows committed markdown, so a byte-exact matcher is a latent drift bug, not a stricter one. This is a **data contract** between whoever authors anchors and every consumer that resolves them (viewer highlight today; lint tomorrow). If V1 keeps excerpt anchoring alongside/before offset-based source-log anchoring, this clause travels with it.

**Proof:** post-reflow validator run + browser-verified highlight across a prettier-inserted line break (mind-mapper spike, commits d3599aa/934f422).

## Contract 7 — The spike map wire (StubMap v3) is the V1 schema negotiation baseline

**Owner:** daedalus (wire) + circe (shape) co-own · **Pointed at from:** prospero

**The contract, stated once:** the vine-ratified StubMap v3 shape — `docs[]` (id/title/kind) in `/state`, doc content via `GET /doc/:id` `{id,title,kind,content}`, `node.sources[{docId, span}]`, `edge.provenance: asserted|derived`, `edge.direction?: "both"`, `pending?` staging flags — is **spike-throwaway as data but the baseline as design**: V1's real schema gets negotiated as diffs against it, not from scratch. The durable process is also named here: seam changes are **proposed additive-optional → one ack from the other owner → lead ratifies**, which kept both sides green through three versions in one session.

**Proof:** commits de55ff9 (v2), 6223522 (v3); ratifications at spellbook vine msgs 4/6, 14/17, 37–39.

## Contract 8 — Mind-mapper V1 architecture (dumb daemon · storage split · one bus, two transports)

**Owner:** daedalus · **Pointed at from:** circe, prospero, cassandra · _(ratified at V1 plan phase, 2026-07-16, vine msgs 3–6; supersedes nothing — extends Contract 7's baseline)_

**The contract, stated once:** the mind-mapper daemon is a **dumb state authority** — no LLM calls; all intelligence (extraction, drafting, relate-checks, conversation) lives in the **casting agent** via CLI verbs. Storage split: markdown docs under `~/.mind-mapper/projects/<id>/docs/` own all prose/knowledge; one `bun:sqlite` file owns the graph index (doc+anchor provenance per Contract 6), staging proposals, the conversation log (`messages` table, FTS5-indexed alongside docs), and search. **Honest-rebuild clause:** re-index recovers wikilinks and re-anchors claims; it never re-runs extraction — a doc rebuild is not claim recovery. Event bus: one `emit()` fans out to **WS `/events`** (browser) and a resumable SSE-shaped **`GET /events?since=<cursor>`** (agent `tail`); events are **per-entity patches, never wholesale array replaces** (the surface feeds them through React Flow's apply-changes path); snapshot refetch is the sole gap recovery.

**Why it bites:** any daemon-side "helpfulness" (auto-extraction, prose composition in the ratify path) silently violates map-as-view and the co-presence intent bus; a wholesale-array event resurrects the spike's infinite-render-loop class.

**Proof:** pending — pin to the P1 gate tests (restart-loses-nothing-ratified) and the plan ratify record (`docs/projects/mind-mapper/plan.md`, Ratified decisions).


## Contract 9 — Mind-mapper V1 wire (successor detail to Contracts 7/8)

**Owner:** daedalus (wire) · **Co-owner:** circe (consumption) · _(ratified across the V1 build session, 2026-07-16/17; proof: 86-test suite + cassandra's two gate drives)_

**The contract, stated once:**
- `GET /state` → `{ project, docs[], nodes[], edges[], proposals[], conversation[], lens, cursor }`; docs content-free; `GET /doc/:id` envelope unchanged from the spike. Everything is project-scoped (`--project` / `?project=`) — a missing scope is a 404.
- `GET /search?q=` → `{hits:[{kind: node|doc|message, id, title, snippet?, score}]}` — nodes by title/synopsis, docs+messages by FTS5; node hits rank first at equal score; shape reserves `kind:"vector"` for V2.
- **Ratified events are THIN:** `node.ratified`/`edge.ratified` carry `{id, proposalId}` only — consumers flip the proposal by id and backfill the entity via snapshot refetch. Proposal terminal status string is **`ratified`** (not "accepted").
- Events carry `{seq, epoch}`; epoch is random per daemon boot — a stale `--since` watermark is detectable by epoch mismatch (no durable event log, per Contract 8).
- Messages: `{id, seq, role: "user"|"agent", kind, text, ground: string[]|null, ts}` (`ground` = selection-context node ids; null normalized client-side).
- `/ingest` JSON body key is **`text`** (not `content`).
- Edge proposals may reference **proposal ids as endpoints**; ratify resolves them via `proposals.result_node_id` and errors ("ratify node proposal <id> first") if the endpoint hasn't ratified.
- **Schema evolution mechanism:** on open, `db.ts` column-diffs actual vs expected (`PRAGMA table_info`) and applies **additive-only** `ALTER TABLE ADD COLUMN`; non-additive changes hard-error naming the store path. The pinning test opens a store created at the PREVIOUS schema shape (that test design is the load-bearing part).
- The lens **persists across restarts** (addressable view-state in sqlite); `look-here` is fire-once, no table.

**Why it bites:** every clause above was either guessed wrong by a consumer or discovered missing during the build (the badge bug, the search-shape divergence, cassandra's 404s and unvalidated edge endpoints) — this contract is the accumulated corrections, stated once.

### Contract 9 — V1.x Track A amendments (additive-optional; ratified per plan-v1x Claims A–G, built 2026-07-17)

- **New event kinds** (payloads stated at the seam): `doc.deleted {id}` (thin) · `doc.marked {docId, mark:{author, note, status, ts}}` (FULL mark inline — marks are small and append-only; `stale` is /state-read-time-only, NEVER in the event) · `presence.changed {agents}` (project-scoped) · `agent.activity {state:"received"|"thinking"|"idle"}` (fire-and-forget, no table). `look.here {nodeId}` is now formally in the `EventKind` union (drift fixed). `epoch.changed {kind, epoch}` is **CLI-synthesized only** — emitted by `tail` on stdout when a reconnect lands on a new epoch (cursor resets to 0; agent must refetch /state); no `seq`, never rides the bus, the browser WS never sees it.
- **Ephemeral-event cursor clause (circe):** every bus emit consumes a seq, fire-once signals included — consumers route ALL kinds through their reducer's cursor advance (ephemerals surfaced separately via the `{payload, seq}` signal idiom), or pay a wholesale refetch per signal.
- **Tail hardening (Claim F as corrected):** server sends `: keepalive` comment frames ~15s per SSE connection; cli tail runs one AbortController per attempt + a rolling ~45s idle watchdog reset on raw chunks BEFORE frame parsing; on fire → abort → reconnect with last-seen seq. **Measured correction (Bun 1.3.14): `controller.enqueue()` on an orphaned stream never throws** — dead-socket detection is `req.signal` abort, funneled with `cancel()` and the enqueue try/catch into one idempotent teardown (unsubscribe + keepalive clear + presence decrement). Accepted hole: Bun-client `reader.cancel()` is invisible server-side.
- **Presence + activity (Claim C):** `/state.presence: {agents}` — agents = open SSE tails, counted at the SSE subscription site per project; browser WS never counts (agents-only, ruled). Unscoped connections attribute to the daemon-resolved default project. `POST /activity {state}` → `agent.activity`; non-idle arms a ~60s per-project TTL emitting synthetic `idle`.
- **Proposal `author` (Claim D):** `proposals.author` nullable-TEXT via `ADDITIVE_COLUMNS`; propose writes explicitly (default agent); wire ALWAYS carries `author:"user"|"agent"` — null normalizes at read.
- **Message evidence (Claim E):** `sources` untouched; sibling table `message_sources {node_id, message_id, span}`; `proposals.evidence_message_id` additive. Propose rejects both-set; SLUG_RE guards docId only; messageId must exist in `messages`. Ratify with message evidence: `--doc-edit` invalid; accept inserts a `message_sources` row. Wire: `node.sources[]` = union `{docId, span} | {messageId, span}`; evidence gains `messageId`.
- **Doc marks (Claim B):** `doc_marks` append-only, latest wins; `POST /doc/:id/mark`; `/state.docs[].mark {author, note, status, stale, ts}` with `stale` computed server-side (file mtime > marked mtime; missing → stale). CLI `mark <docId> --status <s> [--note <t>]`.
- **Doc delete (Claim A):** `DELETE /doc/:id[?force=1]` — 404 first for non-slug/unknown; cited+unforced → 409 `{error:"cited", citedBy:{nodes, proposals: pending-only}}` via typed `CitedError`. Force/uncited: unlink + delete docs/docs_fts/sources rows + NULL evidence on PENDING citing proposals (zombie-write hole closed, test-pinned); ratified proposals keep evidence as history; nodes survive. Ground-ref grammar for `message.ground[]`: bare id = node ref, `doc:<id>` = doc ref, unknown prefixes tolerated (drop silently).
- **Migration doctrine as built:** new tables by `CREATE TABLE IF NOT EXISTS`; `ADD COLUMN` nullable-TEXT-only; "default" intent = null-normalized-at-read; pinning tests hand-mint the previous shape.
- **Test knobs (env, tests only):** `MIND_MAPPER_KEEPALIVE_MS`, `MIND_MAPPER_TAIL_IDLE_MS`, `MIND_MAPPER_TAIL_RETRY_MS`, `MIND_MAPPER_ACTIVITY_TTL_MS`.
- **Ratify-time evidence attach (gate rework, cassandra item 7):** `ratify <id> --ruling <r> --doc <docId> --doc-edit <file> [--span <text>]` — `--doc` attaches a doc home to an **evidence-less NODE proposal only** (the human-sketch inversion); requires `--doc-edit`; errors on any proposal already carrying evidence (doc or message) and on edge proposals; docId slug-validated + must exist. Accept writes the doc edit, re-indexes FTS, logs the changelog, creates the node, mints `sources {node_id, doc_id, span}` (span nullable). Wire: `POST /proposals/:id/ruling` gains additive `docId`/`span`. Single-provenance invariant: a sources row's evidence comes from intake XOR ruling, never both.
- **As-built wire notes (circe, P2 contact):** `/state.presence` is spread on in the server handler — the engine's exported `ProjectState` type under-reports the wire (grep server.ts, not state.ts). `cli send` posts `role:"agent"` by default (correct for the casting loop; a cold agent must pass the human role explicitly if ever proxying). Wire proposal payloads also carry `resultNodeId` (undocumented surface; consumers tolerate-by-omission).

**Proof:** mind-mapper suite (123 tests incl. the previous-shape pinning test, the zombie-write test, and the tail watchdog rig), commits ae73024…fb1e819.

### Contract 9 — Round 3 amendments (additive-optional; ratified per plan-round3 claims Z1/Z2/S1/P1/C1/V2, built 2026-07-18)

- **New event kinds** (payloads at the seam): `zone.created {id, name}` · `zone.deleted {id}` (THIN — consumers drop that zone's proposals locally; scoped drop, never wholesale replace) · `proposal.promoted {id}` (THIN — consumers with the inclusive store clear `zoneId` on the row). `EventKind` stays total.
- **Zones (Z1):** `zones {id, name, ts}` table per store; ids are SLUGS derived from name (same derivation as `projects --create`); no rename. Zone contents are PROPOSALS ONLY — nodes/edges never carry `zone_id`. `proposals.zone_id` lands via `ADDITIVE_COLUMNS` (main graph = `zone_id IS NULL`; every pre-zones row is main-queue by construction). Wire `Proposal` gains `zoneId: string | null` — ALWAYS carried; `proposal.added` (full-object emit) is tagged for free. **`/state.proposals[]` is INCLUSIVE** (zoned rows present, tagged — lead ruling; main view = `zoneId == null` at render; a main-view consumer MUST segregate zoned rows at BOTH ingestion points, snapshot merge and event upsert); `/state.zones[]` added; `?zone=<id>` narrows `proposals[]` (unknown zone → 404). Routes: `GET/POST /zones`, `DELETE /zones/:id[?yes=1]` — populated zone unforced → **409 `{error:"zone-not-empty", proposals: n}`**; delete cascades the zone's proposals (disposable sandbox). CLI: `zone create <name> | list | delete <id> [--yes]`, `propose-* --zone <id>` (unknown zone = intake error).
- **Promotion (Z2):** `POST /proposals/:id/promote` / CLI `promote <id>` — MOVE not duplicate: `UPDATE proposals SET zone_id = NULL`, draft/evidence/provenance untouched, no tombstone. Pending-only. Edge endpoint-order mirror: an edge whose draft endpoint references a still-zoned node proposal refuses, error names the endpoint. `ratify()` intake refuses a still-zoned proposal — accept AND reject — "in zone <z> — promote first (ratification is a main-queue act)". Reject-in-zone does not exist; `zone delete` is the only in-zone disposal (flagged for drive-3).
- **Project lifecycle (P1):** no auto-mint, no demo seed. `resolveProject(home, undefined)` resolves `default` iff its dir exists (legacy stores unchanged, test-pinned), else typed `NeedsProjectError` → **409 `{error:"needs-project", projects:[...]}` from every scoped endpoint** — one synchronous resolve site + one fetch-level funnel; SSE refused pre-stream, WS upgrade refused, presence never increments on a refusal. Named unknown scope stays 404. Presence attribution's default clause narrows to "the daemon-resolved default IF one exists". CLI: `open --project <id>` (?project= on printed URL + browser; unknown id exit 2 — open never mints); `tail` exits 2 on a 409/404 refusal instead of silently retrying.
- **Search (S1):** `/search` gains `kind:"proposal"` — pending-only, matched in JS over PARSED `draft_json` (never SQL LIKE over raw JSON), score = node formula ×9 (title 18 / synopsis 9; equal-quality match ranks the ratified node first), `snippet` = synopsis, hits carry `zoneId: string | null`. Unparsable drafts tolerated, never a crash.
- **send body chain (C1):** precedence `--body-file` > `--stdin` > inline positional > piped-stdin default; one trailing newline stripped; newlines land verbatim (byte-exact round-trip test-pinned). EMPTY resolved body = usage error exit 2. Leaked-invocation refusal narrowed to `send` (+ `--force`); shell-risky inline bodies warn on stderr, never block. **Sharp edge (measured): bare `send` with no body under an agent shell blocks forever** — no read timeout by design; casting draft states it. House-wide: grapevine ships the same hang (Track B).
- **Doc-lens (V2):** `lens.doc_id` via new `ADDITIVE_COLUMNS.lens` entry. Wire `Lens` gains `docId: string | null` — `lens.set` payload ALWAYS carries it (null on node lens and on clear). XOR by construction: the upsert writes every column. `POST /lens` validates exactly-one of `nodeId`/`docId`, `depth` only with `nodeId`, `docId` slug + exists. CLI `lens set --doc <docId>`, parse-time exclusive with `--node`. Persists across restart (test-pinned).
- **Migration doctrine reaffirmed:** zones via `CREATE TABLE IF NOT EXISTS`; `zone_id`/`doc_id` nullable-TEXT `ADD COLUMN`; pinning tests hand-mint the previous shapes.

- **Consumer footnotes (circe, P2 contact):** a zoned edge whose endpoint proposal is promoted keeps rendering in the zone view with the promoted endpoint wearing main-queue staging dashes (an honest "this one left") — consumers resolve zone-context endpoints against the pending-merged main board, not the zone subset. First-zone affordance: the tab strip renders only when zones exist, so the first zone is CLI/conversational-only (flagged for drive-3). Vendor-CSS trap, third sighting: React Flow's unlayered panel margins beat Tailwind utilities — inline style is the honest fix; every new full-width overlay re-runs the panel-coverage audit.

**Proof:** mind-mapper suite 174 engine tests + 125 surface tests (916 full suite), commits b3d5350…ab9783c (engine), 5742400/a7f2167 (P1s), d23258f…bfb497d (P2). Zero wire-guess failures at P2 contact.

### Contract 9 — Round 4 amendments (additive-optional; ratified per plan-round4 rulings, built 2026-07-19)

- **SUPERSESSION 1 — docs kind wire type (K1):** `state.docs[].kind` and the `GET /doc/:id` envelope's `kind` are now **`string | null`** (previously always-string). At rest `docs.kind` stays NOT NULL with `''` = untyped (SQLite cannot relax NOT NULL — measured); `'' → null` normalizes at EVERY wire exit (`/state`, `/doc/:id`, `doc.added`). The ingest kind defaults (`"ramble"`/`"story"`) are DEAD — a fresh doc is untyped until asserted. `state.docs[]` also always carries **`kindAuthor: "user" | "agent" | null`** (`docs.kind_author` via `ADDITIVE_COLUMNS`; legacy/untyped rows honestly unattributed = null). New route `POST /doc/:id/kind {kind: string | null, author}` (mark family: 404-first, 400 bad payload; `kind: null` clears — writes `''` AND nulls the author; a string kind REQUIRES author `user|agent`). New event `doc.kind {docId, kind, author}` (wire-normalized null, never `''`). CLI: `doc kind <docId> <kind> [--author user|agent] | doc kind <docId> --clear`. Node kind (ratify draft.kind) is UNRELATED — untouched.

- **Action slots (A1, as amended at ratify):** `node_actions (target_id TEXT PRIMARY KEY, actions_json TEXT NOT NULL)` — target is a node id OR a **PENDING** proposal id (disjoint UUID spaces; ratified/rejected proposals are NOT valid targets). Wire: `state.nodes[].actions?` AND `state.proposals[].actions?` (array of `{id, label, seed}` string triples; **absent = none** — additive-optional). Routes: `PUT /actions/:targetId` (wholesale replace; empty array clears; shape-validated at intake — the opaque-draft doctrine does NOT cover this, it's engine-owned metadata) and `DELETE /actions/:targetId`; unknown target 404, bad shape / >16KB serialized json 400. Soft cap: >4 entries stores in full but returns an additive `warning` (edgeDraftWarning mechanism; CLI mirrors to stderr; surfaces render 4 + scroll). New event `actions.set {targetId, actions}` (FULL new array — wholesale metadata, not a patchable entity). **Lifecycle:** node-proposal accept RE-HOMES the row onto the minted node id; reject deletes it; edge-proposal accept deletes it (no node to re-home onto); zone delete cascades the zone's proposals' rows; promote is a no-op (the proposal id survives the move). CLI: `actions <targetId> (--set <json> | --stdin | --clear)`. Click semantics are circe's: a slot click SEEDS the composer with `seed` + the target as ground — never auto-sends.

- **SUPERSESSION 2 — activity TTL clause (ACT1, supersedes Claim C's "non-idle arms a ~60s TTL emitting synthetic idle"):** the TTL is state-aware now — `received → (MIND_MAPPER_ACTIVITY_TTL_MS, ~60s) → agent.activity {state:"stalled"}` (daemon-synthesized, PERSISTS — no re-arm, no decay to idle/blank — until an agent write or an explicit set resolves it); `thinking → (TTL) → idle` unchanged. **`stalled` is daemon-synthesized vocabulary ONLY** — `POST /activity` rejects it (epoch.changed asymmetry). Surface rule (circe): stalled gets a STATIC attention-tinted branch, never the thinking pulse (false-liveness), and the client THINKING_TTL backstop must not clear it to blank.
- **Automated activity (ACT1):** the daemon auto-flips `agent.activity {state:"received"}` on a `role:"user"` /send while `entry.agents >= 1` (no tail → no flip; the presence dot already says nobody's home), emitted AFTER `message.posted` — two seqs, ordered, both through the normal bus path (the ephemeral-cursor clause holds). **Resolution:** agent-authored writes resolve any AUTO state (auto-received / stalled) to idle — `send role:"agent"` (which ALSO resolves explicit `thinking`: a reply is the turn's terminal act; re-set thinking explicitly for send-then-more-work), propose with author `"agent"` (user-sketched proposals don't), mark with author `"agent"`, and ratify (no authorship on that wire — resolves unconditionally). Explicit non-idle states otherwise stand until explicit idle or TTL. `activityState`/`activitySource` live in-memory on ProjectEntry (server.ts) — a daemon restart honestly clears to no-signal. The agent no longer needs to post `activity received` manually; `thinking`/`idle` remain its own.

- **Build stamp (B1):** `src/mind-mapper/build.ts` is clean → build → stamp: `rmSync(dist)` before `Bun.build` (kills hashed-chunk accumulation), then `dist/build.json {commit (git rev-parse --short, "unknown" tolerated), builtAt (ISO)}` — written AFTER success only, so a failed build leaves no stamped half-dist. Release-mode boot reads the stamp ONCE (missing/corrupt stamp tolerated — pre-stamp dists serve, no buildInfo); if the surface src tree exists next to the checkout (existsSync-guarded; source-free installs never walk, never warn) and its newest mtime > builtAt → STALE DIST stderr warning + `stale:true`. Wire: `/state` gains `buildInfo {commit, builtAt, stale}` spread AT THE HANDLER (release only; **ProjectState under-reports the wire again — presence's sibling**: grep server.ts, not state.ts). Boot stdout JSON gains `buildInfo` additively. Test knob (tests only): `MIND_MAPPER_SRC_DIR` overrides the src-tree location. **Release-cut prerequisite:** the committed dist/ predates the stamp — the next real `bun run src/mind-mapper/build.ts` (finalize/release, after circe's P2 lands) ships build.json.
- **R1 typed refusal:** the in-zone ratify refusal is now 409 `{error:"zoned", zoneId}` (typed `ZonedError`, CitedError/ZoneNotEmptyError family) instead of the prose-400 — menus branch on `error === "zoned"` without string-matching. Semantics unchanged: promote first, ratification (reject included) stays a main-queue act.
- **Ground-grammar footnote (G1, restated once):** a BARE id in `message.ground[]` is a node ref OR a pending-proposal ref (no `proposal:` prefix exists); `doc:<id>` is a doc ref; unknown prefixes still drop silently.
- **CLI `--ground` repeat semantics (gate rework):** `send --ground` is parseArgs-`multiple` — repeated flags ACCUMULATE and every value still splits on commas (`--ground a,b --ground doc:x` → `["a","b","doc:x"]`); blank fragments drop, and an all-blank resolve posts NO ground (never `[""]`). The falsified prior behavior (single-value last-wins: repeats silently dropped refs at exit 0 — cassandra's gate) is the reason this is a stated seam: any spell CLI copying send's flag pattern must copy the `multiple` too.

**Proof (accreting):** db.test.ts kind_author pinning test (fresh-equals-migrated), docs.test.ts setDocKind round-trips, server.test.ts K1/A1 wire tests, actions.test.ts lifecycle suite, presence.test.ts ACT1 rig (received→stalled persistence, ordered auto-flip seqs, terminal-act resolve), release-serve.test.ts build.json fixture + stale-dist rig, zones.test.ts/ratify.test.ts zoned-409 assertions.

### Contract 9 — Round 5 amendments (additive-optional; ratified per plan-round5 rulings, built 2026-07-21)

- **SUPERSESSION 3 — split stall TTL (SW1, supersedes R4's "`received → (MIND_MAPPER_ACTIVITY_TTL_MS) → stalled`"):** the received-grace is its OWN knob now — `received → (MIND_MAPPER_STALL_TTL_MS, default 150000) → agent.activity {state:"stalled"}`; `thinking → (MIND_MAPPER_ACTIVITY_TTL_MS, default 60000) → idle` unchanged. The two `setTimeout` arms in `postActivity` (server.ts) read DIFFERENT knobs. Rationale: the received→stalled window is a human-paced deliberation grace (60s false-fired twice in drive-4); the thinking→idle window is a crashed-spinner backstop (should stay tight). Everything else about ACT1 (persistence, no re-arm, agent-write resolution, `stalled` daemon-only vocabulary) is unchanged. The liveness-gate was REJECTED (a connected tail proves transport, not agent liveness — a hung agent keeps its tail open). Test knob added to the tests-only list: `MIND_MAPPER_STALL_TTL_MS`. Proof: presence.test.ts asymmetric-knob rig (`received→stalled reads MIND_MAPPER_STALL_TTL_MS, not the activity knob`).

- **Batch propose (CLI1):** `POST /proposals/batch` `{nodes:[{ref, draft, suggestedTier?, evidence?}], edges:[{draft:{source, target, label?}}]}` → `{refToId: {<ref>: <mintedNodeId>}, proposals: [Proposal...]}`. Mints a UUID per node keyed by its opaque LOCAL `ref` (author-chosen string, NEVER persisted — disjoint from the minted UUIDs); each edge endpoint resolves via `refToId.get(x) ?? x` (local ref → minted id; a real node/proposal id — or an unresolvable ref, which ratify owns — passes through unchanged). **Atomicity contract:** all validation runs BEFORE the `db.transaction()`, all inserts INSIDE it, all `proposal.added` emits AFTER commit — a throw at any stage leaves ZERO rows and leaks ZERO events (a mid-transaction emit would leak on rollback). No new event kind — the batch fans out the same per-proposal `proposal.added` (full object) the single verbs do. **Opacity holds:** a missing endpoint key stays missing (the spread injects `undefined`, which `JSON.stringify` drops), so a batched edge draft is byte-identical to a single-propose of the same draft. Node drafts round-trip verbatim. The single `propose-node`/`propose-edge` verbs are UNCHANGED. Author defaults to agent (batch is the casting loop's bulk write); an agent-authored proposal in the batch resolves ACT1 auto states, same as a single agent propose. CLI: `propose-batch --stdin`. Impl note: `propose.ts` factors a `buildProposal` (validate + compute row + wire object, NO insert/emit) shared by `insertProposal` (single) and `batchPropose` (txn). Proof: propose.test.ts batch suite (ref resolution, opacity/passthrough, atomic-rollback-zero-rows-zero-events, dup/empty ref reject) + server.test.ts + cli.test.ts round-trips.
- **Message read (CLI1):** `GET /message/:id` → the full message row `{id, seq, role, kind, text, ground: string[]|null, ts}` (grapevine `read` precedent), project-scoped — `WHERE id = ? AND project_id = ?`, so a message from another project is a 404 here, same as every other scoped read. Unknown id → 404 JSON `{error:"unknown message"}`. `ground_json → string[] | null` normalized exactly as readState does. CLI: `read <id>` (alias `message <id>`). Proof: server.test.ts (hit / unknown-404 / cross-project-404) + cli.test.ts.

- **Submap engine model (SG1):** node-anchored containment, additive + doctrine-safe. `ADDITIVE_COLUMNS.nodes = ["anchor_node_id"]` (nullable TEXT; kind_author precedent; legacy rows null = top-level). Anchor is **REAL-NODES-ONLY** — proposals stay top-level until ratified and **`ratify()` is UNCHANGED** (anchor is a separate post-ratify act, NOT folded into ratify). Strict tree (one anchor per node), **orthogonal to zone_id**.
  - **Wire (`state.nodes[]` stays INCLUSIVE):** every node ALWAYS carries `anchorNodeId: string | null` (null = top-level, the R3 zones-inclusive precedent — both owners falsified the skeleton's null-anchor/`?all` scoping) and a server-derived `submapChildCount: number` (GROUP-BY over the FULL nodes table, attached to EVERY node in EVERY response **including scoped/narrowed** ones — the badge must not lie in a submap view). **The SURFACE consumes this inclusive snapshot** and derives the submap client-side (filter on `anchorNodeId`) + the breadcrumb (parent-walk) — a server-scoped snapshot would hide the ancestors the breadcrumb needs.
  - **`/state?anchor=<id>` is a CLI/agent-only server-side narrow** (NOT the surface path): nodes filtered to `anchor_node_id = <id> OR id = <id>`, edges to both-endpoints-in-set — mirrors the `?zone` filter site. Unknown anchor id → 404. **NO `?all`** — the default snapshot IS flat/inclusive.
  - **Route:** `POST /nodes/:id/anchor {parentId: string | null}` (the FIRST `/nodes/*` route; `parentId: null` clears to top-level). Cycle guard (anchor.ts, typed `AnchorError`) = ancestor-walk from the proposed parent with a defensive `seen` set — rejects self-anchor, direct cycle, deep cycle, unknown parent, unknown node, all as 400. Emits `node.anchored {nodeId, anchorNodeId}` — a NEW **THIN** `EventKind` member (consumers flip the node's anchorNodeId locally; the union stays total). CLI: `node anchor <id> (--to <parentId> | --clear)`.
  - Proof: db.test.ts anchor pinning test (pre-SG1 nodes shape → null backfill, fresh-equals-migrated), anchor.test.ts guard suite (self/direct/deep-cycle/unknown/clear/re-parent + thin emit), state.test.ts anchorNodeId+submapChildCount, server.test.ts anchor route + inclusive-snapshot + ?anchor-narrow + unknown-404, cli.test.ts node-anchor round-trip.

- **Zone in-door (IC-c):** `POST /proposals/:id/zone {zoneId: string | null}` — move a PENDING proposal INTO a zone (the inverse of promote, which moves OUT to main); completes the drive-3 group-selected-into-a-zone gap. `zoneId: null` is the to-main move — **delegates to `promote()`** so both share one exit (the edge endpoint-order guard + the thin `proposal.promoted` event). A move INTO a zone re-emits the **FULL** proposal (with the new zoneId) via `readProposalById` (new state.ts export — the single-proposal wire shape incl. actions) so an inclusive consumer re-tags the row WITHOUT clobbering its actions (R3 payload-tagging; NO new event kind). Status mapping: unknown proposal → 404, unknown zone → 404 (typed `UnknownZoneError`), non-pending → 400. Only pending proposals move. CLI: `proposal zone <id> (--to <zoneId> | --clear)`. Proof: zones.test.ts (into-zone re-emit / to-main delegates-to-promote / 404-null-unknown-zone-nonpending) + server.test.ts round-trip + cli.test.ts.

**Proof (R5, accreting):** presence.test.ts split-TTL rig; propose.test.ts + server.test.ts + cli.test.ts batch/read; db.test.ts + anchor.test.ts + state.test.ts + server.test.ts + cli.test.ts submap; zones.test.ts + server.test.ts + cli.test.ts zone-move. mind-mapper suite 224 tests (was 199 pre-R5), all green; tsc-clean. Commits 4ba229a (SW1), 0d508ce (CLI1), 14d201a (SG1), + this (IC-c).

### Contract 9 — Round 6 amendments (additive-optional; ratified per plan-round6 rulings, built 2026-07-22)

- **buildRatify extraction (RB prerequisite, the buildProposal lesson again):** `ratify.ts` factors a `buildRatify(db, docsDir, input, bus, resolveRef?) → { apply() (db-only writes: fts reindex + node/edge/sources/proposal/actions), writeDoc() | null (deferred fs doc-edit write — single ratify only), changelogLine: string | null, emit() (deferred bus emit), result }`. All validation + edge-endpoint resolution runs in the pure build step (throws before any write); the single `ratify()` runs the pieces inline (writeDoc → apply → changelog-append → emit) so it stays byte-for-byte the pre-R6 behavior. `resolveRef` overrides edge-endpoint resolution — single ratify uses `resolveNodeRef(db)`, batch passes an idMap-aware resolver. This is the ONLY safe way to loop ratify inside a `db.transaction()`: a mid-txn emit or fs write leaks on rollback (the buildProposal atomicity doctrine).
- **NEW EventKind — `proposal.rejected {id}` (THIN, the finding-#3 root cause):** reject previously emitted NOTHING (old ratify.ts:109–114), so an agent-side reject never reached the human's board — the rejected node lingered until a manual refetch. buildRatify's reject path now emits `proposal.rejected {id}`; circe's reducer drops/flips the row live. Reject (declined-with-history, status → `rejected`) stays DISTINCT from DELETE (hard remove) — both now emit. Union stays total.
- **ratify-batch (RB):** `POST /proposals/ratify-batch {ruling, ids:[proposalId], anchors?:[{node, parent}]}` → `{idMap:{<oldProposalId>→<mintedNodeId>}, ratified:[RatifyResult]}`. **idMap = the collected per-node-proposal `{proposalId → nodeId}`** — the point of the call (reconnect an edge/anchor to the real node in one round-trip). Engine **auto-partitions** (look up each id's kind; ratify all `node` ids before all `edge` ids — NO caller ordering). **NO auto-include** of unlisted edges (explicit ids only — no silent ratifications). ONE top-level `ruling`; `ids:[{id,ruling?}]` is an additive future. `ruling:"reject"` is REJECTED outright (reject excludes a proposal from the batch — reject it singly). **Atomicity contract (mirrors propose-batch):** all `buildRatify` validation/resolution runs BEFORE the `db.transaction()`, all `apply()` INSIDE it, all changelog appends + `node.ratified`/`edge.ratified`/`node.anchored` emits AFTER commit — a throw at any stage (incl. an anchor cycle caught inside the txn) leaves ZERO rows / ZERO events / ZERO changelog lines. Edge endpoints resolve via `idMap[ref] ?? resolveNodeRef(db, ref)` (a batched node proposal's `result_node_id` isn't written until its apply runs in the txn, so the idMap is consulted first; an unratified UNLISTED node proposal still throws "ratify node proposal X first" — the no-auto-include guarantee). **Anchor-guard nuance (as-built):** anchor refs resolve via idMap-then-real; a structural pre-check (both refs resolve to a batched node or a real node; no self-anchor) runs before the txn, but the full `anchorGuard` (existence + cycle walk) runs INSIDE the txn after node inserts — a just-minted node has no row pre-txn — which is atomically equivalent (a throw rolls the txn back, emits are post-commit). CLI: `ratify-batch --stdin`. Proof: ratify-batch.test.ts (partition/idMap, no-auto-include, anchors-nest, anchor-under-real-node, reject-refused, atomic-rollback) + server.test.ts + cli.test.ts.
- **`ratify --anchor <parentId>` (RB single twin):** `POST /proposals/:id/ruling` gains additive `anchor: string`. Implemented AS `ratifyBatch({ruling, ids:[proposalId], anchors:[{node:proposalId, parent:anchor}]})` — so node-only (an edge proposal has no idMap entry → its anchor ref stays the proposal id → anchorGuard "unknown node") + atomicity fall out for free. Invalid with `ruling:"reject"`. Response = the single `RatifyResult` plus `idMap`. CLI: `ratify <id> --ruling <r> --anchor <parentId>`.
- **NEW EventKinds — `node.deleted {id}` / `proposal.deleted {id}` (both THIN):** the missing retract, equal-capability human + agent. Consumers drop the entity by id (mirror the existing `doc.deleted` reducer filter). Union stays total.
  - **`DELETE /nodes/:id[?force=1]` (DEL):** unforced + cited → typed `NodeCitedError` 409 `{error:"cited", citedBy:{edges:n, children:n}}` (the docs.ts `CitedError` precedent) — the citing set = edges touching the node (source OR target) + children anchored under it. Unknown id → 404 first. `force` cascades in one txn: delete both-direction edges, **re-parent children to top-level (clear `anchor_node_id` — do NOT recursively delete the submap; the children are real ratified knowledge)**, delete owned detritus (sources / message_sources / node_actions), clear a lens pointing at it (`DELETE FROM lens WHERE node_id = ?`), and **LEAVE the ratified proposal's `result_node_id` intact (history — the doc-delete precedent)**. Emits `node.deleted`. CLI: `node delete <id> [--force]`.
  - **`DELETE /proposals/:id` (DEL):** **THIN, NO guard** — drop the row + cascade its node_actions, any status (pending / rejected / ratified). A dependent pending edge lives only in opaque `draft_json` (Contract 8) and fails safe at its OWN ratify. This is the litter-clearing path: clear a raw instruction-node through DELETE, **not** reject. Unknown → 404. Emits `proposal.deleted`. CLI: `proposal delete <id>`. **PROC/refine-in-place uses this:** the agent refines a raw `author:"user"` node by DELETE-the-raw + propose-the-curated (there is no proposal-edit endpoint, and R6 adds none).
- **`resultNodeId` on the proposal wire (EF, surface the note):** `Proposal.resultNodeId` has ridden `/state.proposals[]` since R5 (`state.ts`, set at node-proposal ratify) — circe's EF builds the pending-edge re-point map from `state.proposals[].resultNodeId`, NO engine change (the surface `Proposal` type just needs the field surfaced).
- **DEFERRED SEAM (named, NOT built) — `proposals.claimed_by`:** the multi-agent work-queue field PROC / QUEUE / drive-4 #9 fleet-lease all share ("who is refining/leasing this pending item"). When built: additive-nullable `proposals.claimed_by TEXT` via `ADDITIVE_COLUMNS.proposals` + a thin `proposal.claimed {id, claimedBy}` event + wire `Proposal.claimedBy: string | null`. R6 ships ZERO engine queue state — the IngestionTray is a pure client view over pending `author:"user"` proposals, and DEL makes drain observable (ratify-OR-delete both fire events), so the flag is YAGNI until the multi-agent round.

**Proof (R6, accreting):** ratify.test.ts (buildRatify re-green + reject-emits-proposal.rejected); ratify-batch.test.ts (6 tests: partition/idMap, no-auto-include, anchors-nest, anchor-under-real, reject-refused, atomic-rollback-zero-rows/events/changelog); del.test.ts (6 tests: cited-guard counts, force cascade + children-re-parented + detritus + lens-cleared + history-kept, thin proposal-delete, delete-rejected, unknown-null ×2); server.test.ts + cli.test.ts round-trips. mind-mapper suite 251 tests (was 224 pre-R6), full suite 1065, all green; mind-mapper tsc-clean.
