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
