# Session — imago refs-as-assets Phase 1 (data-model collapse)

**Date:** 2026-06-16 · **Branch:** `feat/imago-refs-as-assets` → `develop` ·
**Spell:** imago (post-V1)

## What this is

Phase 1 of [refs-as-assets](../refs-as-assets-plan.md) (#2 of the
[unified image model](../unified-image-model-investigation.md)): collapse the
separate `Reference` type/collection into the `Variant` type. A reference is now
just a library `Variant` flagged `refSelected`, so **any image — generated,
imported, or a ref — can be focused, annotated, AND pointed at for the next
generation**. Plan written → vulcan design-review (OK with changes) → cole
sign-off (incl. decision #2: drawer-as-selected-tray + a coming Library
"References" filter) → built solo (contract+server+migration+surface-repoint) →
independent implementation review → merge.

## What shipped

- **Contract (types.ts):** `Variant` += `name?/refSelected?/hash?`; **deleted**
  the `Reference` type + `refs[]` from `ImagoState`/`defaultState`. `ref.add` →
  `{image:{src,name?}}` (imports a variant + selects it); `ref.remove` →
  **deselect** (the image stays; delete is `variant.remove`); `ref.select`
  toggles `refSelected` on a variant; agent `ref.analyze` dropped (use
  `variant.analyze`). `selectedRefIds` unchanged in shape.
- **Server:** one `importImageVariant()` backs both `ref.add` + `image.import`
  with **uniform hashing + dedup-selects-the-existing** (vulcan fix A); one
  `selectedRefIds(state)` feeds both the say + commit emit sites (fix C);
  `variant.analyze` caches by hash; `leanState` drops the refs projection
  (variants already strip `src`, carrying `refSelected/name/hash` free).
- **Migration (restore):** legacy `refs[]` → an `import`-kind batch, **reusing
  each ref id as the variant id** (fix B — re-restore idempotent + historical
  `selectedRefIds` still resolve), seeding `analysisCache` from each ref's
  hash+analysis. Runs before the materialization loop. **Verified live on cole's
  real reference** (id `ref-90aa2f3b` preserved, filename carried).
- **Surface (minimal repoint; Phase 2 = the UX payoff):** the `ReferenceDrawer`
  is now the "selected" tray (variants where `refSelected`); ✕ deselects;
  OS-drop imports+selects; **dragging a sidebar image into the drawer
  ref-selects that existing variant** (the drag payload carries `variantId`, so
  no duplicate).

## Verification

- **97 tests green** — incl. 2 migration tests (id-preserved + carry-over;
  re-restore no-op / no double-create) and the `analysisCache`-seed assertion;
  biome clean; surface builds. Redeployed + cole smoke-tested live (refs
  migrate, drop-to-add, sidebar-drag-to-select, dedup).
- **Independent review** (`feature-dev:code-reviewer`) → _No → fixed_: caught a
  dropped `ref.analyze` still routed in `cli.ts analyze` (silently no-op for
  migrated `ref-…` ids), the un-seeded migration `analysisCache`, and a
  dedup-keeps-stale-name UX edge. All three fixed before merge.

## Follow-up — Phase 2 (vulcan, the UX payoff)

- Sidebar **ref badge** on `refSelected` thumbs.
- A **"References" facet** on the Library filter (browse all refs, per decision
  #2).
- **Focus + annotate a ref** from the Library (mechanically works — expose it).
- Phase-2 note (vulcan): a selected-but-unfocused annotated ref hands the agent
  vector marks + the ref path, not a burned-in composite (flatten only runs on
  the focused commit) — fine for "use THIS part."
