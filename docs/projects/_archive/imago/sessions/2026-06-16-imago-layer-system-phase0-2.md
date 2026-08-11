# Session — imago layer system: Phases 0–2 (build → review → finalize)

**Date:** 2026-06-16 · **Branch:** `feat/imago-layers` → `develop` · **Spell:**
imago (post-V1)

## What this is

The post-V1 **layer system** for imago — a **container model** layered on top of
the shipped flat annotation store. Built as the same two-agent grapevine swarm
(`imago-build` channel): **atlas** (lead/liaison — contract, server, review,
commits, e2e) + **vulcan** (surface/React). cole drove via the live daemon and
green-lit each phase. Plan + design are in
[`layer-system-plan.md`](../layer-system-plan.md) and
[`layer-system-investigation.md`](../layer-system-investigation.md).

**The model in one breath:** a **Layer is a container of elements.** Storage
stays the flat `marksByVariant`; we add an ordered **`layersByVariant`** of
container metadata (back→front) and tag each `Mark` with a **`layerId`**.
**Effective z = layer order, then `zOrder` within the layer.** Grouping is a
**fluid, reversible** operation (group/ungroup). The base image is the focused
Variant, shown as a synthetic locked "Background" row (not stored). **`hidden`
doubles as the agent-handoff filter** — hidden layers don't render, so they
don't flatten, so the agent never sees them.

## What shipped

**Phase 0 — contract + migration (no behavior change).** `Layer` type +
`layersByVariant` on `ImagoState`; `Mark` gains `layerId` (+ `rotation`,
forward-declared for Phase 3). History snapshot unit widened from `marks` to
`{marks, layers}` per variant, so layer ops are atomically undoable. Restore
migration backfills a default "Annotations" layer + stamps `layerId` on legacy
marks. Effective-z comparator (`coords.ts`) degenerates to today with one layer.

**Phase 1 — image layers (collage).** `tool:"image"` mark (rect geometry →
inherits bounds/hit/resize/translate); `layer.addImage` (optimize src, centered
40% at natural aspect); **leanState strips the bitmap `src`** from the agent
projection (it reads the flattened composite, never per-layer bitmaps);
MarkRenderer + flatten gained the `image` case and **skip hidden layers**;
context-sensitive drop (on-image → layer, margin → import); "Add as layer" on
ref thumbs + generations. **SVG-pin parity** (cole's call): pins render as SVG
in MarkRenderer so they z-order correctly behind image layers — live canvas ==
flattened handoff; the HTML editor stays only while a pin is being edited.

**Phase 2 — the inspector panel + fluid grouping.** Built in four reviewed
slices:

1. **Selection-lift** — `selectedId` lifted out of SelectionOverlay into Canvas
   (controlled); `isMarkSelectable` (skips hidden/locked) shared by `topHit` and
   the panel.
2. **Layers panel** (`LayersPanel.tsx`) in the right-of-stage aside as a tab
   beside Details — reversed list (front-on-top), synthetic Background row,
   per-row grip-reorder / thumb / dbl-click rename / eye / lock / delete; the
   reorder inverts the visual index to server space.
3. **Grouping core** — selection became a SET; multi-select (shift/⌘-click) →
   **Group**; per-row **Ungroup** on multi-element layers; two-way panel↔canvas
   select sync; retired the per-selection reorder chevrons (the panel owns
   inter-layer z now).
4. **Active-layer** — `+ New layer` + a make-active dot + a "New marks →
   {layer}" hint; new marks stamp the active `layerId` at the single `commit()`
   choke point.

Server ops added:
`layer.add / rename / setHidden / setLocked / reorder (absolute toIndex) / remove (deletes layer AND its marks)`,
`group`, `ungroup`.

## Key design decision (deviation from the plan)

**Dropped `layer.setActive`.** The active layer is **surface-owned**: the client
stamps `mark.layerId` on `mark.add`; the server honors a valid one, else falls
back to the topmost **non-image** layer (`ensureDrawLayer`). This removed a
command + a state field and keeps drawing from landing "inside" an image layer.
Validated as sound + fully wired by the plan-alignment review.

## Process & verification

- Five-then-six commits, each reviewed line-by-line by atlas with the gates
  re-run before landing (**biome clean; `bun test` 66 green**; surface builds).
  `tsc` is not a repo gate (imago files carry lib-context noise).
- **Live e2e** (Playwright vs. the daemon, restored on cole's real canvas):
  panel renders, Details↔Layers tabs, `+ New layer` auto-activates, add-as-layer
  composites into the reversed list, and **hide drops the layer from the live
  render and fires `marksUnseen`** (the handoff filter, proven live).

## Independent review (dual, on the net diff)

- **Plan-alignment (general-purpose):** Ready to merge — **Yes.** Faithful Phase
  0–2, deviation sound, architecture coherent, risk areas tested.
- **Bug-focus (feature-dev:code-reviewer):** With fixes. Confirmed the
  integration tests hit a real daemon (subprocess + WS), not mocks. One real
  finding (#1): a pure-image `group` produced a `kind:"annotation"` layer →
  **fixed** (`e150dad`, homogeneous selections keep their kind) + test added.
  Finding #2 (undo-button display desync if focus switches during the async
  `layer.addImage`) accepted as a low-severity, correct-by-design glitch (the
  toolbar tracks the focused variant; the image stays undoable on refocus).

## Follow-ups (banked, not in this branch)

- **Phase 3** — rotation/transform polish (image-first; `rotation` is already in
  the contract, unwired).
- **Phase 4** — collage→harmonize composer chip + server-derived
  `hasImageLayers` hint.
- **Polish** (vulcan): cascade successive image-layer drops by a small offset in
  `centeredLayerBox` so they don't stack at the identical 40% center (also makes
  the multi-select path browser-testable). Optional.
