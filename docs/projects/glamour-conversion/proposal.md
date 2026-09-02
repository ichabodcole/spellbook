# Glamour conversion — the fifth spell builds, surface and backend

**Status:** Draft **Created:** 2026-09-02 **Author:** Cole Reed + Claude Code

> **This is the first port that runs entirely on the playbook.** spell-kit built
> the pipeline and proved it on four spells; magpie was the playbook's first
> run. glamour is the test of whether the port is now _routine_ — and if it is
> not, the gap is a defect in the playbook, not in glamour.

---

## Overview

Four spells build; four do not. **glamour is the cheapest of the four remaining
and should not be queued behind the other three.** It is already React and
Tailwind — 37 tracked files, 189 KiB, a real `surface/` with `App.tsx`,
`components/`, `state/` and its own `styles.css`. bounty and grapevine are
Alpine single-pagers whose ports are surface **rewrites**; digestify waits on a
named trigger. glamour is a **relocation**, the same move the four landed spells
made.

Cole's ask is explicitly **both halves**: the surface _and_ the backend.

## Problem Statement

**glamour cannot be installed and run where nothing is installed**, which is the
property spell-kit gave the other four. Three things stand in the way, and only
the first is the obvious one:

1. **The surface has never been relocated or built.** It lives inside the
   shipped subtree at `plugins/spellbook/skills/glamour/surface/`, so a consumer
   downloads uncompiled `.tsx` that nothing will ever compile.

2. **⛔ The backend makes SIX imports into `surface/`, and every one is a VALUE
   import — zero are type-only.** This is the same structural problem the
   spell-kit proposal called _"the one genuinely hard problem"_ for imago, which
   had five. Relocating the surface breaks all six the moment it moves.

   ```
   cli.ts     optimizeImageDataUrl        ../surface/state/imageOptimize.server
   server.ts  index                       ../surface/index.html
   server.ts  loadSnapshot, materializeItem, saveSnapshot
                                          ../surface/state/persist.server
   server.ts  (reducers)                  ../surface/state/reduce
   server.ts  (style helpers)             ../surface/state/styles.server
   server.ts  (types)                     ../surface/state/types
   ```

3. **Three of those files are backend code misfiled under `surface/`.**
   `persist.server.ts`, `styles.server.ts` and `imageOptimize.server.ts` are
   named `.server` because they _are_ the daemon's, and they sit in the
   surface's folder anyway. **This is not a glamour quirk** — R1 ruled the same
   diagnosis for imago (_"the contract is not surface code; it is the daemon's
   wire protocol, misfiled"_) and magpie fixed exactly this shape in `11631d7`,
   _"the backend stops reaching into the surface, on both roots"_.

**The good news, measured:** the only bare specifiers on glamour's shipped
execution path are `node:child_process`, `node:fs`, `node:os`, `node:path` and
`node:util`. **No npm dependency reaches the backend**, so ward 1b is
satisfiable without a single change to what glamour imports.

## Proposed Solution — four phases, each with a falsifiable proof

**Phase 1 — the seam, before the move.** Relocate the misfiled backend out of
`surface/`. Nothing builds yet; nothing relocates yet. This phase exists because
**every port that moved the surface first had to solve this under time pressure
afterwards.**

> **Proof:** `grep` finds zero `../surface/` value imports in `scripts/`, the
> suite is green, and the spell still runs from the dev tree.

**Phase 2 — the surface relocates and builds.** `surface/` → `src/glamour/`,
`resolveMode()` + dev-only dynamic import, committed `dist/`, `build.ts`
generalised to a fifth spell. The `import index from "../surface/index.html"`
line is the bundler entry and is the one import that survives Phase 1 — the
playbook covers its handling.

> **Proof:** `dist/index.html` exists, the daemon serves it in release mode, and
> the installed artifact runs with **no surface source present**.

**Phase 3 — the backend builds.** `dist/cli.js` behind a three-line launcher,
per Contract 4 and the astrolabe/magpie precedent.

> **Proof:** the CLI runs at a destination that never ran `install`.

**Phase 4 — agent-legibility (SEPARATE, and optional).** glamour has **no
`acc.config.json`** — it is the only relocated-or-relocating spell without one.
This is a different axis from the port and should not be smuggled into it; it is
listed so the decision is explicit rather than forgotten.

## Scope

**In scope:** the four phases above. The new wards pick glamour up **for free**
— `spell-css-scope-ward`, `kit-adoption-ward` and `dist-roster-ward` all derive
their population from `src/`, so a relocated glamour is governed on arrival with
nothing to edit.

**Out of scope, banked:** bounty and grapevine (surface **rewrites**, a
different budget); digestify (waits on its own trigger, recorded in the trigger
registry); any kit extraction from glamour's components.

## Impact & Risks

**Benefits:** a fifth spell installs and runs where nothing is installed. The
port playbook gets its second real exercise, and **whatever it fails to cover is
a finding about the playbook** — which is worth more than the port.

**Risks:**

- _Phase 1 is larger than it looks._ Six value imports across two files, and
  `reduce.ts` / `types.ts` are shared by **both** sides — they are not simply
  "backend files in the wrong folder", and where they land is a real decision.
- _glamour's 7 tests live in `tests/`, not `scripts/`._ It is one of the three
  spells with that layout, so any glob written from a `scripts/`-shaped spell is
  blind to all of them.
- _The Tailwind scan._ glamour's `styles.css` currently uses
  `@source "./**/*.tsx"`. Contract 21 requires `source(none)` + `@source "./"`
  on arrival, or the cross-spell leak re-opens.

## Success Criteria

1. `scripts/` makes **zero** value imports into `surface/`.
2. glamour's surface builds; `dist/index.html` ships; the daemon serves it in
   release mode.
3. The **installed artifact runs with no surface source present**.
4. The backend runs from `dist/cli.js` at a destination that never installed.
5. `bun scripts/dist-check.ts` counts **five** buildable spells and stays green.
6. glamour's 7 tests stay green; no new typecheck errors.

**Explicitly not a success criterion:** that the port was fast. If the playbook
made it routine, say so; if it did not, the gap is the deliverable.

---

**Related:**

- [`docs/playbooks/porting-a-spell-playbook.md`](../../playbooks/porting-a-spell-playbook.md)
  — written for exactly this, and this is its second real run
- `.anthill/dev/seams.md` — Contracts 1, 3, 4, 21
- [`spell-kit`](../spell-kit/) — built the pipeline this consumes
