# Investigation: imago — a generalized layer system (image-layer collage → harmonize)

Status: **findings + proposal** (research + design for a POST-V1 feature) ·
Mode: mixed (diagnostic archaeology of the current code + evaluative for the
data-model and library decisions) · Date: 2026-06-14

## Summary

imago's annotation system is already 80% of a layer system: `marksByVariant` is
a per-variant ordered list of heterogeneous elements with server-authoritative
`zOrder`, durable identity, undo/redo, a freshness flag, and a flatten-on-commit
SVG compositor that already composites a base `<image>` + marks. The cleanest
path to the layer system cole wants is **not** to wrap marks in a new
abstraction — it is to **rename the bucket to `layersByVariant`, add an `image`
member to the `Mark`/`Layer` union, and add an optional `transform` (rotation)
to the shared base**. Everything else — z-order, visibility, lock, naming, the
layers panel, the collage→harmonize handoff — is incremental additions on top of
seams that already exist. The recommendation is to **extend the hand-rolled
SVG/fraction system, not adopt Konva/fabric/tldraw**: the house style (thin,
dependency-light, server-authoritative, fraction coords, flatten-as-handoff) is
a poor fit for a client-authoritative scene-graph library, and the gap a library
would close is small. YAGNI prunes hard: no groups, no per-vertex editing, no
blend modes, no skew, no nested layers, no client-side rasterization-as-truth.

## Decision context

- **Decision A (data model):** do marks _become_ layers, or do layers _wrap_
  marks + a new image type? → **Marks become layers** (unify under one union;
  rename the bucket).
- **Decision B (transforms):** how to add rotation without rewriting every
  tool's fraction geometry? → **An optional per-element `rotation` (degrees,
  about the element's center), applied at the render/flatten/hit boundary;
  geometry stays axis-aligned fractions.**
- **Decision C (library vs. extend):** Konva / fabric.js / tldraw / Excalidraw
  engine vs. extend the current SVG/fraction system? → **Extend.**
- **Drivers, in priority order:** (1) minimal disruption to shipped annotation
  features; (2) fidelity of the flattened collage as the `--ref` (the whole
  feature is "the agent _sees_ what you composed"); (3) house style (thin,
  Bun-bundled, server-authoritative, semantic theme tokens, contract in
  `types.ts`); (4) incremental — smallest valuable slice first; (5) YAGNI —
  borrow obvious idioms, skip Photoshop.

---

## Findings: what the current architecture already gives us

### F1. `marksByVariant` is already a layer list

`marksByVariant: Record<variantId, Mark[]>` (types.ts:168) is a per-image
ordered list of heterogeneous elements. Each element has:

- **identity** — `id` (MarkBase, types.ts:114)
- **z-order** — `zOrder?`, server-assigned on `mark.add` (`arr.length`,
  server.ts:670), reordered by `mark.reorder` (forward/back/front/back-most,
  server.ts:712), and consumed by _every_ renderer/compositor by ascending sort
  (MarkRenderer.tsx:31, flatten.ts:175, SelectionOverlay topHit descending
  server-side sort)
- **style** — `color`/`width`/`fontSize`, `label`
- **durability** — kept across focus switches; survives snapshot/restore with a
  zOrder-normalizing migration (server.ts:960)
- **per-image undo/redo** — `markHistory[vid]` (server.ts:225), snapshot on
  every mutating op via `pushHistory`
- **a freshness signal** — `markUnseen[vid]` (server.ts:230), surfaced as
  `state.marksUnseen` for the focused variant

That is a layer model missing only three things: a heterogeneous **image**
member, a **transform** (rotation), and the **visibility/lock/name** flags. The
"forward/back buttons" cole wants to replace are `mark.reorder` + the
SelectionOverlay chevrons (SelectionOverlay.tsx:364) — the _reorder primitive_
stays; only its UI changes (a panel instead of per-selection chevrons).

### F2. The flatten compositor already composites a base image + overlay elements

`flattenMarks` (flatten.ts:158) builds an offscreen SVG at natural resolution:
one base `<image href=src>` plus each mark as SVG, sorted by zOrder, rasterized
to a capped PNG. **This is exactly a collage compositor.** Adding an image layer
is literally adding another `<image>` element to the same `body` join
(flatten.ts:176) — the mechanism the brief already anticipates ("layers = more
`<image>` elements", brief.md:312). The only new work is mapping an image
layer's transform (position + scale + rotation) onto SVG `x/y/width/height` + a
`transform="rotate(...)"`.

### F3. Coords/hitTest/SelectionOverlay are a clean, pure, switch-per-tool seam

`coords.ts` is pure fraction-space geometry: `markBounds`, `hitTest`, `bbox`.
The SelectionOverlay's `translate`/`resize`/`resizeBox`/`geometryPatch` are pure
functions switched on `m.tool` (SelectionOverlay.tsx:34–151). Adding a new
`image` tool case to each switch is the established extension pattern (the
`draw` tool was added this way per visual-annotation-architecture.md). Rotation
is the _one_ feature that does NOT fit "add a case" cleanly — it's cross-cutting
(it affects bounds, hit-test, render, and flatten for _every_ element), which is
why it's modeled as a shared transform applied at the boundary rather than
per-tool geometry (see Recommendation 2).

### F4. The drop-on-canvas path already exists — it just _replaces_ instead of _adds_

`importFiles` → `image.import` → server makes a one-variant `import` batch and
focuses it (fileIntake.ts:60, Canvas onCanvasDrop:263, server.ts:632). The "add
as a layer" path is a sibling of this: same downscale-to-webp intake, a
different message (`layer.add` with an image src) that pushes onto
`layersByVariant[focus]` instead of creating a batch. References, generated
variants, and pasted images are all just sources of a data-url that can feed the
same `layer.add`.

### F5. The handoff contract is already "flattened image + instruction + geometry backup"

`marks.commit` flattens → `flattenedImagePath` → agent `--ref`s it + note text
in the prompt (mediaforge.md:287, types.ts:330). The collage→harmonize flow is
the _same contract_ with a different instruction ("harmonize into one cohesive
image" / restyle). The freshness flag (`marksUnseen`) and the chat auto-attach
(`say` carries `flattenedSrc`, server.ts:528) all reuse unchanged.

**Conclusion of findings:** the layer system is a _renaming + three additions_
exercise on top of seams built for exactly this. The brief's own backlog entry
(brief.md:310) called this correctly: "architecturally a natural extension."

---

## Recommendation 1 — Data model: marks BECOME layers (one union, rename the bucket)

**Do not** introduce a `Layer` wrapper around marks + a separate image type. A
wrapper duplicates identity/zOrder/style onto two levels, forces every consumer
(MarkRenderer, flatten, SelectionOverlay, hitTest, server reorder/undo) to learn
a two-tier model, and buys nothing — marks already carry everything a layer
needs.

Instead, **promote the existing union to a `Layer` union** and add an `image`
member. Concretely:

### 1a. Extend `MarkBase` → `LayerBase` with the layer flags + transform

```ts
// types.ts — the shared base for every element on an image (was MarkBase)
export type LayerBase = {
  id: string;
  zOrder?: number; // unchanged — server-authoritative
  label?: string; // doubles as the layer NAME in the panel
  color?: string;
  width?: number;
  fontSize?: number;
  // ── NEW (all optional → old marks are valid unchanged) ──
  hidden?: boolean; // visibility toggle (panel)
  locked?: boolean; // lock = not hit-testable / not selectable (panel)
  rotation?: number; // degrees clockwise about the element's bbox center; default 0
};
```

Keep `MarkBase` as a type alias of `LayerBase` for one migration cycle so
existing imports don't churn, then drop it.

### 1b. Add the `image` member to the union

```ts
export type ImageLayer = LayerBase & {
  tool: "image";
  src: string; // base64 webp data-url (same convention as Variant.src/Reference.src)
  // placement in fraction space, like rect: top-left + size as fractions of the
  // image box. natural aspect is baked into w/h at add-time (square-fit on drop).
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Layer =
  | (LayerBase & { tool: "pin"; x: number; y: number })
  | (LayerBase & { tool: "arrow"; x1; y1; x2; y2 })
  | (LayerBase & { tool: "line"; x1; y1; x2; y2 })
  | (LayerBase & { tool: "rect"; x; y; w; h })
  | (LayerBase & { tool: "ellipse"; cx; cy; rx; ry })
  | (LayerBase & { tool: "draw"; points: { x; y }[] })
  | ImageLayer; // NEW

// Mark = Layer  (alias for one cycle); MARK_TOOLS gains "image".
```

**Why `image` reuses the `rect` geometry shape (`x,y,w,h`):** it gets
`markBounds`/`hitTest`/`resizeBox`/`translate`/`geometryPatch` _for free_ —
every one of those already handles the `rect` case. An image layer is "a rect
that paints a bitmap instead of a stroke." This is the single highest-leverage
modeling choice in the whole proposal: it means image layers inherit
move/resize/select/ flatten with near-zero new geometry code.

### 1c. Rename the bucket: `marksByVariant` → `layersByVariant`

`marksByVariant: Record<variantId, Mark[]>` →
`layersByVariant: Record<variantId, Layer[]>`. This is a mechanical rename
across types.ts, server.ts (all `mark.*` handlers), Canvas.tsx,
AnnotationLayer.tsx. The snapshot-restore migration (server.ts:953) already
migrates a legacy global `marks` array → the bucket; add one more line:
`state.layersByVariant ??= state.marksByVariant ?? {}` so old snapshots upgrade
silently. **Keep the wire message names `mark.*` for one cycle** (or alias) to
avoid a flag-day on the client↔server contract; rename messages in a later,
separate pass once the model is proven.

> **YAGNI note:** do NOT add groups, parent/child nesting, or a separate
> `frame`/`artboard` concept. The flat ordered list is the whole model. tldraw
> and Figma have nesting; imago's collages are a handful of scraps on one
> background — a flat list is correct and a tree is speculative.

### How fraction geometry coexists with an affine transform

The current geometry is **axis-aligned fractions** (rect = x,y,w,h; ellipse =
center+radii; etc.). The transform model keeps that as the canonical geometry
and applies **only rotation** as an affine on top, about the element's bbox
center, at the render/hit/flatten boundary. We deliberately do NOT fold
scale/translate into an affine matrix — those are already expressed directly in
the fraction geometry (resize edits w/h; move edits x/y). Adding a full affine
matrix per element would _duplicate_ translate/scale (once in geometry, once in
the matrix) and force a rewrite of every pure function. Rotation is the only
transform that geometry can't already express, so it's the only one we add. (See
Recommendation 2.)

---

## Recommendation 2 — Transforms incl. rotation (the cross-cutting one)

**Model:** a single optional `rotation?: number` on `LayerBase` — degrees, about
the element's `markBounds` center. Default/absent = 0 = today's behavior
exactly.

This is the cleanest way to add rotation _without_ rewriting every tool, because
rotation is applied as a transform around the **existing axis-aligned geometry**
rather than baked into each shape's coordinates:

### 2a. Render (MarkRenderer + draft + pin HTML)

- SVG elements (arrow/line/rect/ellipse/draw/image): wrap each shape in
  `transform={rotation ? \`rotate(${rotation} ${cx*100} ${cy*100})\` :
  undefined}`where`(cx,cy)`is the bbox center from`markBounds`. SVG's `rotate(deg
  cx cy)` rotates about a point — exactly what we want, one attribute, no
  per-shape math.
- HTML pins: add `transform: rotate(${rotation}deg)` to the span style (rotation
  about its own center, which the existing `-translate-x/y-1/2` already
  centers). (YAGNI: pins probably never need rotation — but the field is shared,
  so it's free; just don't add a rotation handle for pins.)

### 2b. Hit-test (coords.ts)

Add a pre-step to `hitTest`: if `m.rotation`, rotate the test point `p` by
`-rotation` about the element's bbox center, then run the existing axis-aligned
test unchanged. One helper (`rotatePoint(p, center, -deg)`), called at the top
of `hitTest` and gated on rotation being set. Every existing per-tool branch
stays byte-for-byte the same.

### 2c. Bounds for the selection highlight (SelectionOverlay)

The highlight box and handles should rotate _with_ the element (Figma/tldraw
idiom: the selection frame is the rotated bounding box, not an axis-aligned box
around the rotated shape). Implementation: keep `highlightBox` computing the
axis-aligned bbox; apply the same `rotate(deg, center)` CSS transform to the
highlight `<div>` and the handle container. The handles then ride the rotated
frame for free.

### 2d. The rotation handle

Add ONE handle: a circular grip floating above the top-center edge of the
selection frame (the universal idiom — Figma/Canva/tldraw/Photoshop all put it
just outside the top edge or at a corner-hover ring). Drag it → compute the
angle from the bbox center to the cursor → set `rotation` (snap to 15° with
Shift, the standard). Commit via `mark.update { patch: { rotation } }`. The
server `mark.update` handler _already_ accepts arbitrary numeric scalar keys
(server.ts:692–695) — `rotation` flows through with **zero server changes**.

### 2e. Flatten (flatten.ts)

For each rotated mark, wrap its `markSvg(...)` output in
`<g transform="rotate(${rotation} ${cx} ${cy})">…</g>` (natural-pixel center).
One wrap in the `.map` at flatten.ts:176. For the pin's HTML→SVG conversion, the
`<rect>`+`<text>` group gets the same wrap.

**Why not a full affine matrix?** Considered and rejected: (1) it duplicates
translate/scale already in the geometry, creating a two-source-of-truth hazard
for resize and the optimistic-move pattern (`liveOverride`, `geometryPatch`);
(2) it forces a rewrite of `translate`/`resize`/`markBounds`/`geometryPatch`
from scalar-edits to matrix-composition; (3) it leaks into the server merge (the
`mark.update` patch is currently scalar/points — a matrix is neither). A single
`rotation` scalar threads through the existing scalar-merge path untouched.
Skew, flip, and non-uniform post-rotation scale are **YAGNI** (no media-forge
harmonize flow needs them; add later if a real ask appears).

> **One real caveat to flag for cole (OQ):** with rotation present, _resize_ of
> a rotated element via axis-aligned edge handles becomes visually confusing
> (the box you drag isn't axis-aligned). Two YAGNI-friendly options: (a) **for
> v1, resize operates in the element's local (un-rotated) frame** — transform
> the drag delta by `-rotation` before applying the existing `resizeBox`; corner
> handles then behave intuitively on the rotated frame. (b) Defer rotated-resize
> entirely (allow rotation OR resize, re-resize after un-rotating). Recommend
> (a) — it's a ~5-line delta-rotation in the gesture handler and matches Figma.
> Decide at build.

---

## Recommendation 3 — Image layers

### 3a. The type — already specified in 1b (`ImageLayer`, `tool: "image"`, rect geometry)

### 3b. Where the images come from (all converge on one `layer.add` message)

| Source                             | Path                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Drop a file/clipping on canvas** | new intake `layerFiles` (clone of `importFiles`) → `layer.add` instead of `image.import`. The drop now has TWO outcomes — see 3d. |
| **A reference from the drawer**    | "add to canvas as a layer" action on the ref thumbnail → `layer.add { src: ref.src }`. Reuses the loop-closer.                    |
| **A generated variant**            | "drop into the focused image as a layer" from the Generations sidebar → `layer.add { src: variant.src }`.                         |
| **Paste** (clipboard image)        | a `paste` handler on the stage → `layerFiles` → `layer.add`. (Nice-to-have; same pipe.)                                           |

New wire message (mirrors `image.import` but targets the layer bucket):

```ts
// ClientToServer
| { type: "layer.add"; layer: { src: string; name?: string } }
```

Server handler: decode/optimize the src (reuse `optimizeSrc`), measure nothing
server-side (the client supplies natural aspect in the placement), push an
`ImageLayer` onto `layersByVariant[focus.variantId]` with `zOrder = arr.length`,
`x/y/w/h` defaulting to a centered ~40%-of-image box at the image's natural
aspect (client computes aspect from the bitmap before sending, like `fileIntake`
already decodes via `createImageBitmap`). Set `markUnseen[vid] = true` and push
history — an added layer is a fresh edit. **No new agent event** until commit
(same rule as `mark.add`).

> **YAGNI:** image-layer `src` is inlined like marks' siblings are inlined in
> Variant/Reference. It DOES bloat `layersByVariant` (which, unlike `batches`/
> `refs`, is NOT stripped by `leanState`). **Action item:** extend `leanState`
> (server.ts:155) to strip `src` from `image` layers in the agent projection
> (the agent reads the flattened composite, not individual layer bitmaps) — so
> `/state` stays small. This is the one place image layers add a real
> obligation.

### 3c. Render + flatten an image layer

- **Render (MarkRenderer):** add an `image` branch — but image layers render as
  an HTML `<img>` positioned `absolute` with `left/top/width/height` as `%`
  (like the pin span is HTML), rotated via CSS transform, NOT inside the SVG
  overlay. Reason: the SVG overlay is `pointer-events-none` and sits above; an
  `<img>` sibling layer composites correctly with z-order if we interleave by
  zOrder. **Simpler alternative (recommended):** render image layers as SVG
  `<image>` inside the same MarkRenderer `<svg>` (the SVG already supports it;
  flatten already uses `<image>`), so one zOrder sort governs everything and
  there's a single render path that matches the flatten path 1:1. Go with SVG
  `<image>` for render-flatten parity.
- **Flatten (flatten.ts):** add an `image` case to `markSvg`:
  `<image href="${src}" x="${x*W}" y="${y*H}" width="${w*W}" height="${h*H}" preserveAspectRatio="none"/>`,
  wrapped in the rotation `<g>` from 2e. This is the literal extension the brief
  predicted. **Caveat:** the base `<image>` (the background variant) is drawn
  first (flatten.ts:179) and image layers are drawn in the zOrder body — so an
  image layer always paints _over_ the background, correct by construction.

### 3d. Drop-on-canvas: REPLACE vs. ADD-AS-LAYER

Today drop → replace (new working-image variant). The collage flow needs drop →
add-as-layer. Don't make it modal. Two clean options:

- **(Recommended) Context-sensitive drop:** if there IS a focused image,
  dropping onto the _image box_ adds a layer; dropping onto the empty stage
  margin (or when no image is focused) replaces/imports as today. The
  import-hint overlay already distinguishes regions — split it into two drop
  zones with two hint strings ("drop to add as a layer" over the image; "drop to
  import as a working image" on the margin / blank frame).
- **(Alternative) Modifier:** plain drop = import (unchanged); Shift/Option-drop
  = add as layer. Discoverable via the hint text reacting to the held modifier.

Recommend the context-sensitive split — it matches the mental model (drop _on_
the picture = put it _on_ the picture) and needs no hidden modifier knowledge.

---

## Recommendation 4 — Layers panel UI

Replace the per-selection forward/back chevrons with a real **Layers panel**. It
fits naturally where the **Details sidebar** already docks (Canvas.tsx:546, a
`w-[300px]` right-of-stage `<aside>`) — make Layers a second collapsible section
in (or a tab of) that sidebar, toggled by a stack icon next to the existing Info
toggle.

### Adopt (the obvious, high-value idioms)

| Pattern                                                   | From              | Why                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Top-of-list = top-of-stack**                            | Figma/PS/tldraw   | Universal; list order = reverse zOrder.                                                                                                                                                                                                                                                                                                                  |
| **Row = drag-handle + thumbnail + name + eye + lock + ⋯** | All               | The canonical layer row.                                                                                                                                                                                                                                                                                                                                 |
| **Drag-to-reorder**                                       | All               | The whole point — replaces chevrons. Maps to a new `layer.reorder { id, toIndex }` (or reuse `mark.reorder` for forward/back as the keyboard fallback).                                                                                                                                                                                                  |
| **Eye toggle = visibility**                               | All               | `hidden` flag; render + flatten skip hidden layers.                                                                                                                                                                                                                                                                                                      |
| **Lock toggle**                                           | All               | `locked` flag; hitTest/SelectionOverlay skip locked.                                                                                                                                                                                                                                                                                                     |
| **Click row ⇆ select on canvas**                          | All               | Two-way sync with the existing `selectedMarkId` mirror (Canvas.tsx:60 + SelectionOverlay `onSelectionChange`). Selecting in the panel sets `selectedMarkId`; SelectionOverlay reads it. (Today selection lives _inside_ SelectionOverlay's local state — lift it to Canvas so the panel and overlay share one source. Small refactor, called out below.) |
| **Double-click name = rename**                            | All               | Writes `label` via `mark.update { patch: { label } }` — `label` already doubles as the name.                                                                                                                                                                                                                                                             |
| **Delete (row ✕ / Del key)**                              | All               | Reuses `mark.remove`.                                                                                                                                                                                                                                                                                                                                    |
| **Auto-name by kind**                                     | tldraw/Excalidraw | "Image", "Arrow", "Sketch 2" derived from `tool` when `label` is empty (don't force naming).                                                                                                                                                                                                                                                             |

### Skip (YAGNI — not Photoshop)

- Layer **groups / folders / nesting** — flat list only.
- **Blend modes / opacity per layer** (beyond hidden) — the harmonize model
  doesn't use them; the _agent_ does the blending.
- **Layer effects, masks-as-layers, adjustment layers, smart objects.**
- **Multi-select + align/distribute** — single-select is enough for a few
  scraps; add only if collages routinely have many layers.
- **Layer search/filter, color labels, locking groups.**
- **Reorder by typing a z-index.**

### Selection-sync refactor (the one structural prerequisite)

Selection currently lives in `SelectionOverlay` local state (`selectedId`,
SelectionOverlay.tsx:235) and is _mirrored up_ read-only via
`onSelectionChange`. For two-way panel↔canvas sync, **lift `selectedId` to
Canvas** (or a tiny shared store) and pass it down to both the panel and the
overlay as controlled state. This is a contained refactor (the overlay already
reports changes up; we add the inbound direction) and unblocks the panel
cleanly. Do it as the first step of the panel phase.

---

## Recommendation 5 — The collage → harmonize flow

**Confirmed: the existing handoff carries it with no new mechanism — only a new
_instruction framing_.** The flattened `layersByVariant[focus]` stack (base
variant `<image>` + image layers + annotation marks, rasterized at natural res
by `flattenMarks`) becomes the `--ref`, exactly as `marks.commit` does today.

What changes:

- **The flatten input** is now the full layer stack (image layers included) —
  but `flattenMarks` already iterates all marks in zOrder; once image layers are
  in the union and `markSvg` has an `image` case, the _same call_ produces the
  composite. No new flatten path.
- **The instruction** is "make this feel like one cohesive image" / "restyle
  this collage as <style>, using the arrangement as the layout reference." This
  is a _say_ / _commit_ text the user writes (per the language-first paradigm,
  brief.md:96 — buttons populate the box). A composer shortcut chip ("Harmonize
  this collage →") that _fills the box_ with that editable instruction is the
  idiomatic imago affordance.

### Does the agent need to know "this is a collage to harmonize" vs. an annotation edit?

**Lean answer: no new structured flag is required** — the agent reads the
instruction text + sees the flattened image, and the media-forge edit path is
the same (`--ref <flattened> --prompt "<instruction>"`, mediaforge.md:170). The
reasoning models harmonize from the picture + words.

**But one cheap, honest signal helps the agent route models well** (a collage
needs a strong instruction-following / reasoning model; a light annotation edit
may not). Recommend a single boolean rather than a new code path:

```ts
// the commit/say payload gains an optional hint, derived, not user-set:
// true when the committed stack contains ≥1 image layer.
hasImageLayers?: boolean   // on marks.commit event + say payload
```

The server computes it from `layersByVariant[vid].some(l => l.tool === "image")`
and the agent uses it to bias toward `gpt-image-2` / `nano-banana-2` and the
"harmonize" framing. This is server-derived (can't drift), additive, and
optional — it does not create a second handoff contract. **Flag as OQ** whether
even this is worth it vs. letting the agent infer from the image (it can usually
_see_ it's a collage).

### Freshness reuse

`markUnseen` is set on `layer.add`/transform/reorder (all go through
`pushHistory`), so the "Take collage to the conversation →" CTA and the chat
auto-attach light up exactly as they do for annotations today. No change.

---

## Recommendation 6 — Migration / compat (incremental, no flag-day)

The whole point of "marks become layers" is that compat is mostly free.
Sequenced to never break shipped annotation features:

1. **Contract (additive only):** add the optional `LayerBase` fields
   (`hidden`/`locked`/`rotation`), add `ImageLayer` to the union, add `"image"`
   to `MARK_TOOLS`. Alias `Mark = Layer`, `MarkBase = LayerBase`. **All existing
   marks remain valid** (new fields optional). No client behavior changes yet.
2. **Bucket rename:** `marksByVariant → layersByVariant` with the one-line
   restore migration (`state.layersByVariant ??= state.marksByVariant ?? {}`).
   Keep wire message names `mark.*` for now. Redeploy.
3. **Server `layer.add`** (image layers) + `leanState` strips image `src`. Image
   layers now exist and flatten — but no panel/transform UI yet.
4. **Rotation** — render/hit/flatten/handle. `mark.update` already accepts the
   `rotation` scalar (zero server change). The optimistic-move/`liveOverride`
   pattern extends to rotation by treating it like any other gesture commit.
5. **Layers panel** — after the selection-lift refactor (Rec 4). The chevron
   buttons stay until the panel ships, then are removed (or kept as a redundant
   keyboard affordance).
6. **Collage→harmonize** — the composer chip + the optional `hasImageLayers`
   hint. The flatten already does the work.

**Undo/redo:** every new op (`layer.add`, transform via `mark.update`, reorder,
visibility/lock toggles, delete) routes through the existing `pushHistory` →
per-variant `markHistory`. Visibility/lock toggles ARE state changes; decide
whether they belong in undo history (Photoshop: no; tldraw: yes). Recommend
**yes, they're undoable** (they go through `mark.update`, so they're in history
for free — _not_ special-casing them is the lower-effort, consistent choice).

**marksUnseen / freshness:** unchanged — it keys on any history push.

**Snapshot/restore:** the existing zOrder-normalizing restore loop
(server.ts:960) already iterates `marksByVariant`; point it at
`layersByVariant`. Image layers' `src` survives in the snapshot (self-contained,
like Variant.src); their `path` re-materialization is **unnecessary** (the agent
never reads individual layer files — only the flattened composite), so do NOT
add per-layer file materialization. (Confirms the `leanState`-strip decision in
3b.)

---

## Recommendation 7 — Library vs. extend: **EXTEND** (Confidence: High)

### Options evaluated

**Konva (react-konva)** — canvas 2D scene graph with `Transformer` (drag/resize/
**rotate** out of the box), node z-index, hit detection.

- _Strengths:_ rotation/transform handles are free and battle-tested; performant
  for many nodes.
- _Weaknesses (disqualifying for imago):_ it's a **client-authoritative canvas
  scene graph** — imago is **server-authoritative** (the daemon holds canonical
  `layersByVariant`; the client is a thin render of broadcast state). Konva
  wants to _own_ the nodes; you'd fight it to keep the server the source of
  truth. Canvas-2D rendering breaks the SVG/fraction model and the
  **flatten-as-handoff** (you'd re-implement natural-res, viewport-independent
  rasterization that `flatten.ts` already does correctly). Theme tokens
  (`var(--color-*)`) don't apply to canvas pixels. New ~150KB dep against a thin
  house style.

**fabric.js** — similar to Konva (canvas scene graph, built-in controls incl.
rotate). Same disqualifiers, heavier, more imperative, React integration is
awkward.

**tldraw (as an engine)** — full editor with a documented shape/binding model,
rotation, a layers/reorder system, persistence.

- _Strengths:_ the richest idioms; if imago were greenfield this would be
  tempting.
- _Weaknesses:_ it's an _application_, not a layer primitive — adopting it means
  re-platforming imago's surface onto tldraw's store/state/persistence, throwing
  away the server-authoritative WS model, the conversation spine, the
  flatten-handoff, and the fraction contract. Massive disruption against driver
  #1. Its store is client-first.

**Excalidraw (as an engine)** — same class of answer as tldraw; an app, not a
primitive; client-first scene state.

**Extend the current SVG/fraction system** — add `image` to the union,
`rotation` to the base, a rotation handle, a layers panel.

- _Strengths:_ zero new deps; preserves server-authority, fraction coords, theme
  tokens, the flatten handoff, undo/redo, freshness — _all the load-bearing
  seams_. Every new piece is "add a case to a switch" or "add an optional
  field." The rotation math is ~3 small helpers. Matches house style exactly.
- _Weaknesses:_ you hand-roll the rotation handle + panel drag-reorder (a day or
  two of UI each); no free multi-node transformer. But imago doesn't need a
  multi-node transformer (single-select, few scraps).

### Comparison

| Criterion                                 | Weight | Konva              | fabric | tldraw/Excalidraw engine | **Extend**    |
| ----------------------------------------- | ------ | ------------------ | ------ | ------------------------ | ------------- |
| Preserves server-authority                | High   | ✗                  | ✗      | ✗                        | ✓✓            |
| Preserves flatten-as-handoff              | High   | ✗ (re-impl)        | ✗      | ✗                        | ✓✓            |
| House style (thin, tokens, Bun)           | High   | ✗                  | ✗      | ✗                        | ✓✓            |
| Minimal disruption to shipped annotations | High   | ✗                  | ✗      | ✗✗                       | ✓✓            |
| Free rotation/transform handles           | Med    | ✓✓                 | ✓✓     | ✓✓                       | ✗ (hand-roll) |
| Free layers/reorder UI                    | Med    | ~                  | ~      | ✓                        | ✗ (hand-roll) |
| Bundle / dep cost                         | Med    | ✗                  | ✗      | ✗✗                       | ✓✓            |
| Effort                                    | —      | High (re-platform) | High   | Very High                | **Med**       |
| Risk                                      | —      | High               | High   | High                     | **Low**       |

**Recommendation: Extend.** Confidence **High**. The libraries' one genuine win
(free transform handles) is small and localized; their costs (re-platforming
against every load-bearing house-style seam) are large and pervasive. The
hand-rolled rotation handle is a known, contained piece of work.

**When to reconsider:** if imago ever moves to (a) **many** layers per collage
(dozens), (b) **multi-select** transform as a core flow, (c) a **client-first**
state model, or (d) **freeform vector editing** (bezier/node editing) — Konva
becomes worth a second look. None are on the roadmap; all are YAGNI today.

---

## Phased build sequence (smallest valuable first)

Each phase is independently shippable and leaves annotations working.

- **Phase 0 — Contract + rename (redeploy).** `LayerBase` fields, `ImageLayer`,
  `MARK_TOOLS += "image"`, `Mark=Layer` alias;
  `marksByVariant → layersByVariant`
  - restore migration; `leanState` strips image-layer `src`. No UI change.
    _Lowest risk; unblocks everything._
- **Phase 1 — Image layers (the headline capability, minimum viable).**
  `layer.add` message + server handler; `layerFiles` intake; context-sensitive
  drop (on-image = layer, margin = import); MarkRenderer + flatten `image` case;
  "add as layer" actions on ref thumbnails + sidebar variants. **Now you can
  collage and the flattened composite already harmonizes** via the existing
  commit → `--ref`. _This is the smallest slice that delivers the core feature._
- **Phase 2 — Layers panel.** Selection-lift refactor; panel section in the
  details sidebar; drag-reorder (`layer.reorder` or reuse `mark.reorder`); eye/
  lock/rename/delete/thumbnails; two-way select sync. Retire the chevrons.
  _Makes reorder/visibility/manage natural — cole's framing._
- **Phase 3 — Rotation + transform polish.** Rotation handle on the selection
  frame; `rotation` through render/hit/flatten; rotated-resize in local frame.
  _The "transforms incl. rotation" ask._
- **Phase 4 — Collage→harmonize framing.** Composer "Harmonize collage →" chip
  (populates the box); optional `hasImageLayers` routing hint; agent-side prompt
  guidance (which model, the harmonize/restyle instruction shape). _Sharpens the
  third input mode; mostly agent-side + one chip._

---

## Risks & tradeoffs

- **State bloat from inlined layer bitmaps.** `layersByVariant` is broadcast in
  full to browsers and (without the fix) to the agent. _Mitigation:_ `leanState`
  strips image `src` (Phase 0); rely on the existing `optimizeSrc` webp
  downscale; consider a per-image-box size cap on add. **Real obligation — don't
  skip it.**
- **Flatten fidelity at the 1536px long-edge cap (flatten.ts:19).** A collage of
  several scraps may want more detail than a single annotated image.
  _Mitigation:_ the cap is one constant; revisit per the existing OQ5 note if
  harmonize results look soft. Reasoning models downsample anyway.
- **Rotated-resize UX** (Rec 2 caveat) — the one genuinely fiddly interaction.
  _Mitigation:_ local-frame resize (~5 lines) or defer rotated-resize.
- **Selection-state lift** touches a shipped component (SelectionOverlay). _Low
  risk_ (it already reports up; we add inbound), but it's the one refactor of
  working code — do it carefully with the existing flows in mind
  (`liveOverride`, pin re-edit).
- **`<img>` vs SVG `<image>` for layer render.** SVG `<image>` keeps
  render/flatten parity but may have subtle cross-origin/caching quirks with
  data-urls. _They're data-urls (same-origin-safe)_, so low risk; if a perf
  issue appears with large bitmaps, fall back to interleaved HTML `<img>` layers
  (more render code, same model).
- **Cross-spell pull (scope creep).** A layer system is tempting to generalize
  (groups, masks-as-layers, the deferred masking flow). _Mitigation:_ the
  masking backlog (brief.md:264) already overlaps — a mask brush is "a draw
  layer that rasterizes white-on-black." Keep masking a _separate_ follow-up;
  don't fold it into this. YAGNI everything past the flat list + image layer +
  rotation.

---

## Review outcome — cole's direction (2026-06-14, via digestify)

cole reviewed this doc and redirected the three foundational decisions. **These
override the recommendations above where they conflict** (the recommendations
above are preserved as the analysis that led here):

- **Decision A — REVISED: layers WRAP marks (containers), not
  marks-become-layers.** A layer is a _container_ of elements, not
  one-element-per-layer. Drawing an arrow/stroke drops it into the
  **currently-selected layer** (NOT a new layer per element — that panel noise
  is the thing to avoid). MVP shape: the background image (dragged from the left
  image list / a reference) is the first layer; a default "annotations" layer
  sits on top; the user adds more layers to separate things. Later (not MVP): a
  blank sized canvas you drag elements onto (no required background). Open to
  idiomatic refinements.
  - **Reconciliation (atlas):** keep the flat element list as _storage_ and add
    a shallow grouping on top — each element gets a `layerId`; add an ordered
    `layers[]` (id, name, hidden, locked). The panel lists _layers_; effective
    z-order = layer order, then element order within a layer; drawing targets
    the selected layer. One level of grouping, no nesting (still YAGNI on deep
    trees). This keeps the investigation's "minimal disruption to the flat list"
    win while delivering the container UX. (Supersedes Recommendation 1's flat
    "marks become layers" + the "no groups" YAGNI note — a _shallow_ group is
    now in scope.)
- **Decision B — rotation, image-first.** Primary use is rotating dragged-in
  reference images for collage. Notes don't need rotation; arrows/lines already
  have endpoint handles. Build it for image layers; generalize to all elements
  ONLY if it abstracts cleanly for free, else scope to images. (Recommendation
  2's single-`rotation`-scalar approach still fits — just don't expose a
  rotation handle where it isn't useful.)
- **Decision C — library vs. extend is the implementer's call at build time.**
  Extend while below the complexity bar; reach for Konva (cole's preference) or
  a better-fit library if/when the layer+transform+container work is clearly
  "reimplementing a library." The container model (Decision A) raises
  complexity, which tilts the scale somewhat toward a library vs. Recommendation
  7's "extend" — re-weigh at plan time against the server-authority +
  flatten-handoff constraints (the two things that most resist a client-first
  scene-graph lib).

The 9 tactical questions below are now downstream of Decision A and will mostly
be re-derived when this becomes a plan; kept for reference.

## Open questions for cole

1. **Drop disambiguation:** context-sensitive (drop on image = layer, margin =
   import) vs. modifier-key (Shift-drop = layer)? _(Rec recommends
   context-sensitive.)_
2. **Rotated-resize:** local-frame resize in v1, or defer it (rotate OR resize)?
   _(Rec: local-frame, ~5 lines.)_
3. **Visibility/lock in undo history?** _(Rec: yes — it's free via
   `mark.update`.)_
4. **Do we need the `hasImageLayers` routing hint at all,** or let the agent
   infer "this is a collage" from the flattened image it can see? _(Rec: ship
   the cheap server-derived boolean; it's additive and helps model routing.)_
5. **Layers panel home:** a section _inside_ the existing details sidebar, a
   _tab_ of it, or its own toggleable dock? _(Rec: a section/tab of the existing
   `w-[300px]` sidebar to avoid a fourth pane.)_
6. **Wire-message rename timing:** keep `mark.*` message names indefinitely
   (model renamed, messages not), or schedule a `layer.*` rename pass once
   proven? _(Rec: keep `mark._` for now; rename later, separately.)\*
7. **Do annotation marks and image layers share ONE panel** (one heterogeneous
   list, cole's framing) or get visually grouped (images vs. annotations)?
   _(Rec: one list — that's the unification; group only if it gets noisy.)_
8. **Default image-layer placement size** on drop (centered 40%? drop-point
   anchored?) and whether dropping multiple files cascades them.
9. **`layer.reorder` granularity:** a full `toIndex` for drag-drop, or keep the
   forward/back/front/back primitive and let the panel issue repeated steps?
   _(Rec: add `toIndex` — drag-drop wants absolute placement.)_

---

## Appendix — exact code touch-points

| Concern                                     | File:line                        | Change                                                                                             |
| ------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Union + base + bucket                       | types.ts:113–168                 | `LayerBase` fields, `ImageLayer`, `MARK_TOOLS+="image"`, `marksByVariant→layersByVariant`, aliases |
| Add-layer message                           | types.ts:205 (ClientToServer)    | `layer.add`; later `layer.reorder { toIndex }`                                                     |
| Handoff hint                                | types.ts:330 (AgentEventPayload) | optional `hasImageLayers`                                                                          |
| Server layer.add / rename                   | server.ts:632–756                | `layer.add` handler; rename `mark.*` targets to `layersByVariant`; reorder `toIndex`               |
| leanState strip image src                   | server.ts:155                    | strip `src` from `image` layers in the agent projection                                            |
| Restore migration                           | server.ts:953–965                | `layersByVariant ??= marksByVariant`; point zOrder-normalize at it                                 |
| mark.update rotation                        | server.ts:692                    | already accepts numeric scalars — `rotation` flows free                                            |
| Geometry: rotate-then-test                  | coords.ts:45,92                  | `rotatePoint` pre-step in `hitTest`; rotated bbox for highlight                                    |
| Render rotation + image                     | MarkRenderer.tsx:53              | `transform=rotate(...)` per shape; `image` SVG `<image>` branch                                    |
| Flatten image + rotation                    | flatten.ts:117,176               | `image` case in `markSvg`; rotation `<g>` wrap                                                     |
| Selection: rotation handle, lift selectedId | SelectionOverlay.tsx:235,343     | rotation handle; controlled selection; local-frame resize                                          |
| Image branch in transforms                  | SelectionOverlay.tsx:34–151      | `image` reuses `rect` cases (mostly free)                                                          |
| Drop = layer vs import                      | Canvas.tsx:263, fileIntake.ts:60 | context-sensitive drop zones; `layerFiles` intake                                                  |
| Layers panel                                | Canvas.tsx:546 (details aside)   | new panel section/tab; "add as layer" on refs (Canvas.tsx:721) + sidebar variants                  |
| Harmonize chip                              | composer (Conversation)          | populate-the-box chip per the language-first rule                                                  |

## References

- `plugins/spellbook/skills/imago/surface/state/types.ts` — the contract
- `plugins/spellbook/skills/imago/scripts/server.ts` — mark.\* handlers,
  leanState, saveDataUrl, history, freshness, restore migration
- `plugins/spellbook/skills/imago/surface/components/annotations/` — coords,
  MarkRenderer, AnnotationLayer, SelectionOverlay, flatten, tools/registry,
  style
- `plugins/spellbook/skills/imago/surface/components/Canvas.tsx` — viewport,
  drop-on-canvas, reference drawer, details sidebar, commitMarks
- `plugins/spellbook/skills/imago/surface/state/fileIntake.ts` — intake paths
- `plugins/spellbook/skills/imago/references/mediaforge.md` — the `--ref` edit
  path
- `docs/projects/imago/visual-annotation-architecture.md` — flatten-on-commit
  blueprint
- `docs/projects/imago/brief.md` — paradigm + the collage backlog entry
  (brief.md:310)
- Library idioms surveyed: Konva `Transformer`, fabric.js controls, tldraw
  shape/reorder model, Excalidraw scene state, Figma/Canva/Photoshop
  layer-panel + rotation-handle conventions (assessed against the
  server-authoritative, flatten-handoff house style)
