# Spell Surface Pipeline — dev plan (skeleton)

**Status:** RATIFIED — all seams settled (A/C/D ratified, B resolved: `src/`
relocation, Option A). Ready for lane-authoring + build. **Lead:** prospero
**Proposal:** [proposal.md](./proposal.md) (`7701a07`)

This is the **thin lead-authored skeleton** — the integration order and the
cross-seam contracts as _claims_. Each owner **ratifies or falsifies the seams
it touches before moving its card `todo→doing`**, then authors its own lane file
`plan/<seat>.md` and builds against the ratified contracts. The skeleton is a
hypothesis, not blanks to fill.

## How this plan is authored

- **prospero (lead)** owns this skeleton, the seams section, the
  release/packaging lane, the verification gate, and the atomic land.
- **Each owner** owns its lane file: `plan/circe.md`, `plan/daedalus.md`,
  `plan/thoth.md`, `plan/cassandra.md` — the file-level HOW for its slice,
  authored after its seams ratify.
- Load-bearing ratified contracts get promoted into `.anthill/dev/seams.md`.

## Integration / dependency order

The reference spell is **astrolabe** (in-repo React conjuration, currently T2 /
serve-time bundled). The slices come together bottom-up:

1. **circe + daedalus** — astrolabe surface pipeline: the two-mode surface (dev
   serve-time bundle; release pre-built `dist/`) and the server.ts
   mode-resolution that serves it. _(Seam A. This is the core mechanism
   everything else validates.)_
2. **prospero** — the release-path build step + packaging: build `dist/` before
   a cut, settle what the published plugin includes/excludes. _(Seam B. Depends
   on 1 — needs a `dist/` to package.)_
3. **thoth** — canon: write §1–§5 into `grimoire/house-style.md` (amending "The
   build — there isn't one") + the backend repeal-rule; keep `inscribe`/`ward`
   in lockstep. _(Seam C. Ratifies against what 1–2 actually landed — canon must
   not describe fiction.)_
4. **circe** — scaffold templates in `scaffold/` (cantrip / conjuration-template
   / conjuration-react), the last embodying the pipeline exactly as canon
   prescribes. _(Derives from the astrolabe reference + Seam C.)_
5. **cassandra** — validation: the release-cut acceptance gate (§ Verification
   gate). _(Last. Local simulation first; the real published-plugin check is the
   final gate.)_

## Shared interfaces — _ratify on the vine, then fill_

### Seam A — daedalus ↔ circe — surface serve + mode resolution (RATIFIED — daedalus × circe → seams.md Contracts 1–2)

> **Ratified 2026-07-07.** Both sides ratified; circe **empirically built**
> astrolabe's surface (`Bun.build` + `bun-plugin-tailwind`, tokens + `@source`
> utilities present). Contract promoted to `.anthill/dev/seams.md` (Contract 1
> serve/mode, Contract 2 dist layout). Landing requirements: convert
> `server.ts:63` static import → dev-only dynamic (the live deps-free-crash
> fix); daemon emits resolved mode; `dist/` flat-root + relative `./` assets;
> **`dist/` must be un-ignored + committed** (it's gitignored today → else
> nothing reaches the cache); build via a bare `build.ts` at skill root (no
> per-spell package.json).

The daemon serves the surface one of two ways, resolved at startup:

- **Ownership split (claim):** circe owns `surface/` (source), the
  `bun run build` script, the `dist/` output shape, and `bunfig.toml`. daedalus
  owns `server.ts` including the route that serves the surface. They meet at
  this contract.
- **Mode resolution (claim):** `server.ts` selects **release** iff `dist/`
  exists at the skill root, else **dev**; overridable by env var
  (`SPELLBOOK_SURFACE_MODE=dev|release`).
- **dev (claim):** the surface HTML entry is imported via a **dynamic,
  dev-only** `await import("../surface/index.html")` — never a top-level static
  import (a static import forces Bun to resolve the whole surface build graph at
  daemon load, which crashes a deps-free release daemon). Bun bundles `.tsx` +
  Tailwind at serve time (cwd = skill root so `bunfig.toml` is found). HMR on.
- **release (claim):** `server.ts` serves static files from `dist/`
  (`dist/index.html` + hashed assets); zero runtime surface deps touched.
- **dist layout (claim):** `bun run build` (via `Bun.build`) emits
  `dist/index.html` + assets at the skill root; the build runs in-repo with root
  deps present.

### Seam B — prospero ↔ circe/daedalus — release packaging (RESOLVED — Cole chose relocation)

**Cole's ruling: relocate surface source OUTSIDE the plugin subtree (Option
3).** Rationale: separate what you author from what you deploy; don't mix skill
contents with deployed contents or work around the missing filter in weird ways.
This **collapses the seam** — there is no packaging filter and no
release-branch: the published `plugins/spellbook` git subtree is **source-free
by construction** because the surface source simply isn't in it.

**Mechanism (exact repo layout — RATIFIED by Cole: `src/`, Option A):**

- Buildable spell source lives at a top-level **`src/<spell>/<aspect>/`** tree
  (sibling to `plugins/`, `grimoire/`, `docs/`), outside the plugin. Today the
  only aspect is `surface/`:
  `src/astrolabe/surface/{index.html, main.tsx, App.tsx, styles.css, bunfig.toml}` +
  `src/astrolabe/build.ts` (the spell's build orchestrator, at the spell root so
  it can build >1 aspect later).
- **`src/` = build-input ONLY (Option A).** Backend source stays authored in
  place in the deployed folder (it ships verbatim, isn't built). If the backend
  ever hits its repeal criterion and becomes built, its source moves to
  `src/<spell>/backend/` **additively** — the `src/<spell>/<aspect>/` shape
  absorbs a new built-aspect with no refactor. That future-proofing is why
  `src/` (general) beats `surfaces/`.
- The **deployed spell folder** `plugins/spellbook/skills/<spell>/` carries
  backend source (`scripts/`, `SKILL.md`) + the **committed `dist/`** — and no
  surface source.
- `src/<spell>/build.ts` reads `src/<spell>/surface/` → writes
  `plugins/spellbook/skills/<spell>/dist/` (cross-tree).
- **`dist/` un-ignored + committed** in the spell folder (hard prerequisite —
  else nothing reaches the cache). `src/` stays normally tracked (dev material,
  never shipped — it's outside the plugin subtree).

**Ratified prerequisites (unchanged):** `dist/` committed; no new version
pipeline.

**Reframed identity (for thoth's canon):** the **deployed** spell folder stays
self-contained and zip-able (dist + backend = everything needed to run); only
**authoring** splits. "Self-contained" now describes the deployed artifact, not
the dev layout.

**Implications to design right (seat lanes):**

- **daedalus (Seam A dev path):** dev-mode dynamic import now points at the
  relocated `src/<spell>/surface/index.html`, not `../surface/`. Resolve via a
  stable anchor (repo-root walk or a computed constant), not a brittle deep
  `../../../..` relative path. Release mode unaffected (serves local `dist/`).
- **circe:** `build.ts` cross-tree in/out paths; the `conjuration-react`
  scaffold now scaffolds **two coordinated locations** (surface-source tree +
  deployed spell folder).
- **thoth:** canon reflects the split + the reframed "self-contained = deployed
  artifact" identity; inscribe's "clone the folder" language updates for the
  two-location shape.

### Seam C — thoth ↔ circe — canon ↔ scaffold consistency (RATIFIED — thoth × circe, with corrections)

> **Ratified 2026-07-07 with three structural corrections (adopted):** (a) canon
> **splits** — re-scope the existing "no build step" rule to be **backend-only**
> (→ seams.md Contract 3, not a new rule), and add a **new sibling section** for
> the surface pipeline; the old "the moment it feels like erecting a building,
> stop" boundary check is **reversed for release builds** and re-homes into the
> §5 guardrail. (b) Canon states the **contract** and **points to** astrolabe +
> the `conjuration-react` scaffold for the mechanism (no inlining — anti-drift;
> template-as-executable-canon is house doctrine). (c) **Don't enshrine 4 ladder
> rungs** — only the **T2→T3 line** is canon-bearing; write the rule off the
> single trigger (distribution OR dependency-richness), keep the table
> illustrative. inscribe/ward touch-points identified (incl. a real gap: ward's
> "self-contained spell" checklist is T3-blind). Authority: thoth owns canon
> wording, circe owns template code + `scaffold/README`.

- **Canon location (claim, ratified by Cole):** §1–§5 land in
  `grimoire/house-style.md`, not a new recipe/canon doc yet.
- **Consistency (claim):** the `conjuration-react` scaffold template embodies
  the exact pattern canon prescribes (Seam A shape); canon and template cannot
  diverge. thoth owns the wording, circe owns the template; they ratify against
  Seam A as landed.
- **Backend repeal-rule (claim):** canon states backend ships as Bun-native
  source with the repeal criterion from proposal §1 (daedalus provides the
  wording input).

### Seam D — cassandra ↔ all — acceptance gate (RATIFIED — cassandra)

> **Ratified 2026-07-07.** cassandra traced the real install channel:
> marketplace = git-clone of the repo at `main` HEAD; the daemon runs from a
> plain copy of the `plugins/spellbook` subtree in
> `~/.claude/plugins/cache/…/<version>/` (no `.git`, no `node_modules`, no
> `dist/`). Gate is two-stage: (1) **local-sim** — build `dist/`, copy
> `SKILL.md`+`scripts/`+`dist/` (NOT `surface/`, `bunfig.toml`) to a path with
> no up-tree `node_modules`, run the daemon, assert it boots + serves `dist/` +
> `mode==="release"` + browser-drives styled (recipe in cassandra's lane); (2)
> **real cut** — human-gated (Cole publishes), with a **dry-run rehearsal**
> (`git clone` the branch, inspect the would-be plugin subtree: `dist/` present,
> `surface/` absent). Also adds a **fresh-agent T2→T3 pass** (canon+scaffold
> alone must transmit the fix) and a **regression guard** (32 existing test
> files stay green + smoke-launch each daemon spell). Note: glamour/imago/magpie
> share the same static-import crash latent today — out of scope here, relevant
> to the follow-on ports.

- **Gate definition (claim):** validation is a **real Spellbook release cut**,
  then a fresh-install inspection of the published plugin: astrolabe serves its
  **pre-built** surface, depends on **no surface source/deps** at the
  destination, runs and looks correct.
- **Two-stage (claim):** cassandra runs a **local simulation** first (build
  `dist/`, run the daemon against a copy with `dist/` but no root
  `node_modules`, confirm release mode serves); the **real published-plugin
  check** is the final gate and requires prospero to prepare the cut and **Cole
  to publish** (push/release is Cole's, not autonomous).

## Slices (one per owner → lane file)

- **circe → `plan/circe.md`** — astrolabe two-mode surface (dev dynamic import +
  `bun run build` → `dist/` + bunfig); then the three `scaffold/` templates.
  Consumes Seam A, C.
- **daedalus → `plan/daedalus.md`** — astrolabe `server.ts` mode-resolution +
  release static serve; backend repeal-rule wording input. Owns Seam A (server
  side).
- **prospero → `plan/prospero.md`** — release-path build step +
  packaging/manifests; the land. Owns Seam B.
- **thoth → `plan/thoth.md`** — house-style §1–§5 + repeal-rule; inscribe/ward
  lockstep; `scaffold/README`. Owns Seam C (canon side).
- **cassandra → `plan/cassandra.md`** — local-sim + real release-cut validation;
  a fresh-agent pass (can a cold agent take a spell T2→T3 from canon +
  scaffold?). Owns Seam D.

## Verification gate

"Assembled and correct" = **Seam D's acceptance gate met**: astrolabe runs
unchanged in dev **and** its release build produces a working `dist/` the daemon
serves in release mode; the local simulation passes; and a real release cut
yields a published plugin that serves the pre-built surface with no source/dep
dependency at the destination, running and looking right. No regression for the
T0–T2 spells. cassandra engages after slice 4; the real cut is Cole's.

## Ratified decisions & edge cases (from proposal + design session)

- astrolabe is a **distribution** case (ships via Spellbook's own marketplace;
  the plugin-cache destination has no repo-root `node_modules`) — which is
  exactly why pre-built `dist/` is the fix. Its build runs **in-repo** with root
  deps, emitting zero-dep `dist/`.
- Backend "no build" holds as a **preference with a repeal criterion**, not a
  law.
- Delivery is **Approach A** only.

## Assert what's ABSENT

- **No per-spell `package.json` / isolated `node_modules` for astrolabe.**
  Isolation (proposal §3) is validated by `media-buffet:library` (foreign-host /
  dep-rich), **not** astrolabe — astrolabe builds in-repo against root deps.
  Don't add isolation to astrolabe hunting a mirror that isn't there.
- **No shared build module, no `wand` CLI** (Approaches B/C are out of scope).
- **No backend build step** (source-only stands).
- **No new version pipeline** (release-please's version flow is untouched; only
  a build/packaging step is added).
- **No migration of the T0–T2 spells.**

## Open questions

- Because the published artifact is **surface-source-free** (Seam B ruling),
  release mode at the destination has no `surface/` and no `bunfig.toml` to
  bundle from — so it **must** serve `dist/` statically, and the
  cwd-must-be-skill-root / bunfig coupling matters **only in-repo dev**. Confirm
  in Seam A ratify that release mode has zero dependency on bunfig/surface at
  the destination.
- Where does the pre-release build step live — a root `package.json` script
  prospero runs before the cut, or a CI step in the release workflow? (Seam B /
  prospero lane.)
- What is the packaging-exclude mechanism for surface source in the published
  plugin (a `.claudeignore`-style ignore, an `npmignore`/`files` allowlist, a
  release-workflow prune)? The Spellbook marketplace publish path must support
  it. (Seam B / prospero lane — verify the mechanism exists before relying on
  it.)
