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
