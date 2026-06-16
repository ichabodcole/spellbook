# Session — imago layer system: Phase 3 (transform polish)

**Date:** 2026-06-16 · **Branch:** `feat/imago-transform` → `develop` ·
**Spell:** imago (post-V1)

## What this is

Phase 3 of the imago [layer system](../layer-system-plan.md) — transform polish
on image layers — built by the atlas/vulcan grapevine swarm right after Phases
0–2 merged. Two slices, pure surface (no contract/server change): cole's
**aspect-constrained scaling** ask plus the planned **rotation**.

## What shipped

**Slice A — aspect-constrained scaling** (`d7ac4e1`). Corner-handle resize can
lock aspect ratio. Image-first defaults:

- **Image** marks: corner-drag is **aspect-locked by default** (you rarely want
  to distort a photo); hold **Shift to free-distort**.
- **rect / ellipse / draw**: corner-drag **free by default**; **Shift to lock**.
- **Edge** (n/e/s/w) handles are never locked — explicit 1-axis stretches.
- Mental model: "Shift = the other aspect behavior."

`resizeBoxAspect` projects the drag onto the anchor→corner diagonal for one
uniform scale factor (opposite corner fixed), with the min-size clamp gated on
the smaller side so neither axis underflows. The gesture re-reads Shift each
pointermove, so toggling it mid-drag flips behavior live.

**Slice B — rotation, image-first** (`4f23b3f`). A rotation handle on the
selection frame; `rotation` is a single scalar that flows through the existing
`mark.update` path (**zero contract/server change**). Threaded through every
site that must agree so **live == handoff == hit-test**:

- `rotatePoint(p, deg, c, aspect)` rotates in the image's **isotropic pixel
  metric** — fraction space is anisotropic, so it converts through
  `aspect = natW/natH` (a raw-fraction rotation would shear non-square images).
- MarkRenderer + flatten: identical `rotate(deg cx cy)` group wrap about the
  bbox center in natural-px.
- `hitTest` un-rotates the test point into the mark's local frame, then runs the
  existing axis-aligned geometry.
- SelectionOverlay: a rotate gesture (absolute aspect-corrected pointer angle,
  +90° so up=0/clockwise=+ matching SVG); **rotated-resize composes with slice
  A** by un-rotating the drag delta into the local frame before the aspect-lock
  resize runs; the chrome (outline + handles) CSS-rotates about the same center
  so it rides a rotated mark.

**Image-first call:** the plumbing (render/flatten/hit/gesture) is **generic on
`m.rotation`** because it abstracted for free, but the **handle affordance is
scoped to image marks** — clean image-first without a special-case fork.

## Verification

- **77 tests green** (11 in the new `tests/transform.test.ts`): aspect math
  (uniform scale, off-diagonal projection, opposite-anchor fixed, min clamp,
  corner-vs-edge routing, free-distort baseline) + rotation math (90° square,
  identity, 16:9 round-trip, aspect anisotropy) + a **rotated `hitTest`**
  integration case (added to close the review's coverage note). biome clean.
- **Live e2e** (Playwright, fresh daemon): select an image → rotation handle
  renders; drag → **57.4° committed** via `mark.update`, image visibly rotates
  and the chrome rides it; corner-drag on the rotated image → **aspect held
  exactly** (2.3211 → 2.3211).

## Independent review

`feature-dev:code-reviewer` on the net diff → **Ready to merge: Yes** (no issues
≥80 confidence). Confirmed the four rotation paths share one center/sign/aspect
convention, the aspect correction prevents shear, the diagonal projection +
delta un-rotation are sound, and `geometryPatch` omits `rotation` so move/resize
preserve it (the server merge is key-wise). The flagged coverage gap (rotated
hit-test) was closed before merge.

## Accepted nuance / follow-ups

- **Rotated-resize screen anchor drifts**: the opposite corner is fixed in
  _local_ coords, so the bbox center shifts and the anchor isn't pixel-pinned on
  screen. Explicitly delta-rotation per spec; perfect pinning needs recenter
  compensation — banked as optional polish.
- Banked from earlier: Phase 4 (collage→harmonize), `centeredLayerBox`
  cascade-offset, generalizing the rotation affordance beyond images.
