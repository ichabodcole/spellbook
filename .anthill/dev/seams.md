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
> **How contracts land here — two ways, both/and.** The **load-bearing** cross-seam contracts are
> **asserted up front and ratified** during the **plan phase** (the lead's skeleton → owners ratify
> the seams they touch — see `anthill:plan`); the rest **accrete as they're discovered**. Assert the
> load-bearing ones up front, let the long tail accrete.
>
> **Two things that make a contract here trustworthy.**
>
> **Say what it's true ABOUT, not how it's built.** A contract states the guarantee the other side may
> rely on. Implementation belongs to the owning seat; writing it here freezes a choice that wasn't
> yours and invites drift the moment the owner improves it.
>
> **Say where it ENDS — record the grain it was ratified at.** A contract confers confidence, and a
> consumer that builds **past** the agreed grain has silently manufactured a new, unratified seam. One
> team agreed a response _envelope_; a seat built at the _field_ level and got three shapes wrong —
> the contract _felt_ like it covered them. If you need a finer grain than what's recorded, you've
> found a **new seam**: say so rather than assuming.

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

### Contract 9 — Round 7 amendments (additive-optional; ratified per plan-round7 rulings, built 2026-07-22)

- **TAGS (freeform per-target tags, the exact twin of `node_actions`/A1):** `node_tags (target_id TEXT PRIMARY KEY, tags_json TEXT NOT NULL)` via CREATE TABLE IF NOT EXISTS (new table, additive by construction — NO ADDITIVE_COLUMNS entry, the zones/node_actions precedent). `target_id` is a node id OR a **PENDING** proposal id (the same disjoint-UUID-space, pending-carry, re-home lifecycle as actions). Stored as a json `string[]` — **FREEFORM**: the engine stores strings and validates only the SHAPE (`parseTags` — non-array or non-string entry → intake error; this is engine-owned metadata, not opaque-draft), never a vocabulary. Curation (reuse-suggest / autocomplete over existing tags) is circe's SURFACE concern.
  - **Wire:** `state.nodes[].tags?` AND `state.proposals[].tags?` (array of strings; **absent = none**, additive-optional — the exact actions-attach shape). Attached in `readState` on both, AND in **`readProposalById`** — the clobber catch: IC-c's zone-move re-emit runs the FULL proposal through readProposalById, so tags MUST ride it beside actions or a move-into-zone drops them (the full-shape-on-re-emit lesson, R5).
  - **Routes:** `PUT /tags/:targetId` (wholesale replace; empty array clears) and `DELETE /tags/:targetId` — twins of `/actions/`. Unknown target 404, bad shape / >16KB serialized json 400. Propose-time tags ride the `/proposals` body's additive `tags` key AND `/proposals/batch` node entries (`BatchNodeInput.tags`) — `buildProposal` validates via `parseTags` (pure, pre-txn) and writes the `node_tags` row in its `insert` closure (so a batch writes it INSIDE the one `db.transaction()` — atomic with the proposal), and attaches `tags` to the returned Proposal (post-commit `proposal.added` carries them). NO soft-cap warning (unlike actions — a folksonomy stays naturally small; the byte-cap is the only gate).
  - **New event — `tags.set {targetId, tags}` (FULL new array — wholesale metadata, not a patchable entity; the actions.set precedent).** `EventKind` stays total.
  - **Lifecycle (mirrors node_actions verbatim):** node-proposal accept RE-HOMES the row onto the minted node id (`UPDATE node_tags SET target_id`); reject deletes it; edge-proposal accept deletes it (no node to re-home onto); zone delete cascades the zone's proposals' rows (delete BEFORE proposals); node delete / proposal delete cascade the owned/target row; promote + zone-move are no-ops (the proposal id survives the move — tags ride the re-emit).
- **PORT (stable daemon port, CLI-ONLY — server already binds):** the `open` verb gains `--port <n>` (`port:{type:"string"}`), forwarded through `ensureDaemon(port?)` → daemon spawn args `[..., ...(port ? ["--port", String(port)] : [])]`. **ZERO server change** — server.ts already parses + binds `--port` (default "0"=ephemeral, main:437). Two documented wrinkles (benign for reap-resilience): (1) `open --port N` against a LIVE daemon IGNORES N (`ensureDaemon` returns the existing `livePort()` before spawning — the bind is once-at-boot, so the stable-url guarantee holds only if the FIRST open set the port); (2) port-in-use → the daemon exits and the cli poll times out ("daemon did not come up"). No graceful degrade — pick a free stable port.
- **Surface-only R7 claims (NO engine work — confirmed, stated so circe/cassandra don't re-derive):** BACKLINKS (client-derive `backlinksFor`, read-field falsified), FILTER (terminal `filteredMap` memo over the wire — status-via-pending, tier, tags-via-wire), RATIFYFIX (flat ratify-as menu items), DIRSELECT (directed `boardMap.edges` siblings), MDVIEW (extract shared `<Markdown>`), SUBMAPPEND (pending-group `ratify-batch` call — the R6 endpoint). None touch the engine.

**Proof (R7, accreting):** tags.test.ts (setTags node/proposal, unknown/ratified/rejected null, shape+byte-cap guards, empty/clear, propose-time-tags-re-home-on-ratify, reject/edge-accept/zone-delete cleanup, **zone-move-re-emit-keeps-tags** via readProposalById); db.test.ts node_tags pinning (pre-node_tags store → node_tags created, fresh-equals-migrated); server.test.ts (/tags round-trip + tags-on-propose + 404/400); cli.test.ts (tags verb round-trip; **open --port N binds N**). mind-mapper suite 254 tests (was 251 pre-R7 in scope; +tags/db/server/cli/port rows), all green; mind-mapper tsc-clean.

### Contract 9 — Round 9 amendments (the async Job Queue; ratified per plan-round9 D1–D6 + SEAMs A/B/C/E, built 2026-07-23)

_The wire circe consumes for the JobsSidebar. Written BEFORE her consuming slice (the zero-wire-guess bar). Additive-optional — every clause below is a NEW table / NEW event / NEW route; nothing existing moves._

- **The `Job` wire type (SEAM A — ratified).** `/state` gains a top-level **`jobs: Job[]`** array (unfiltered per-project read, newest-created last), where:
  ```ts
  interface Subtask { id: string; label: string; done: boolean }
  interface Job {
    id: string;
    project: string;                 // scope, self-describing on the wire
    title: string;
    status: "queued" | "running" | "blocked" | "done" | "failed" | "canceled";
    claimedBy: string | null;        // the lease (D6); null = unclaimed
    deliverable: string | null;      // D5 freeform ref: doc:id / node:id / free text
    subtasks: Subtask[];             // D4 checklist, owned wholly by the job
    detail: string | null;
    createdAt: number;               // epoch MILLISECONDS (see falsification below)
    updatedAt: number;               // epoch ms; BUMPS on every mutation
  }
  ```
  A `jobs` table lands via **`CREATE TABLE IF NOT EXISTS` — NO `ADDITIVE_COLUMNS` entry** (additive-by-construction, the zones/node_actions/node_tags precedent). `status` is **engine-owned metadata** (validated loud at intake against the enum — NOT an opaque draft; the action-slot-shape precedent). Jobs are STANDALONE state — **no target-keyed re-home lifecycle** like tags/actions (they aren't pinned to a node/proposal; D1 keeps them their own entity, and the R6 `proposals.claimed_by` seam stays deferred/subsumed).
  - **FALSIFICATION of the plan's schema (engine call, within remit):** the plan wrote `created_at TEXT / updated_at TEXT`. Built as **`INTEGER` epoch-milliseconds**, app-written (`Date.now()`), NOT a `unixepoch()` SQL default. Rationale: `updated_at` must bump on every mutation with sub-second ordering (a claim + a subtask-check in the same second must order), and the wire should carry a number like every other ts field (message `ts`, mark `ts`), not ISO text a consumer must parse. Divergence from the house `unixepoch()`-**seconds** default is deliberate and stated here so circe renders ms.
  - **Per-project scoping is NOT a conflict (SEAM A question resolved):** each project owns its own `store.sqlite`, so `readJobs` reads ALL rows (the nodes/proposals precedent, NOT messages' `WHERE project_id=?`). The `project` column is populated at create from `meta.id` and carried for wire self-description only — reads never filter on it.
- **The `job.*` events (SEAM B — RATIFIED, `job.claimed` KEPT SEPARATE).** Four new `EventKind` members (union stays total): **`job.added` · `job.updated` · `job.claimed`** each carry the **FULL Job entity** (D3 — wholesale replace-by-id, the `tags.set`/`actions.set` idiom; the reducer replaces by `id`); **`job.deleted` carries thin `{id}`**. Every full-entity emit re-reads the row through the SINGLE reader (`readJob`) before emitting, so the payload is byte-identical to `/state.jobs[]` (the re-emit-through-the-single-source-reader rule — never hand-assemble a payload a wholesale-replace consumer holds).
  - **The `job.claimed`-vs-`job.updated` call (the SEAM B decision):** kept **DISTINCT**, NOT folded into `job.updated`. A claim is a compare-and-set lease acquisition that can FAIL on contention (a plain update never does) and it's the multi-agent on-ramp's headline signal — so the engine gives circe the distinct signal. circe MAY still route `job.claimed` through the same wholesale-replace-by-id reducer case as `job.updated` (both carry the full entity) if she doesn't want a distinct surface animation — the distinct kind costs her nothing to collapse but can't be re-derived if dropped. `release` is a plain field-clear → emits **`job.updated`** (not `job.claimed`, which is acquisition-only).
- **The claim/lease protocol (SEAM C — ratified, D6 basic-only confirmed).** `claim` is a **single atomic conditional UPDATE** — `SET claimed_by=?, status='running', updated_at=? WHERE id=? AND (claimed_by IS NULL OR claimed_by=?)`. One SQL statement is atomic under bun:sqlite, so no explicit txn. Re-claim by the SAME owner matches the WHERE (idempotent success, re-sets running). A DIFFERENT owner matches nothing → typed **`ClaimConflictError`** (the ZoneNotEmptyError/CitedError family) → **409 `{error:"claimed", claimedBy}`**. Unknown id → null → 404. `release` clears `claimed_by` (status left as-is — releasing a running job doesn't un-run it). **No expiry / stealing / TTL (D6)** — the field + events are the on-ramp; contention policy waits for the multi-agent hardening round.
  - **D2 boundary HELD (no engine liveness):** the engine stores ONLY `claimed_by` + the coarse `status`. There is deliberately **NO `last_seen`/heartbeat column**. Liveness is DERIVED client-side (circe joins `jobs × agent.activity` on `claimedBy`, SEAM D — entirely her lane). If any future slice reaches for an engine heartbeat field, that breaks D2 — flag it.
- **The `/jobs*` routes + `job` CLI verb (SEAM E — ratified, body-POST twin fits every verb).**
  - `GET /jobs` → `{jobs: Job[]}` (list; `job list`).
  - `POST /jobs {title, status?, deliverable?, detail?}` → `Job` (create; title required, project from scope). `job create --title T [--status s] [--deliverable ref] [--detail x]` (or a full JSON body via `--stdin`/`--body-file`).
  - `POST /jobs/:id {title?, status?, deliverable?, detail?}` → `Job` | 404 (update; only provided fields written; bad status → 400; empty patch → 400). `job update <id> [--title/--status/--deliverable/--detail]`.
  - `POST /jobs/:id/claim {owner}` → `Job` | 404 | **409 `{error:"claimed", claimedBy}`**. `job claim <id> --owner <who>`.
  - `POST /jobs/:id/release` → `Job` | 404. `job release <id>`.
  - `POST /jobs/:id/subtask {op:"add", label}` **|** `{op:"check"|"uncheck", subtaskId}` → `Job` | 404 (unknown job) | 400 (unknown subtask on a known job — a loud throw, NOT a silent no-op). `job subtask <id> (--add <label> | --check <subtaskId> | --uncheck <subtaskId>)`.
  - `DELETE /jobs/:id` → `{ok, id}` | 404. `job delete <id>`.
  - **Route ORDER (server.ts):** exact `/jobs` (GET/POST) and every `/jobs/:id/<sub>` (claim/release/subtask) route is matched BEFORE the bare `POST /jobs/:id` update (the `/proposals/:id/zone`-before-`DELETE /proposals/:id` precedent) — a suffix route mis-ordered after the bare update would be shadowed.
  - **CLI body-mirror discipline (the R7 scar):** every `job` subcommand threads its fields into the POST body explicitly (create/update forward each provided scalar; subtask forwards `op` + `label|subtaskId`; claim forwards `owner`); `cli.test.ts` asserts the round-trip body shape per verb so a future field-add can't silently drop like `propose-node --stdin tags` did.

**Proof (R9):** jobs.test.ts (8 tests — createJob+snapshot, buildJob purity+validation, updateJob partial/validate/404, **claim-atomicity** [running+owner / idempotent-self-reclaim / foreign-owner-409 / unknown-null], release, subtask add/check/uncheck+unknown-throw, thin-delete, many-jobs-one-deliverable); state.test.ts (empty-shape gains `jobs:[]`); server.test.ts (/jobs* full wire — create-rides-/state, list, update, claim-409, release, subtasks, delete, 404/400); cli.test.ts (`job` verb round-trips every subcommand's body shape + guards). Full mind-mapper suite **265 tests** (was 254 pre-R9), all green; mind-mapper tsc-clean. Live end-to-end drive (isolated store, port 60733): CLI→daemon→event→/state confirmed — event stream `job.added → job.claimed → job.updated×3 → job.deleted`, claim-conflict 409+exit2, `/state.jobs[0]` reflects the full lifecycle.


---

## Contract 10 — The `--inbound` human-intent stream (SEAM 1, R10)

**Owner:** daedalus (server.ts filter + events.ts predicate) · **Pointed at from:** circe, prospero, cassandra · _(ratified R10, built 2026-07-24)_

**The contract, stated once.** `tail --inbound` is a server-side-filtered SSE
stream of events a HUMAN originated, so a joining agent runs ONE monitor and
cannot under-subscribe (fixes drive-8 F4/F5: an agent tailing only chat went
DEAF to the board). Correctness is owned by the surface (the daemon), not the
agent's grep.

- **Ruling: Option A (payload-field attribution).** The daemon serves ONE HTTP
  surface for TWO clients — the browser AND the CLI POST the SAME routes — so
  there is NO route-origin signal (Option B "origin-by-route" is FALSIFIED: the
  premise that surface and CLI use distinct routes is false). The only clean
  human/agent discriminator is the request BODY: `/send` `role` and
  `/proposals`(+`/proposals/batch`) `author` (browser writes "user"; CLI
  defaults "agent"). Every other board-act route (`/proposals/:id/ruling`,
  `/promote`, `/zone`, DELETE, `/tags`, `/actions`, `/nodes/:id/anchor`,
  `/doc/*`) carries NO actor and is emitted identically for both clients.
- **Admitted event set (`isInboundEvent`, events.ts):** `message.posted` where
  `payload.role === "user"` OR `proposal.added` where `payload.author === "user"`.
  Nothing else. (Covers human chat + human-dropped nodes + human two-node
  connect — the batch fans out `proposal.added[author=user]` per node.)
- **Transport: a server query param `GET /events?inbound=1`** (SSE / agent tail
  ONLY — the browser WS stream is unchanged; presence still agents-only). CLI:
  `tail --inbound`.
- **Grounding line (F5 belt-and-suspenders).** An inbound SSE opens with a first
  `data:` frame `{ kind:"grounding", inbound:true, watching:string[],
  notWatching:EventKind[], note:string }` — `watching` = the two admitted
  channels as `kind[field=value]` strings; `notWatching` = the WHOLE bus
  vocabulary minus watched (TOTAL by construction — a new EventKind is
  grounding-visible by default). It carries NO seq/epoch (informational, never a
  bus event, like CLI-synthesized `epoch.changed`) so it never advances the
  tail's cursor. The server re-emits it every inbound connect; the CLI forwards
  only the FIRST (a `grounded` flag outside the reconnect loop → exactly one per
  process).
- **No `origin` field was added.** `EventKind` is now derived from a runtime
  `ALL_EVENT_KINDS as const` array (`typeof [number]`) so the union and the
  inbound triage stay total.
- **NAMED deferral (not silent — it's in `notWatching`):** human board-acts on
  the shared actor-less routes (ratify / promote / zone-move / delete / tags /
  actions / anchor / doc) are NOT attributable in V1. Attributing them needs an
  actor field threaded onto those routes (both the surface AND the CLI must
  stamp it) — a follow-on, not quick, and it touches the surface (R10 forbade a
  surface change). Until then, `--inbound` is chat + human-dropped-nodes only;
  the agent refetches `/state` to reconcile the board.
- **Known minor edge (documented, accepted):** the IC-c zone-move re-emit runs a
  proposal's FULL wire object through `readProposalById`, so moving a
  user-authored proposal into a zone re-emits `proposal.added[author=user]` —
  which `--inbound` admits, even though the current ACTOR of the move was the
  agent. Redundant-but-not-wrong (the proposal genuinely is user-authored); the
  agent refetches state anyway.

**Proof:** events.test.ts (isInboundEvent admits human-only; triage TOTAL over
ALL_EVENT_KINDS; grounding names watched+notWatching); sse-keepalive.test.ts
(inbound SSE grounds-then-filters; non-inbound unchanged, no grounding);
tail.test.ts (`tail --inbound` forwards inbound=1 + grounding exactly once across
a reconnect); server.test.ts (`GET /events?inbound=1` end-to-end: grounds, human
send passes, agent send + agent proposal excluded). mind-mapper suite 272 tests,
all green; mind-mapper tsc-clean.

### Surface convention (SEAM 2, R10) — always-show vs hide-when-empty toggle

**Owner:** circe · _(ratified R10; **largely SUPERSEDED at R11** — see the R11
surface convention under Contract 11)_ — A surface **panel toggle** follows one of
two lifecycles: **hide-when-empty** for transient, agent-fed trays (review,
ingest) where an empty toggle is noise; **always-show (dimmed at zero)** for any
first-class panel the human is expected to author into or must be able to
discover (**jobs**). A missing toggle on a fresh session reads as a missing
feature — the F1 root cause (the jobs toggle copied the tray's hide-when-empty
gate and vanished on an empty session). Not a wire change; a surface-convention
truth. **R11 note:** this rule was the right answer to the wrong question — both
panels it governed are now deleted. It survives only for panels that genuinely
remain.

## Contract 11 — The message surface: channel-on-`kind` + activity-tied-to-a-message (SEAMs 1/2, R11)

**Owner:** daedalus (wire) · **Co-owner:** circe (consumption) · **Pointed at from:** prospero, cassandra · _(ratified R11, built 2026-07-26)_

**The contract, stated once.** Every human→agent input is ONE primitive — a message
with provenance. The channel it arrived through rides the EXISTING `messages.kind`;
the activity signal names the message it is about. No new table, no new column.

- **Ruling: the channel IS `kind`.** Not a new field. This NAMES as-built rather
  than designing: the surface already shipped `kind:"analyze"` (docs-rail Analyze,
  Claim G) before R11, so `kind` was already the arrival-affordance discriminator.
  `ground` (Contract 9's prefixed grammar) already carries the attachments. Zero
  migration.
- **Vocabulary — known, NOT closed:** `MESSAGE_CHANNELS = ["turn" (chat bar, the
  default) | "analyze" (docs-rail) | "canvas" (right-click ramble, R11)]`, exported
  from `events.ts` beside `ALL_EVENT_KINDS`. **Server-side validation is
  FALSIFIED:** a closed set would 400 the already-shipped `analyze` and would make
  every future channel a daemon change before a surface could use it. Intake stores
  an unknown channel **verbatim** and returns an additive `warning` on the `/send`
  response (the `edgeDraftWarning` precedent), mirrored to stderr by `cli send`.
  **Reject when a wrong value corrupts state; advise when it only degrades
  rendering.**
- **The vocabulary is VISIBLE on the wire:** `inboundGrounding()` gains
  `messageChannels: string[]`, derived from the same constant. F5's lesson applied
  to a vocabulary instead of a triage.
- **Canvas position is NOT carried** (no consumer). Named extension point: `ground`
  as `canvas:<x>,<y>` under the tolerated-prefix grammar — zero schema change,
  test-pinned as round-tripping verbatim. The same clause covers circe's Z3
  carry-over `zone:<id>` ground ref: engine stores it verbatim, unknown prefixes are
  the consumer's to drop. **Named consequence of "degrades to invisible" (R11 gate):**
  the `from: <Zone>` chip resolves its name from LIVE state, so **deleting a zone
  silently strips that provenance from historical messages** — the ref survives on
  the wire, its label does not. Ratified-correct (the alternative is denormalizing a
  name into every message), but pinned here so a future gate reads it as designed,
  not as a regression. **Contract 9 footnote (ratified here):**
  `message.ground[]`'s tolerated-unknown-prefix clause is an **extension point, not
  slack** — `send.ts` stores ground unvalidated, which is why `zone:<id>` shipped
  with zero engine change.
- **Contract 10 is UNCHANGED and unwidened.** `isInboundEvent` keys on
  `role`/`author`, never on `kind` — so every channel, including unknown/future
  ones, is admitted for free. `INBOUND_WATCHED` is byte-identical to R10.
  Vocabulary note: from R11 "channel" means the MESSAGE arrival channel; Contract
  10's `watching`/`notWatching` entries are EVENT PREDICATES (wire field names
  unchanged).
- **Activity ties to a message (SEAM 2, ruling B):** `agent.activity` gains an
  **additive-optional `messageId`**. It is a property of the **OPEN ladder**, not of
  an emit: the `/send` auto-flip stamps the triggering message; subsequent states
  **inherit** it when omitted (so an already-shipped `cli activity thinking` keeps
  the tie — per-emit stamping would half-fix F3 for every agent in the field); an
  explicit `POST /activity {state, messageId}` / `cli activity <state> --message
  <id>` **overrides**; the `stalled` escalation keeps it; **`idle` carries it out
  and then clears** (the consumer needs to know which badge to clear). An unknown
  `messageId` is a **400** — a mistyped tie would otherwise be a silent surface
  no-op.
- **There is NO `done` state.** The agent's reply IS completion: `/send role:agent`
  resolves the ladder, emitting `agent.activity{state:"idle", messageId}` alongside
  the reply. One fewer primitive, and it's what actually happened.
- **`/state` gains `activity: {state, messageId?} | null`** — spread AT THE HANDLER
  beside `presence` (same daemon-level-fact reason; the exported `ProjectState` type
  still under-reports the wire). In-memory, no table: a restart honestly clears.
  Without it, F3's "unmissable" signal is missable by exactly one browser refresh.
- **L2 holds (Contract 8's dumb-daemon clause):** a `canvas`-channel message does
  NOT auto-become a doc, auto-mint a node, or auto-create a job. The daemon stores
  and stamps; the agent decides.
- **NOT built (named, not silent):** channel-based multi-agent ROUTING.
  `isInboundEvent` is still a hardcoded predicate; routing wants a per-subscriber
  predicate (`--inbound --channel <c>` / `--for <agent>`) over the same filter site.
  R11 leaves the door open — it builds no router.

**Proof:** events.test.ts (MESSAGE_CHANNELS incl. the shipped `analyze`; inbound
admits every channel incl. unknown; the watched set is unwidened; grounding names
the channels) · send.test.ts (advisory silent-on-known/names-the-set; unknown
channel stores verbatim; unknown ground prefix round-trips) · server.test.ts
(`inbound=1` admits a `kind:canvas` human message + grounding carries
`messageChannels`; unknown channel → 200 + `warning`, never 400) · presence.test.ts
(auto-flip stamps the triggering id + `/state.activity`; stalled keeps it; explicit
inherit-or-override; the reply's idle carries-then-clears; unknown messageId 400s) ·
cli.test.ts (`send --kind` mirrors the advisory; `activity --message` round-trips
through /state). mind-mapper engine suite 287 tests, surface 320, all green;
mind-mapper tsc-clean.

### Surface convention (R11) — a channel in the one stream beats a second surface

**Owner:** circe · _(ratified R11)_ — **Supersedes/absorbs the R10
always-show-vs-hide-when-empty toggle rule: that rule was the right answer to the
wrong question.** A new human→agent input mode is a **channel on the message bus**,
never a new panel — it rides the wire's `kind`, stamps provenance in `ground`, and
renders in the conversation as a **visually distinct, collapsed-by-default,
filterable** bubble. Corollaries:

- **(a)** collapse-by-default applies to **human side-channel** messages only —
  collapsing agent output breaks the log's readability, the one thing the collapse
  must not do (the human has NOT read the agent's half; "I already know the content"
  is true only of their own input);
- **(b)** agent *state* about a message renders **on that message**, never in its own
  surface — and outside the collapsible body, so a folded ramble still shouts;
- **(c)** facet controls (board filter, channel filter) render **only when the facets
  exist** (present-only) — which is what the R10 always-show rule was reaching for.

The R10 rule survives only for panels that genuinely remain.

## Contract 12 — Agent ergonomics: the staging act, title refs, node edit, and the bounded delta (SEAMs 1–5/7, R12)

**Owner:** daedalus · **Pointed at from:** circe, prospero, cassandra · _(ratified R12, built 2026-07-26)_

**The contract, stated once.** Drive #10's agent broke the human's map — it ratified
nodes, then swept its pending proposals and took the edges holding them together.
Every clause below is an affordance whose absence made that easy to write, and the
round's standard is that **an interface which states what it does NOT cover beats
one with more capability** (F5.6, the `--inbound` `notWatching` precedent).

- **The staging act (SEAM 1).** `proposals.batch_id`, nullable-TEXT via
  `ADDITIVE_COLUMNS`; `Proposal.batchId: string | null` ALWAYS on the wire (the
  `zoneId` precedent), and on `readProposalById` (the standing re-emit stop).
  `POST /proposals/batch` **MINTS** one and returns it as `batchId`; a caller MAY
  supply one to **EXTEND** an act (the "I forgot the edges" repair). Single
  `POST /proposals` accepts one but **never auto-mints** — null is the honest
  answer for a lone proposal. Reuse is not rejected: a reused id means "same act",
  and the engine does not own the agent's grouping semantics (dumb-daemon clause).
  It **survives ratification because the proposal row does** — that is the payoff:
  after a PARTIAL ratification, ratified members carry their `resultNodeId`
  alongside the still-pending ones. Read side: `GET /state?batch=<id>` /
  `state --batch <id>`, inclusive of every status. **An unknown batch is a 404, not
  an empty list** — `[]` would read as "that act is fully cleared", which is the
  most dangerous thing to tell an agent mid-cleanup and is what a typo produces;
  because existence is derived (some row still carries the id), the error names
  BOTH readings. **Ratify-batch takes explicit ids only, unchanged** — R6's
  no-auto-include ruling stands.
- **Endpoint refs by title (SEAM 2).** An edge draft's `source`/`target` may be
  `title:<exact title>`. Collision-proof because ids are UUIDs and contain no ":"
  (the same fact that makes `ground`'s `doc:<id>` safe — **if ids ever become
  caller-supplied slugs, both grammars become ambiguous at once**). **EXACT,
  case-sensitive, RATIFIED NODES ONLY**; fuzzy lookup is `search`'s job, and
  pending proposals are named by local ref or proposal id. **Ambiguity is an error
  that NAMES every candidate id** (the "ratify node proposal <id> first" model).
  Resolved **AT INTAKE**, in the shared `buildProposal` — so the single and batch
  paths resolve from ONE site, the error lands in the same turn as the mistake
  rather than at the human's ruling act, and the **stored draft holds real ids** so
  a later retitle cannot re-point a pending edge. **Ratify keeps exactly one
  resolution vocabulary** (ids / proposal ids); a second `title:` site there would
  be two vocabularies free to drift. A draft with no title ref is stored
  byte-identically — opacity is unchanged for every key the daemon didn't already
  read. NOT built (named): title refs in `ratify-batch`'s `anchors[]`.
- **`node edit` (SEAM 4).** `POST /nodes/:id {title?, synopsis?}` (ordered AFTER
  `/nodes/:id/anchor`) · `node edit <id> (--title | --synopsis | --stdin)`.
  **Title and synopsis ONLY: an edit changes what a node SAYS, never what it IS or
  how it was RULED.** `tier` is the human's ruling — an agent write that re-tiers
  would overwrite a ratification act, the exact thing F2 exists to protect; `kind`
  is the same classification axis, deliberately out. **The empty-patch 400 says
  so**, so an agent reaching for tier stops at the first attempt (a deliberate
  omission that isn't in the error reads as a bug). A patch, never a wholesale
  replace; `""` clears a synopsis; an empty title is refused (it is the search key
  AND the SEAM 2 resolution key). New event **`node.edited` carrying the FULL Node**
  (replace-by-id, the `tags.set`/`job.*` idiom), re-read through a new
  **`readNodeById`** — the `readProposalById` rule arriving at a second entity, and
  now a house rule: **the moment an entity gets a full-entity event it needs a
  by-id reader**. Kept DISTINCT from `node.ratified` (arrival vs. patch; a consumer
  can collapse a kind, never re-derive a folded one). `EventKind` stays total and
  `INBOUND_NOT_WATCHED` picks it up by construction. **FALSIFIED — there is no FTS
  re-index to do:** nodes are matched by a live `LIKE` over the `nodes` table
  (`docs_fts`/`messages_fts` index docs and messages only), so an edit is
  searchable the instant it commits; test-pinned so the day node search moves to
  FTS goes red.
- **`delete-batch` (SEAM 5).** `POST /proposals/delete-batch {ids}` ·
  `delete-batch --stdin`. **Delete, not reject** — reject is a RULING with a
  tombstone and R6 already ruled it is not a batch act; delete is litter-clearing.
  **Transactional all-or-nothing**, mirroring `ratifyBatch` (validate all → one txn
  → emits after commit); an unknown id **names EVERY unknown id**, because a 44-id
  cleanup must not become a 44-round-trip bisect. Best-effort-with-a-report was
  considered and rejected: the agent's model after the call must be binary, since
  "I assumed the sweep worked" is the failure this round exists to prevent.
  **DELIBERATELY NOT BUILT: a `{batch: <id>}` shorthand.** Drive-10's bug WAS an
  over-broad cleanup; a one-keystroke batch sweep re-arms it. **The batch id is for
  LOOKING before a sweep, which is the opposite of a sweep primitive.**
- **The bounded delta (SEAM 3).** `GET /changes?since=<epochSeconds>` ·
  `changes --since`. **The plan's blocker (b) is FALSIFIED:** `nodes`, `edges`,
  `proposals` and `docs` have all carried `created_at INTEGER DEFAULT (unixepoch())`
  since P1 — an additions delta needs **zero migration**. **Option B (an append-only
  `changes` table) IS Contract 8's no-durable-event-log clause, not orthogonal to
  it:** the clause protects "events are derived-from-state, snapshot is the sole gap
  recovery", and a table whose purpose is to let an agent resume `--since` is a
  durable event log under another name; independently it would need a second write
  at ~25 mutation sites no test keeps in sync (the mirror-drift trap, twice bitten)
  with unowned retention. So: **ADDITIONS ONLY, purely derived, and self-declaring.**
  Entities are read through `readState` and narrowed by id, so each is byte-identical
  to its `/state` entry. `since` is INCLUSIVE at whole-second granularity
  (over-report, never under-report); `now` is the next watermark. **`notCovered` is
  a first-class field on EVERY response including empty ones** — deletions,
  rejections/status flips, in-place edits (`node.edited`, doc kind/marks, tags,
  actions, anchors, zone moves, lens), jobs (epoch-MS, a different unit), and WHO
  acted (Contract 10's deferral, unchanged). The note states "'nothing added' is not
  'nothing changed'." **A silent partial delta is the failure mode; this one never
  omits silently.** Named property: `created_at` is durable, so this is the ONLY
  resumable-across-restart read in the system (cursors and epochs reset on boot).
- **The error standard (SEAM 7) — a FUNNEL, not a prose convention.** Every
  agent-facing 400 goes through `badRequest(e, expected)`, which attaches an
  additive machine-readable **`expected`** field beside `error`. A funnel rather
  than 20 edited strings for two reasons: a prose convention **cannot be inherited**
  by route 21, and the biggest gap was never our validators — a malformed or empty
  body throws from Bun's JSON parser and used to 400 as "Unexpected end of JSON
  input" with **no route context at all**. (Same shape as the `projectFailure`
  funnel: one helper buys a wire-wide guarantee that N edits cannot.) Second clause:
  **an error names the WRONG shape the caller most likely sent, not only the right
  one** — `PUT /tags/:id` now says "the body IS the array … NOT `{"tags":[...]}`;
  got an object with keys: tags". Naming the correct shape is necessary; naming the
  near-miss is what closes the loop.
- **Contract 8 holds throughout.** No verb here infers, auto-relates, or cleans up:
  `node edit` writes exactly what it is given (no trim, no title-case, no
  re-derivation); title resolution is a lookup, never a fuzzy guess; `/changes`
  reports and never reconciles; `delete-batch` deletes exactly the ids named.

**Proof:** propose.test.ts (batch mint / survives ratification / no auto-mint on
single / extend an act / non-string errors; title exact + ambiguity-names-candidates
+ nodes-only + byte-identical-without-a-ref + local-and-title side by side + zero
rows on an unresolvable ref) · edit.test.ts (F2 recovery keeps tier; searchable
immediately; patch-not-replace; `node.edited` payload deep-equals `/state.nodes[]`;
named 400s; failed edit writes and emits nothing) · del-batch.test.ts (one call +
one event per id; one unknown id deletes nothing and names them all; duplicates
collapse) · changes.test.ts (created_at already exists; delta equals /state entries;
**disclosure present on an EMPTY delta**; a deletion is genuinely invisible;
inclusive boundary second; bad watermark named) · db.test.ts (batch_id backfilled
onto a hand-minted POPULATED R11 proposals table, fresh==migrated) · server.test.ts
+ cli.test.ts (every route and every CLI verb round-trips its body shape).
mind-mapper engine **328 tests**, repo **1281**, all green; mind-mapper tsc-clean.
Live drive on an isolated store (port 60741) reproduced drive-10's exact shape and
showed the orphaning is now either impossible or immediately visible.

### Surface convention (R12) — a derived warning earns its place by naming the state that makes it wrong

**Owner:** circe · _(ratified R12)_ — Before shipping a signal that fires on a
**derived** condition, find the routine workflow that transiently satisfies it
(here: ratify-node-then-edge — and an edge proposal CANNOT ratify before its
endpoints, so "node with no edges" is the *normal* mid-queue state, not a rare one).
If such a workflow exists, the fix is an additional **predicate** drawn from state
already on the wire — **never a debounce, a timer, or a threshold**. A signal that
needs a timer to stay honest is **under-specified, not noisy**. Here the second
predicate is connection *intent*: a node is unconnected only if it has no real edge
**and no still-PENDING edge proposal names it** (endpoints re-pointed
proposalId→nodeId via the same `resultNodeIdMap`/`pendingEdgesFrom` pair as the R6
EF re-point). The marker then appears only when the intent is GONE — exactly and
only drive-#10's failure shape. Quieting corollaries: submap containment counts as
connection (an anchored child or a parent holding children is placed, not floating),
and a board with fewer than two ratified nodes has no orphans (the first node on a
fresh map is not a mistake). **Second clause:** a whole-graph property is derived
over the **raw wire snapshot** and injected into the view chain as a render-time
overlay — never recomputed inside a stage that has already narrowed the graph (every
stage of `mapWithPending → zone → submap → lens → filter` hides edges, so degree
measured inside a slice invents orphans).

### Surface convention (R12b) — a controlled third-party component is a CO-AUTHOR of the array you hand it

**Owner:** circe · _(ratified R12, from the measurement-loss bug)_ — When a
controlled component **writes state back through your change handler**, it owns
fields in your array that your derive knows nothing about. Any `{...fresh}`
rebuild silently deletes the library's half — and the failure surfaces somewhere
else entirely.

**The instance:** React Flow stamps `measured` onto our nodes via
`onNodesChange`/`applyNodeChanges`. `dagreLayout`/`forceLayout` mint
`{id, type, position, data}` and nothing else, so every rebuild wiped it;
`adoptUserNodes` then reset `handleBounds` as well. The node became
**uninitialized** → rendered `visibility:hidden` **and** `getEdgePosition`
returned null for every edge touching it. It never healed because the re-measure
rides a **ResizeObserver that only fires when the element's box changes** — and
the box never changed. Measured 33% permanent failure (8/24) → 0% (0/16).

**Why it hid for so long:** the symptom (a missing **edge**) is one entity away
from the cause (a missing field on a **node**), and the two loudest "repair"
gestures — `tidy` and the layout-mode toggle — were **full replaces**, i.e. the
strongest possible way to wipe the whole board at once. They made it worse, which
reads as "nothing fixes it," which reads as a third-party bug.

**The rule:** before merging by id, ask **what fields the library puts there that
your derive doesn't produce**, and carry them. `mergeLayout` was written twice
(R6 race, R8 position-carry) carrying `position` + `selected` and dropping
`measured` both times — a merge that is *almost* right is the durable shape of
this bug. Corollary for verification: a fix here is only provable by **matched
arms with enough trials** (before-arm rates ranged 2/8–4/8; a single 8-trial arm
could not have called it).

## Contract 13 — A `/cmd` route's verdict originates in the REDUCER, not in a list beside it

**Owner:** daedalus (engine / the `/cmd` routes) · **Pointed at from:** the surface seat's reducers · _(accreted sprint 02 "success-shaped lies", P0d/#84, 2026-08-06; ratified by prospero as of comms #324)_

> **⚠ Authorship note, stated so a future reader does not infer a scope grab.** This contract's surface half lives in `glamour/surface/state/reduce.ts`, which is **circe's** file. She is unseated (third round running), and prospero ruled that the seat which made the reducer return the verdict holds the contract. **If circe is re-seated, this entry is hers to amend or falsify.**

**The contract, stated once:** a spell daemon's `POST /cmd` route must answer with a **verdict it received from the code that owns the recognised set**, never with a literal `ok:true` and never with a verdict derived from a second enumeration of command types maintained beside the dispatch.

Concretely, as built in the three co-presence spells:

- `handleAgentMsg` **returns a verdict** — at minimum a boolean, `true` iff the command type was RECOGNISED — and the route propagates it: `{ok:true, applied:true}` on recognition, HTTP **400** with `{ok:false, applied:false, error}` naming the offending type otherwise.

> **⚠ Sprint-04 amendment (2026-08-08, daedalus — found at the finalize drift-check, in my own contract, caused by my own commits).**
> This bullet said **"returns a boolean"** as a statement of as-built. That became **false for two of the three spells on the day it was written into a card lane**: `imago` (`5e6aacd`, b9) and `magpie` (`78563c6`, b13) now return
> `AgentVerdict = boolean | {recognised:true; ok:true; detail} | {recognised:true; ok:false; status; error}`, because #82's outcome contract needs a recognised command to report a MINTED ID or a REFUSAL, which one bit cannot carry.
> **glamour's `applyAgentMsg` still returns a bare boolean and the sentence is still accurate there** — so the drift was partial, which is the kind that reads as correct.
> **The contract itself is UNCHANGED and was strengthened, not falsified:** the verdict still originates in the code that owns the recognised set, and `applied` is still the field. Only the verdict's TYPE widened — a recognised command may now answer with its detail instead of a bare `true`.
> **The lesson for whoever holds this next: an "as built" sentence has a shelf life its "the contract is" sentence does not.** State the invariant in the contract clause and the current shape in a dated amendment, or the doc rots at exactly the rate the code improves.


- Where the recognised set lives in a **reducer** (glamour's `applyAgentMsg`), the reducer returns the verdict (`default: return false` / `return true`) and the server consumes it. Where the dispatch lives in the server itself (imago's if-chain, magpie's switch), the terminal `else` / `default` produces it there.
- The field is **`applied`** — bounty's existing `ApplyResult` field (`bounty/server.ts`). No new vocabulary is minted for this.

**The verdict means "was the type RECOGNISED", explicitly NOT "did state change".** These handlers contain guarded branches that legitimately do nothing (a missing id, an empty list, a wrong-typed field); a recognised-but-inert command answers `ok`. The narrower contract is a **named, unclaimed gap** (backlog: _"`ok` means recognised, not applied"_), ruled out of scope because it is a new contract rather than a defect, and because it is ~38 per-site judgements in imago alone, each able to break a working caller.

**Why it bites — and this is the general half, worth more than the instance:** the tempting implementation is a `RECOGNISED_TYPES` set beside the switch, because it needs no change to the reducer. **A hand-maintained mirror of a case list drifts silently the moment a case is added, and this repo has shipped that exact bug twice** — the bounty surface's Alpine mirror of `server.ts` helpers, and `propose-node --stdin` dropping `tags` because the CLI built its POST body from an explicit field list that the route had outgrown. In both, every test passed: the mirror and its source were each internally consistent. **A verdict sourced from the owner of the set cannot drift from it, because there is only one list.**

**Where it ENDS — the grain this was ratified at.** The contract covers the **agent-facing `/cmd` route only**. Each of these spells has a sibling `handleBrowserMsg` serving the WebSocket with a near-identical chain, and it is deliberately **NOT** in scope: a WebSocket message has no response to carry a verdict. _A builder who folds the two together because they look alike will produce a change no test observes_ — and one already did, in the session that produced this contract (34 edits landed in the wrong function of the pair; the giveaway was that `handleAgentMsg` began returning `undefined` on success). **Treat the two handlers as separate contracts with one shape, never as one contract.**

**Proof:** one RED PRE-FIX cell per spell (a bogus `type` is refused), each verified to FAIL against the pre-fix code and pass after; plus per-spell BLAST-RADIUS GUARDS asserting a valid command still answers `ok`, a recognised-but-inert command still answers `ok`, and malformed JSON is still refused at the PARSE layer — that last one is what makes the red cell discriminating rather than vacuous, because it proves the refusal path existed independently of the fix. `glamour/tests/daemon.integration.test.ts`, `imago/tests/server.integration.test.ts`, `magpie/tests/daemon.integration.test.ts`; commit `14bec41`.

## Contract 14 — the digestify departure record (`POST /left`)

**Owner:** circe (surface emit) · **Co-owner:** daedalus (route + the 124 payload) · **Pointed at from:** prospero, cassandra · _(ratified on the wire #690→#694; surface half built `fbfe1d3`, cells `7135287`)_

**The contract, stated once:** on `beforeunload`, when the review has not been submitted, the digestify surface **always** beacons `POST /left { engaged, elapsedMs, answered, commented }` — sent **before** `/cancel`.

- **`engaged: false` is RECORD-ONLY. The server MUST NOT call `resolveDone` on it.** This clause is the whole safety of the design: it is what lets a clean close be *reported* without a page refresh being able to end a session.
- `/cancel` is **unchanged** and still fires only when engaged. house-style's exit-code contract pins **130** to *"closed tab after interacting"*, so the `dirty` gate is canon, not incidental — the predicate is provably unmoved (`!submitted && dirty && sendBeacon` before; an early return on `submitted || !sendBeacon` plus `if (dirty)` after).
- `elapsedMs` is measured from **page load**, not from daemon start: it answers *"how long did the human have it open"*, which is the fact that separates a read-and-declined from a glance. It cannot say when the review was created.

**Why it bites:** measured with matched arms before anything was built — *"a human opened it, read it and left"* and *"nobody ever opened it"* produce **byte-identical stdout and the same exit 124**. There is no information difference for a timeout payload to name, so **b4's output half cannot be completed without this emit half**; the board encodes that as b4 blocked-on-b4s.

**Proof:** `digestify/scripts/review.test.ts` — two cells, mutation-calibrated (34→36, +2; each mutation reddens **only** its own cell: a syntax error fails the parse cell, reverting the pre-b4s handler fails the beacon cell). Browser-driven both arms: `engaged:false` → `/left` alone; `engaged:true` → `/left` then `/cancel`.

⚠ **HALF-PROVEN, and this stays until it is not:** the **server half is NOT BUILT**. daedalus holds `/left` + the 124 payload as b4's remainder. Until then the surface emits into a route that does not exist (harmless — `sendBeacon` is fire-and-forget), and **the `engaged:false` record-only clause is unenforced by anything except this contract.**

## Contract 15 — The spell CLI process contract (error envelope + registry single-sourcing)

_Owner: daedalus. Ratified 2026-08-27 (mind-mapper acc L0 session, comms #1100/#1105); single-sourced here from the seats' finalize returns — seat docs point, never restate._

Every house spell CLI answers a FAILURE as **one JSON document on stderr with stdout empty**:

```
{ ok: false,
  error: { kind, exit_code, retryable, message, hint?, choices?, server? },
  meta:  { command } }
```

- **Kinds → exits:** `usage` 2 · `internal` 1 · `not_found` 5 · `conflict` 6. `kind` is the contract; `message` is presentation — a caller that matches on prose is out of contract, and rewording a message must never break one.
- **`choices`** rides any rejection whose valid alternatives form a closed set (verbs, sub-verbs, per-verb flags). A real-but-misplaced flag is never called "unknown" — the two-stage parse (whole-registry strict, then verb-subset presence check) is what makes that message honest.
- **`error.server`** (mind-mapper's extension, candidate clause for the other spells): a daemon-HTTP refusal is WRAPPED, its JSON body carried verbatim under this key — typed bodies keep their shape one level down, the process contract stays one stderr doc.
- **Registry single-sourcing:** one flag registry (**no defaults in it** — stage-2 stray detection is key-presence; defaults live at consumption `??`) + one verb→flags spec (path-keyed where subcommands exist) drive parser, help, rejections, and the drift wards. `--version` is a **root TOKEN, never a registry flag** — registering it re-scopes it under every verb; the flag-invariant ward's FOREIGN pin is the standing answer (magpie:version precedent, astrolabe:version pinned 15513af).
- **Delivery:** throw a typed error and let `main` RETURN the code (`process.exitCode` + natural return, never `process.exit` where stdout may hold >64KB) — and any catch-all retry loop in scope must rethrow the typed error (tail's reconnect loop, daedalus seat doc).

**Proof:** `plugins/spellbook/skills/mind-mapper/scripts/cli-contract.test.ts` (11 cells: dispatch↔spec drift wards, subprocess failure table asserting `error.exit_code === process exit`, help-advertises twin line-anchored per bb13208). Adopted today by: magpie, astrolabe (minimal 2-kind form), grapevine (prose errors — predates this contract, conversion unscheduled), mind-mapper (full form). acc rule B5 holds this checked on every `acc check` run wherever `defaultOutput: json` is declared.
