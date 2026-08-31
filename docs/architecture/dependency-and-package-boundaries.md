# Dependency and Package Boundaries

**Created:** 2026-08-31 **Last Updated:** 2026-08-31 **Last Reviewed:**
2026-08-31 @ `efab3a8`

## Overview

This repo looks like a monorepo — many apps, shared code, one install — and it
is **not one in the mechanism that matters.** It has **one root `package.json`
and no per-app manifests**, and that is correct today rather than an oversight.

This document exists to record **why it is correct now** and, more importantly,
**the signals that would say it has stopped being correct.** The decision costs
nothing today; the risk is that nobody notices the day it starts costing
something.

## The decision

**One root `package.json`. No per-spell manifest, no workspaces, no per-app
dependency declaration.**

## Why it works — the entry point decides, not the manifest

In a conventional monorepo (Turborepo, nx, pnpm workspaces) a package's manifest
determines two things: **what gets installed** for that app, and **what gets
published** with it.

**Neither applies here.**

- **Nothing installs at the destination.** The marketplace clones the
  git-tracked `plugins/spellbook` subtree; `plugin.json` has no dependency
  field, `marketplace.json` has no install or build hook, and there is no
  `package.json` anywhere under `plugins/`. There is nowhere to declare a
  dependency and no step that would act on one.
- **What ships is whatever the bundler can REACH from that spell's entry**, not
  what a manifest claims.

**Measured at `efab3a8`** — five of the root's nine dependencies appear in
exactly one spell's bundle:

| dependency       | astrolabe | imago | mind-mapper |
| ---------------- | --------: | ----: | ----------: |
| `@xyflow/react`  |         0 |     0 |           2 |
| `@dagrejs/dagre` |         0 |     0 |           1 |
| `d3-force`       |         0 |     0 |           7 |
| `micromark`      |         0 |     0 |          11 |
| `@base-ui/react` |         0 |     0 |         208 |
| `lucide-react`   |        22 |    60 |          53 |

Bundle sizes track it: astrolabe 1.02 MB, imago 1.20 MB, mind-mapper 2.32 MB.
Even `lucide-react` is tree-shaken **per icon**.

> **A manifest can be wrong; reachability cannot.** For the concern that
> motivates per-app manifests — _"don't ship code this app doesn't need"_ — the
> bundler gives a **stronger** guarantee than a manifest would, at finer
> granularity.

## What we give up, and what it costs

**Phantom-dependency detection.** The root `dependencies` is a **flat union with
no record of who needs what.** One spell can import a package another spell
declared and nothing objects; an unused dependency is findable only by grep.

**The cost is bookkeeping, not bytes.** A root dependency costs **dev install
size only** — zero shipping cost, per the table above. That asymmetry is the
whole reason this shape is fine.

## ⚠ The signals that say this has stopped being correct

**None of these is live today. Each is a real trigger, and the point of this
document is that the next reader recognises one when it arrives.**

### 1. Two spells need DIFFERENT VERSIONS of the same dependency

**The sharpest trigger, and the one with no workaround.** A flat union cannot
express it — one version wins and the other spell is silently built against a
dependency it did not ask for. **If you find yourself pinning a version "for
now" because another spell broke, that is this trigger.**

### 2. A spell ships INTO another repository

**Already identified from the media-buffet work, and the closest to live.**
Bun's auto-install switches off when a `node_modules` exists up-tree, so a spell
dropped into a host project **cannot resolve anything it did not bring.** A
spell distributed that way needs its own dependency manifest, and the root one
is invisible to it.

### 3. A harness installs per-skill

The Agent Skills standard makes the **skill directory** the distribution unit. A
harness that installs one folder would expect that folder's manifest — the same
cross-harness pressure that excluded emission option 1
(`plugins/spellbook/lib/`) from the backend-sharing ruling.

### 4. A spell's dependency set becomes an argument

If someone needs to answer _"what does astrolabe actually depend on?"_ and the
answer requires building it and reading the bundle, the flat union has stopped
being adequate bookkeeping. Today grep answers it; that holds only while the
roster is small.

## What to do when one fires

**Do not reach for workspaces reflexively.** The first two triggers are
satisfiable by a **per-spell manifest that declares but does not resolve** — a
record of intent that the bundler still ignores. Full workspaces buy per-app
installs, which this repo has no use for while nothing installs at the
destination.

**And re-derive the shipping guarantee before changing anything.** The reason a
manifest is unnecessary today is reachability, and reachability is a property of
the bundler. If the build strategy changes, this document's whole argument must
be re-measured rather than inherited.

## Important gotchas

- **A native addon is not covered by any of this.** It bundles without error and
  fails at the consumer, because a `.node` binary cannot be inlined into
  JavaScript. That is a dependency _kind_ problem, not a manifest-shape problem,
  and no arrangement of `package.json` files addresses it.
- **Per-app boundaries here are enforced by WARDS over imports, not by manifests
  over declarations.** Ward 2 (`src/kit/` is a leaf), ward 3 (no cross-spell
  reach) and Contract 17's ungoverned-zone gap do the job a workspace's package
  boundaries would. **That is why the wards carry so much weight in this repo**
  — they are the load-bearing structure a monorepo gets from its manifests.

## Related documentation

- Seams **Contract 3** (backend ships as source — amended, staged), **Contract
  4** (source-free by construction), **Contract 17** (`src/<spell>/` is
  ungoverned), **Contract 18** (verified by reproduction)
- [Cross-harness spell distribution](../investigations/2026-08-30-cross-harness-spell-distribution.md)
  — where triggers 2 and 3 come from
- [Porting a spell](../playbooks/porting-a-spell-playbook.md)

## Revision history

| Date       | Change                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-31 | Created after spell-kit sprint 02 made backend bundling real, which is what raised the question of whether per-app manifests were now needed. Measured: they are not. |
