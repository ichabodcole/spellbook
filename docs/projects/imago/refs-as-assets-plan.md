# Plan — imago references-as-assets (#2 of the unified image model)

Status: **reviewed by vulcan (OK with changes) — pending cole sign-off** · Date:
2026-06-16 · Implements item #2 of
[`unified-image-model-investigation.md`](./unified-image-model-investigation.md).

## Goal (cole's direction)

References shouldn't be a special kind of image. A reference is **just a library
image that's currently selected to point the next generation at.** Any library
image can be focused on the canvas and **annotated** (so an annotated ref
becomes a pointing gesture: "use THIS part of this image"). Dragging a sidebar
image into the references area selects it; dragging an external image into
references also lands it in the library; removing from references **deselects**
it (does not delete it).

## The core decision — collapse `Reference` into `Variant`

`Reference` and `Variant` already overlap: both carry
`id / src / path / analysis`. `Reference` adds `name / selected / hash`;
`Variant` adds `seed / model / liked`. So unify on **one asset type — the
`Variant`** — and make "is a reference" a flag, not a type:

```ts
// Variant gains (all optional → generated variants are unaffected):
name?: string;        // editable label (was Reference.name; generated → derived "variant c")
refSelected?: boolean; // "pointed at for the next generation" (was Reference.selected)
hash?: string;        // content hash for import dedup (was Reference.hash)
// DELETE: the `Reference` type and `refs: Reference[]` from ImagoState.
```

- **The library = `batches[].variants`** (everything). A **reference = any
  variant with `refSelected`**.
- **External reference images become variants in an `import`-kind batch** — the
  exact path `image.import` already uses for brought-in working images. "Add a
  reference" = import the image as a variant + set `refSelected`.
- Every variant is already focusable (`focus.set`) and annotatable
  (`marksByVariant[variantId]`), so **annotating a ref needs zero new
  machinery** — that's the whole payoff.

Rejected alternatives: keep `refs` separate but make it focusable/annotatable
(keeps the special-case the goal is removing); a new top-level `assets`
collection (bigger restructure, no benefit over reusing `variants`).

## The references drawer — keep it, as a "selected" tray

cole's mental model keeps a references area you drag _into_. So the bottom
`ReferenceDrawer` (Canvas.tsx) stays, but becomes a **view of the selection**:
it renders the variants where `refSelected` (the "what I'm pointing at for the
next gen" tray). The **left sidebar (Library) shows a ref indicator**
(ring/badge) on `refSelected` variants — selection is visible in both places
(the Ouija board). The Styles tab is untouched (styles are a separate concept).

Drag flows:

- sidebar variant → drawer ⇒ set `refSelected`.
- external image → drawer (or composer) ⇒ import as a variant + `refSelected`.
- ✕ in the drawer ⇒ clear `refSelected` (the variant **stays** in the library).

## Contract changes

```ts
// ImagoState: DROP `refs: Reference[]`. (Variant gains the 3 fields above.)

// ClientToServer — repointed to variants (the `id` is now a variantId):
| { type: "ref.add"; image: { src: string; name?: string } } // import as a variant + refSelect (was {reference:{…}})
| { type: "ref.remove"; id: string }   // DESELECT (clear refSelected) — NOT delete; delete is variant.remove
| { type: "ref.select"; id: string; selected: boolean } // toggle refSelected on a variant

// AgentCommand:
| { type: "ref.select"; id: string; selected: boolean } // variant refSelect
// DROP `ref.analyze` → fold into the existing `variant.analyze {id,text}`

// say / marks.commit events: selectedRefIds is unchanged in shape — just sourced
// from variants where refSelected (instead of state.refs).
```

`leanState`: drop the `refs` / `refForAgent` projection; variants are already
projected (`variantForAgent` strips `src`), so `name/refSelected/hash` ride
along for free. The agent reads refs as "variants where refSelected."

## Migration (restore)

Old snapshots have `refs: Reference[]`. On restore: synthesize one `import`-kind
batch whose variants are the old refs (carry `name / analysis / hash`,
`refSelected = ref.selected`), then drop `refs`. Idempotent (only runs when
`refs` is present + non-empty). No marks to migrate (refs had none).

## Phases

**Phase 1 — data model (contract + server + migration; redeploy).** Variant
gains the 3 fields; drop `Reference`/`refs`; repoint the `ref.*` handlers +
`selectedRefIds` source + `leanState`; the restore migration. Update
`ReferenceDrawer` minimally to read `refSelected` variants so nothing breaks.
Tests: ref-select toggles a variant; ref.add imports a variant + selects;
ref.remove deselects but keeps the variant; migration converts old refs;
selectedRefIds reflects variant selection. **Acceptance:** refs behave as today
from the user's seat, but are now variants under the hood.

**Phase 2 — the UX payoff (surface).** Sidebar ↔ drawer drag to select/deselect;
external-image → drawer import+select; the **ref indicator on sidebar thumbs**;
**focus + annotate a ref** from the library (already works mechanically — just
expose it). Retire any dead `Reference`-specific surface code.

**Phase 3 — cleanup.** Remove dead paths; confirm no `Reference` references
remain; SKILL/mediaforge notes if the agent-facing ref verbs changed.

## Risks

- **Migration** touches the restore path (like the layer-system migration did) —
  cover with a test that an old `refs` snapshot becomes import-batch variants
  with selection/analysis preserved, and that re-restore doesn't double-create.
- **`ref.remove` semantic flip** (deselect, not delete) — a behavior change;
  document it. Deleting a ref-that's-also-an-image is now `variant.remove`.
- **Two emit sites** (`say` + `marks.commit`) compute `selectedRefIds` — both
  must switch to the variant source together.
- **Dedup** moves from `refs` (by hash) to import-time (don't re-import the same
  external image twice); generated variants have no hash, so dedup only applies
  to imports.
- **Agent contract**: `ref.analyze` collapses into `variant.analyze`, and
  `ref.*` ids become variant ids — a fresh-agent note + SKILL touch.

## Open decisions (for vulcan review + cole sign-off)

1. **Collapse `Reference`→`Variant` + `refSelected`** (recommended) — confirm.
2. **Keep the references drawer as a selected-tray** (recommended) vs. drop it
   and show ref-selection only as a sidebar ring.
3. **`ref.remove` = deselect, not delete** — confirm the semantic.
4. **`name` on generated variants** — auto-derive ("variant c") or leave blank
   until the user/agent names it?
5. Anything in Phase 2's drag UX that should be vulcan's call (drawer-as-drop vs
   sidebar-ring-toggle, where the ref indicator sits).

## Review folded in (vulcan, 2026-06-16) — verdict: OK with changes

Core collapse confirmed (overlap verified against types.ts/server.ts; lean
projection free; reuses image.import's proven import-batch path). No blockers.

**Must-fix before build:**

- **A — uniform import hashing + select-on-dup.** Today only `ref.add` hashes
  (server.ts:742); `image.import` doesn't. If both mint import variants but only
  ref-origin ones carry `hash`, dragging the same file to the canvas then to
  refs makes a duplicate. Fix: **hash ALL imports** (image.import computes
  `contentHash` too), and dedup-on-add **selects the existing variant** instead
  of the current silent `return` (server.ts:744). Keeps the hash-keyed
  `analysisCache` (:754) working across both paths.
- **B — id-preserving migration.** The restore transform reuses each old
  `ref.id` as the new variant `id` (don't mint fresh): re-restore idempotency is
  automatic, and any historical `selectedRefIds` baked into past say/commit
  events still resolve. Runs AFTER the shallow `{...defaultState(),...snap}`
  merge (server.ts:301-309), gated on `state.refs?.length`, then
  `delete state.refs`. First real data-RESHAPING migration on that path →
  dedicated test asserting id-preservation + analysis/refSelected carry-over +
  **re-restore is a no-op (count unchanged)**.
- **C — single `selectedRefIds(state)` helper.** Extract one
  `state.batches.flatMap(b=>b.variants).filter(v=>v.refSelected).map(v=>v.id)`
  and call it at both emit sites (say :632, marks.commit :1096) — kills the
  "both must change together" drift permanently.

**Design confirmations (resolved):**

1. Collapse Reference→Variant — **YES.**
2. Keep the drawer as a selected-tray — **YES**, _but_ add a **"References" (or
   "Imported") facet to the Library filter** so the hand-picked "ref shelf"
   mental model is reconstitutable on demand (the drawer narrowing to
   refSelected-only otherwise dissolves it). Ref indicator = a **top-left corner
   badge** on the sidebar thumb (not stacked on the like/focus corner);
   drag-INTO-drawer stays the primary select gesture; the sidebar ring is the
   indicator (click-to-toggle optional).
3. `ref.remove` = deselect not delete — **YES**, with UX caveats: change the
   gesture message text ("deselected", not "removed"), and ensure delete is
   obviously reachable (the Library ✕ / `variant.remove` already shipped).
4. `name` on variants — **blank for generates** (keep the index-derived "a"/"b"
   display label; a stored name would go stale on reorder/delete); **imports
   default `name` to the filename** (genuine provenance).
5. (folded into 2 above.)

**Phase-2 note (D):** flatten only runs on `marks.commit` for the FOCUSED image,
so a selected-but-unfocused annotated ref hands the agent **vector marks + the
ref path, not a burned-in composite**. Fine for "use THIS part" (marks read as
the pointer); if a composite is wanted, the user focuses + commits the ref. Make
it a conscious Phase-2 note, not a surprise.
