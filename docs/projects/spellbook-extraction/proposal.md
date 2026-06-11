# Spellbook Extraction — splitting the agent-surface spells into their own repo

**Status:** Approved (structure) · migration pending **Created:** 2026-05-28
**Author:** Cole Reed (with familiar)

---

## Overview

The agent-surface tools that grew up inside the `project-docs` monorepo's
`toolbox` plugin — Digestify, Grapevine, Tuskboard, Magpie — have cohered into a
distinct category with its own manifesto: **agent-conjured apps** ("spells").
This project extracts them into a dedicated repo, **Spellbook**, structured to
embody the manifesto rather than just house the code. The structure was decided
collaboratively; this doc records those decisions and the migration that
follows.

See `../../PROJECT_MANIFESTO.md` for what a spell _is_.

## Problem Statement

- The spells are mixed in with unrelated utility/methodology skills
  (maestro-testing, screenshot-optimization, html-mockup-prototyping) under one
  `toolbox` plugin.
- They share **one version line**, so a fast-iterating spell (grapevine, already
  at internal V1.6.7 / plugin 2.9.0) drags the whole plugin's version on every
  patch.
- The category now has a **manifesto and a craft** (fresh-agent testing,
  scenario capture, rule decay) that have no home in a generic plugin repo.

## Proposed Solution

A new `Spellbook` repo that is its own Claude Code **plugin marketplace**, with
the craft machinery as a first-class citizen.

**Decisions locked (this session):**

1. **Scope — the 4 spells only.** `digestify`, `grapevine`, `tuskboard`,
   `magpie` move. The 3 utility/methodology skills stay in the `project-docs`
   toolbox. (They aren't spells by the manifesto's definition — no agent-runtime
   surface.)
2. **Packaging — single `spellbook` plugin, 4 skills, versioned together.**
   Mirrors today's toolbox shape; one install. (Per-plugin-per-spell was
   considered for independent semver but rejected for simplicity; revisit if
   version drag becomes painful.)
3. **Shared code — the light path.** Self-contained spells (zip one folder, it
   runs), no build step. Shared-ness lives as the `scaffold/` (the
   `agent-surface-bun` recipe, graduated in) plus the `house-style` conventions.
   No runtime `packages/core` import — it would break the cached-plugin path and
   contradict the manifesto's "scaffold plus a house-style skill."
4. **Craft machinery — a dedicated `grimoire/`.** `house-style.md`,
   `scenarios/`, `fresh-agent/`, `decay-ledger.md`, `trigger-registry.md`. Makes
   the manifesto's co-evolution thesis structural rather than buried in generic
   docs folders.

**Sub-decisions:**

- `inscribe` authoring skill is **repo-dev-only** (`.claude/skills/`), not
  shipped — authoring is a maintainer act.
- `scaffold/` is **not shipped** as a skill initially (parked, not designed
  away).
- Grimoire is **seeded, not stuffed** — real conventions in `house-style.md`,
  protocol + templates only in `scenarios/` and `fresh-agent/`.

## Scope

**In Scope (this project), in order:**

1. **Migrate the 4 spells' code + SKILL.md** into `plugins/spellbook/skills/` —
   the first real step; everything else keys off it. Rewire each spell's
   hardcoded plugin-cache path to the `spellbook-marketplace` location, and
   re-point its feedback touchpoint at this repo.
2. **Derive the scaffold** from the migrated spells' genuinely common patterns —
   _after_ seeing them, not by pre-crossing-over the recipe. Fold the
   `agent-surface-bun` recipe's still-relevant substance in at that point.
3. Move the in-flight `grapevine-v1.7` project docs over.
4. **Validate-or-trim the seeded grimoire rules** against what the migration
   actually showed — the subtraction pass on the `(seed)` decay-ledger rows.

_Already done:_ repo skeleton, grimoire seed, `inscribe`/`ward`, tooling (Biome
/ Zed / Prettier / Husky), release-please + CI.

**Deferred to post-release (Cole-driven):**

- Removing the 4 skills from the `project-docs` toolbox + bumping it; updating
  that marketplace + the recipe pointer. **Until then the spells stay duplicated
  in `project-docs` — that's fine.** Cole is the only user, so there's no
  install-compat window to manage; removal happens once the Spellbook
  marketplace is released and installed.

**Out of Scope:**

- The utility skills (stay in `project-docs`).
- The **liaison/emissary** spell (manifesto §4) — future; name parked in the
  trigger registry.
- A `packages/core` shared lib / build step.
- Remote / multi-human surfaces.

**Future Considerations:** **publishing the ability to create spells** — a
shippable spell-creator (`inscribe` is the seed) so users make spells in any
project and merge back (see
[fragment](../../fragments/2026-05-29-publishable-spell-creator.md)); per-spell
versioning if drag returns; the liaison spell; **the wand** — a mage-facing
Rust/Ratatui CLI+TUI at top-level `wand/`, driven by a per-spell `spell.json`
capability contract (see
[fragment](../../fragments/2026-05-29-the-wand-mage-cli.md)). Unblocked once the
spells migrate. Also: a **feedback / report-issue capability** — GitHub issues
against the Spellbook repo, modeled on `project-docs:report-issue` — so the
per-spell feedback touchpoints (a house-style requirement) have a destination.
HiveMind may become a second channel later, but it's not depended on. Also: a
**thematic rebrand** — unifying the spells under one cute-occult aesthetic
(rename candidates + shared mascot style), ideally pre-release while renames are
cheap (see
[fragment](../../fragments/2026-05-29-spellbook-aesthetic-and-rebrand.md)).

## Technical Approach

```
Spellbook/
├── .claude-plugin/marketplace.json     # spellbook-marketplace (1 plugin)
├── plugins/spellbook/
│   ├── .claude-plugin/plugin.json      # v0.1.0, versioned as a whole
│   └── skills/{grapevine,digestify,tuskboard,magpie}/   # self-contained
├── scaffold/                           # placeholder; templates derived post-migration
├── grimoire/                           # house-style · scenarios · fresh-agent
│   ├── house-style.md                  #   · decay-ledger · trigger-registry
│   ├── scenarios/  fresh-agent/
│   ├── decay-ledger.md  trigger-registry.md
├── .claude/skills/inscribe/            # repo-dev authoring ritual
└── docs/                               # project-docs scaffold + mirrored manifesto
```

A spell: `SKILL.md` + `scripts/{cli,daemon}.ts` + `*.test.ts` + `assets/`.
Cantrips ship no daemon; conjurations ship one. Bun runs `.ts` natively — no
build.

## Impact & Risks

**Benefits:** clean category boundary; independent release cadence from
project-docs; the craft (testing/scenarios/decay) gets a real home; the
manifesto becomes structural.

**Risks:**

- **Path rewiring (low — single user).** Every spell SKILL.md hardcodes
  `…/cache/project-docs-marketplace/toolbox/<ver>/skills/<spell>/scripts/cli.ts`;
  the Spellbook copies must point at
  `…/spellbook-marketplace/spellbook/<ver>/…`. Cole is the only user, so no
  install-compat dance — just rewire the new copies. Toolbox originals stay
  duplicated and are removed only post-release. (Watch the running grapevine
  daemon's launch path at cutover, but it's a convenience, not a hazard.)
- **In-flight work.** grapevine V1.7 is mid-design; migrating mid-stream risks
  losing thread. Mitigation: move the `grapevine-v1.7` project docs as part of
  the cutover, before resuming V1.7.
- **Two repos to keep coherent.** The `agent-surface-bun` recipe currently lives
  in project-docs; after graduation, leave a pointer there to avoid drift.

**Complexity:** Medium — the structure is simple; the path-migration and
dual-repo coordination are the real work.

## Open Questions

- Version start for the `spellbook` plugin: `0.1.0` (chosen, signals young) vs
  carrying grapevine's `2.9.0` lineage. Revisit at first release.
- Do the project-docs toolbox's removed skills get a tombstone/redirect, or a
  hard removal with a CHANGELOG note?
- Structural homes for the parked manifesto items (liaison; mask vs vessel) —
  deferred until they're being built.

## Success Criteria

- A fresh agent can install the `spellbook` marketplace and cast all 4 spells
  with no reference back to `project-docs`.
- `bun test` passes for each migrated spell.
- The grapevine daemon runs from the new cache path; no stale toolbox-path
  references remain in shipped SKILL.md files.

---

**Related Documents:**

- [Project Manifesto](../../PROJECT_MANIFESTO.md)
- Operator → Spellbook → "The Spellbook" manifesto + "Agent-Orchestrated Micro
  Apps" paradigm fragment (canonical living sources)
- `project-docs/plugins/recipes/.../agent-surface-bun/RECIPE.md` (graduating
  into `scaffold/`)

---

## Notes

### Status of the scaffold (created 2026-05-28)

Skeleton laid down this session:

- ✅ `marketplace.json`, `plugins/spellbook/.claude-plugin/plugin.json` (v0.1.0)
- ✅ `plugins/spellbook/skills/README.md` (spell anatomy + migration note)
- ✅ `scaffold/README.md` — **pulled back to a placeholder** (2026-05-29): the
  real templates get _derived_ from the migrated spells, not pre-written.
  Forwards to "clone an existing spell" + the recipe for now.
- ✅ `grimoire/` — `house-style.md` (seeded rules; `(seed)` rows validated
  during migration), `scenarios/` (4 captured this session + README/TEMPLATE),
  `fresh-agent/` (protocol + TEMPLATE), `decay-ledger.md`, `trigger-registry.md`
  (4 spells + parked liaison)
- ✅ Fragments: `the-wand-mage-cli`, `publishable-spell-creator` (future
  directions, captured not built)
- ✅ `.claude/skills/inscribe/SKILL.md` (authoring ritual)
- ✅ `.claude/skills/ward/SKILL.md` (consistency checklist — the project-docs
  `scaffold-update-checklist` analog, themed)
- ✅ `docs/PROJECT_MANIFESTO.md` (mirrored from Operator)
- ✅ Tooling: Biome + `.zed/settings.json` + Prettier (markdown) + Husky
  pre-commit (lint-staged, format-only — typecheck/test gate deferred until
  spells land; Rust `cargo fmt`/`clippy` gate deferred until the wand crate
  exists). `package.json` scripts: `format`, `format:md`, `lint`, `lint:fix`,
  `check`.
- ✅ release-please: `release-please-config.json` (root `node` package, version
  synced into `plugin.json` via the `extra-files` json updater),
  `.release-please-manifest.json` (`0.1.0`),
  `.github/workflows/release-please.yml` (on push to `main`). Branching:
  **`develop → main`** flow (work on `develop`, merge up via finalize-branch;
  release-please opens release PRs on `main`) — same as project-docs. The
  workflow's `main` trigger is already correct for this.

**Not yet done (the migration):** moving the 4 spells' code, graduating the
recipe, rewiring cache paths to the spellbook marketplace, grapevine-v1.7 doc
move. These are the next deliberate step. project-docs deprecation is **deferred
to post-release** — spells stay duplicated until then.
