# Spell Surface Pipeline

**Status:** Draft **Created:** 2026-07-07 **Author:** Cole Reed + Claude Code
(merlin)

---

## Overview

Spells began as static HTML pages and have climbed a steady complexity ladder —
Alpine + Tailwind, then React, and now (with `media-buffet:library`) React with
real installed dependencies shipped into a foreign host repo. That last rung
broke an assumption baked into the framework's canon: `house-style.md` still
says _"The build (there isn't one)."_ It was right for the lightweight surfaces
of the early spells; it is no longer right for the richest ones.

This proposal defines the **Spell Surface Pipeline** — a standard for how spell
surfaces are built and distributed once they cross into needing real
dependencies or shipping to another codebase. It is deliberately narrow: it
changes nothing about the seven existing spells' day-to-day, and it introduces a
build step **only at the surface tier, only when triggered** — while naming the
invariant that has _not_ changed (agent + user in one equally-present shared
surface) and preserving the self-contained, fork-to-hack character that makes
spells hackable.

The standard is proposed as a **hypothesis**: define it, then pressure-test it
against a real spell (astrolabe) before tooling it further.

## Problem Statement

The framework's build philosophy — "self-contained, no build step, zip one
folder and run" — was correct for T0–T2 surfaces (see the ladder below) and
remains correct for them. But three forces have outgrown it:

1. **Surface richness increased.** UIs went from a single HTML template to full
   React apps with component libraries. Past a threshold, a surface wants
   _installed_ dependencies, not CDN scripts or shared root deps.
2. **Spells started shipping into other repos.** `media-buffet:library` ships as
   a Claude Code plugin _inside_ media-buffet's repo. Serve-time bundling at an
   arbitrary destination was the **root of four concrete coupling failures**
   (Bun auto-install disabled by a host `node_modules`; react/react-dom pin
   collision with the host; a peerDep postinstall that broke the host's
   `bun dev`; a tree-shaken-hollow SDK). See
   [[spell-deps-resolution-in-host-repo]].
3. **No standard exists for the spells that need it.** The build step was
   hand-rolled once, for one spell. There is no convention, no reference, no
   scaffold — the current instruction to start a spell is literally "clone an
   existing spell," and none of the seven exercises a real build.

Without a standard, every dependency-carrying or distributed spell re-derives
the same pipeline by hand, and each re-derivation is a fresh chance to hit the
same coupling failures.

## Proposed Solution

### Framing: the surface complexity ladder

Every spell's surface sits on a rung, and the rung dictates the build posture:

| Rung   | Surface                                        | Deps          | Build             | Example                           |
| ------ | ---------------------------------------------- | ------------- | ----------------- | --------------------------------- |
| **T0** | static HTML                                    | none          | none              | digestify                         |
| **T1** | Alpine + Tailwind over CDN                     | CDN           | none              | bounty                            |
| **T2** | React via serve-time Bun bundling              | root deps     | none (serve-time) | astrolabe, glamour, imago, magpie |
| **T3** | React + installed deps, and/or **distributed** | isolated deps | **release build** | media-buffet:library              |

The standard makes the **T2 → T3 transition** first-class. **T0–T2 are
unchanged.**

### The invariant, and what changed

What has _not_ changed, and defines a spell: **agent and user share one
equally-present surface to work a thing out and converse about it**
(co-presence). What _has_ changed: surfaces can now be as robust as a full app,
and "lightweight / no-build" is no longer treated as part of the identity — it
was a stage, not the essence.

### §1 — Two tiers, one repeal-rule

- **Backend** (daemon / CLI / server): ships as **Bun-native source, no build.**
  Bun runs `.ts` directly; this is why it remains the right core tech.
  - _Repeal criterion:_ revisit when a backend dependency or capability
    genuinely needs a compile/bundle step and holding source-only costs more
    than the build would. Watch for that signal. (This mirrors how the surface
    philosophy itself evolved — not wrong then, outgrown when richness crossed a
    threshold.)
- **Surface**: the only thing that ever builds.

### §2 — The surface pipeline: one pipeline, two modes

There is a single surface pipeline with two modes — the build step is not a new
regime, it is the pipeline's _release mode_ that today's spells simply never
invoke:

- **dev** = serve-time Bun bundling + HMR (exactly today's astrolabe). Fast
  iterate loop.
- **release** = pre-built to `dist/` (static HTML/JS/CSS); **zero runtime
  surface deps** at the destination.

_Mechanism_ (proven on `media-buffet:library`): the surface HTML entry is a
**dynamic, dev-only import** so a release daemon never pulls the surface build
graph into its load path (a static top-level `import` would force Bun to resolve
the whole surface build at daemon load, crashing a deps-free release daemon).
Mode **auto-resolves by `dist/` presence**, with an environment-variable
override.

### §3 — Dependency isolation (the T3 trigger)

Two independent triggers, **either** of which pulls a surface to T3:

1. **Distribution** — the spell ships into a foreign host repo. (Correctness
   necessity.)
2. **Dependency-richness** — even an in-repo spell wants a real UI framework /
   component library beyond CDN + root deps. (Capability-driven.)

- **When triggered:** the spell carries its **own `package.json` + isolated
  `node_modules` + committed lockfile**; host SDKs resolve via `bun link`, not
  registry deps. This never couples to (or breaks) a host repo's dependency
  tree.
- **When not triggered:** shared root deps remain the default for simple in-repo
  spells. No regression for T0–T2.

### §4 — What a distributed spell ships

Distinguish the **origin repo** (source of truth) from the **published /
distributed artifact** (what a consumer installs):

- **Origin repo** keeps everything, but **split across two trees** (ruling,
  `prospero` session): buildable source lives at a top-level
  `src/<spell>/<aspect>/` tree (today `src/<spell>/surface/` + `bunfig.toml`,
  plus `src/<spell>/build.ts`), _outside_ the plugin; the deployed spell folder
  `plugins/spellbook/skills/<spell>/` holds backend source + the committed
  pre-built `dist/`. `src/` = build-input only — backend source stays authored
  in the deployed folder until it ever needs building, at which point it moves
  to `src/<spell>/backend/` additively (the `<aspect>` shape absorbs it with no
  refactor).
- **Published artifact is surface-source-free by construction:** the marketplace
  copies the whole git-tracked plugin subtree and there is **no file-exclusion
  mechanism** in Claude Code (verified) — so the exclusion is achieved by
  **relocation, not a packaging filter**: surface source simply isn't in the
  shipped subtree. The artifact ships `dist/` + backend source, cannot trigger a
  surface coupling failure (the surface is an inert pre-built bundle with zero
  deps at the destination), and stays light as interfaces get richer.

Consequences:

- **Consume-as-is** = install the published artifact; the daemon serves the
  pre-built `dist/`, touching no surface source or deps.
- **Fork-to-hack** = go to the **origin repo**, edit the surface source under
  `src/<spell>/surface/`, `bun run dev` (on-the-fly + HMR), rebuild `dist/`. A
  slim "source lives at &lt;repo&gt;" pointer in `SKILL.md` is a deferred future
  nicety.

**"Self-contained" now describes the deployed spell folder** (dist + backend =
everything needed to run), not the dev layout — authoring is split, deployment
is whole. (A spell committed _into_ its consuming repo — as
`media-buffet:library` was — is the degenerate case where origin and destination
coincide.)

### §5 — The guardrail (the Astryx lesson, as a rule)

Surface dependencies must stay within the **Bun-serve-time-bundlable stack**
(React, Tailwind via `bun-plugin-tailwind`, shadcn/Base UI, lucide — all handled
by Bun's HTML-import bundler at serve time). A **compile-time CSS-in-JS engine**
(StyleX — the Astryx path — vanilla-extract, Panda) requires a transform Bun's
serve path cannot run, which would force a build **into the dev loop**.

> A dependency that would force a build into the dev loop is a **dependency
> smell**, not a reason to add dev-time build machinery. Reconsider the
> dependency.

See
[Astryx evaluation](../../investigations/2026-07-06-astryx-component-library-evaluation.md).

### §6 — Delivery: Approach A, staged toward C

- **Now (this project):** codify §1–§5 as house-style canon; designate a
  **canonical reference spell**; fill the currently-empty `scaffold/` with real
  starter templates (cantrip / conjuration-template / conjuration-react).
- **Ratchet to B** (a shared surface-build module) _when_ hand-carrying the
  pipeline demonstrably hurts across 2–3 spells — extract once the duplication
  shows where the seam belongs.
- **Ratchet to C** (the `wand` CLI owning `new / dev / build / release`) _when_
  B has proven the API and the goal shifts to the open-source framework/content
  split.

The standard is the invariant; A/B/C is only _how much of it is tooled vs.
copied_, ratcheted up as evidence accumulates.

### How it's experienced

- **Author of a simple in-repo spell:** nothing changes. Clone the reference,
  write your surface, `bun run dev`. No build, no per-spell deps.
- **Author of a rich / distributed spell:** clone the reference, `bun install`
  isolated deps, develop with `bun run dev` (HMR), then `bun run build` to
  produce `dist/` for release. Ship source + `dist/`.
- **Consumer of a distributed spell (a host repo / tenant):** drop the folder
  in; the daemon runs the backend from source and serves the pre-built `dist/`.
  Installs nothing for the surface.

## Scope

**In Scope (MVP):**

- The standard itself (§1–§6) written as canon **in `house-style.md`** (see §6 —
  graduation to a recipe / dedicated canon doc is deferred until the pattern
  settles): house-style rules (with repeal criteria), the surface-pipeline
  contract (dev/release modes + mechanism), the isolation rule, the guardrail.
- The **in-repo canonical reference** — astrolabe, post-pressure-test, becomes
  the Spellbook-native spell others clone for the T3 pattern.
- Real **scaffold templates** for the three starting shapes.
- **Pressure-test on astrolabe via a real Spellbook release cut** (see Success
  Criteria): validates the standard end-to-end through the actual distribution
  channel, not just a local build.

**Out of Scope (initially):**

- The shared surface-build module (Approach B).
- The `wand` CLI (Approach C).
- Any change to backend build posture (source-only stands, per §1).
- Migrating existing T0–T2 spells (they are already correct).
- Reworking release-please / version automation.

**Future Considerations:**

- **Follow-on validations** after astrolabe, to prove the standard beyond one
  spell:
  - _Porting_ existing complex React spells where it makes sense — **imago**,
    **glamour**.
  - _Greenfield_ — **mind-mapper** (not yet started): likely complex UI plus
    additional dependency installs for graphing behavior, making it a strong
    native T3 candidate built _on_ the standard from day one.
- B and C, gated on the ratchet criteria in §6.
- An agent-legibility layer (component/wire-contract manifest) — the borrowable
  Astryx idea — for whatever component foundation the house library lands on.
- Whether the pipeline generalizes to non-React surface stacks.

## Technical Approach

The pipeline is already implemented once, in `media-buffet:library` — this
project **generalizes** that implementation into a framework-level contract
rather than inventing anything new. Key existing pieces it draws on:

- Bun's HTML-import serve-time bundling + `bun-plugin-tailwind` (today's T2 dev
  mode; requires the daemon's cwd = skill root so `bunfig.toml` is found).
- The dynamic dev-only HTML import + `dist/`-presence mode resolution
  (media-buffet's release-mode addition).
- Per-spell `package.json` + isolated `node_modules` + committed lockfile +
  `bun link` for host SDKs (the isolation resolution from
  [[spell-deps-resolution-in-host-repo]]).

Key dependencies: Bun (HTML bundler, native TS, `Bun.serve`), Tailwind v4 +
`bun-plugin-tailwind`, the existing `inscribe`/`ward` authoring rituals (which
will reference the new canon), and `release-please` (unchanged).

## Impact & Risks

**Benefits:**

- Dependency-carrying and distributed spells get a **correct, repeatable** path
  instead of a hand-rolled one — closing the four coupling failures by
  construction.
- The framework gains a first-class **T3 tier** without disturbing T0–T2.
- Lays the groundwork for the framework/content split and an eventual
  open-source `wand`-driven framework.

**Risks:**

- _Abstracting too early._ Mitigated by staying at Approach A and gating B/C on
  evidence.
- _The standard was derived from one spell and might not generalize._ Mitigated
  by the astrolabe pressure-test — the whole point of the
  hypothesis-then-validate ordering.
- _Erosion of the self-contained value._ Mitigated by §4 (ship inert `dist/`,
  keep source
  - build script for fork-to-hack) — the spell stays hackable and drop-in.
- _Guardrail ignored._ A future spell adopts a StyleX-class dep and drags a
  build into dev. Mitigated by §5 as explicit canon.

**Complexity:** Medium — the mechanism is already proven; the work is
generalization, canon-writing, scaffolding, and one validation pass.

## Resolved Decisions

_(Were open questions; settled in the `prospero` design session.)_

- **Pressure-test is a real release cut, not local mechanics.** Cut a Spellbook
  release, then inspect the _released plugin_: confirm the shipped spell
  contains only the **distributed (pre-built) surface files, not source**, that
  it runs and looks right with no surface build/deps at the destination. That is
  the ultimate test. _Implication:_ the release path must gain a surface-build
  step for release-mode spells (build → include `dist/`, exclude/ignore surface
  source at the destination) — the plan will pin exactly what this touches
  (pre-release build step and/or release-please/CI, packaging ignores).
- **Canonical reference lives in our repo.** astrolabe is the first instance;
  the Spellbook-native spell — not `media-buffet:library` (another repo) — is
  what others clone.
- **Canon stays in `house-style.md` for now.** Defer moving it to a recipe or
  dedicated canon doc until the pattern has settled and we're confident in it.

## Success Criteria

- The standard is written such that a fresh agent can take a spell from T2 to T3
  by following canon + scaffold, without re-deriving the coupling-failure fixes.
- astrolabe runs unchanged in dev **and** produces a working pre-built `dist/`
  served by its daemon in release mode — proving the one-pipeline-two-modes
  contract on a second, independently-built spell.
- **The release cut is the acceptance gate:** a freshly-installed Spellbook
  release contains astrolabe's surface as **pre-built distributed files only (no
  source, no surface deps)**, and the installed spell runs and looks correct.
  This proves the "consume-as-is = inert `dist/`" property through the real
  distribution channel.
- No regression for the T0–T2 spells.

---

**Related Documents:**

- [Astryx component-library evaluation](../../investigations/2026-07-06-astryx-component-library-evaluation.md)
  — source of the §5 guardrail
- Memory: `spell-deps-resolution-in-host-repo` (the distributed-spell build
  model), `spell-surface-stack`, `astrolabe-spell`,
  `co-presence-ambient-vs-intent`
- `grimoire/house-style.md` — "The build (there isn't one)" (the canon this
  amends)
- `docs/fragments/2026-05-29-the-wand-mage-cli.md` — the Approach C endgame

---

## Notes

Design was brainstormed in session `prospero` (2026-07-07). Ordering decision
(Cole): **propose the standard as a hypothesis first, then pressure-test against
a real spell** — so this proposal is the hypothesis and astrolabe is the
validation. Backend "no build" is held as a _preference with a repeal
criterion_, not a law — the same evolutionary posture that produced this
proposal in the first place.
