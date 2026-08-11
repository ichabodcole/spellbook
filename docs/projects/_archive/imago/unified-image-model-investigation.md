# Investigation — imago unified image / assets model (UX)

**Date:** 2026-06-16 · **Status:** investigation / design direction (cole) ·
**Spell:** imago (post-V1)

## The core observation

imago today has **three special-cased homes for an image**, each with different
powers:

| Home                             | Can focus/annotate? | Can be a `--ref`? | Lives where          |
| -------------------------------- | ------------------- | ----------------- | -------------------- |
| Generated / imported             | yes                 | no (not directly) | left sidebar         |
| Reference                        | **no**              | yes               | references drawer    |
| Collage element (an image layer) | (as a layer)        | no                | trapped on one image |

cole's direction: **collapse these into one asset model** — an image is an
image; it lives in your library (the left sidebar), and "is a reference," "is on
the canvas," "is a collage element" are _uses/affordances_, not separate kinds.
Fewer special cases, more expressive.

## The items (as raised), smallest → largest

### 1. Sidebar thumbnails don't reflect layers/annotations

The left-sidebar thumbnails show only the raw image — you can't tell which ones
have collaged image layers or annotations on them (raw vs. worked-on).

- **Ideal:** the thumbnail shows the composited result (image + its
  layers/marks) — literally what's on it.
- **Fallback:** a badge/icon marking "has annotations/layers."

**Feasibility note (better than it sounds):** we already composite —
`flatten.ts` burns image + layers + marks into one PNG for the agent handoff,
and the canvas already renders the image + `MarkRenderer` SVG overlay. A live
thumbnail-with-layers is **reusing `MarkRenderer` at thumb scale** over the
variant image, not building compositing from scratch. The "ideal" is quite
reachable; the badge is the cheap fallback if we want it sooner.

### 2. Make reference images NOT special (the first real step)

Today a ref is dragged into its own drawer, can't go on the canvas, can't be
annotated, and is separate from the sidebar. Proposal:

- A reference is **just a library image** that is currently _selected as a ref_.
- Drag sidebar → references (select-as-ref); drag an image onto the references
  area → it **also** lands in the library.
- Any library image can be focused on the canvas + **annotated** — including one
  you'll send as a ref ("here's the thing in this image I want you to use").
- Removing from references **does not delete** it — it stays in the library.

**Why it matters:** unifies the model (no un-annotatable images in a special
place) AND makes refs far more expressive (an _annotated_ ref is a pointing
gesture: "add THIS part of this image to that one").

### 3. (Later) a real asset/collage-element library + transparent cutouts

Collage elements only exist as layers on a host image — there's no library of
reusable elements to collage over backgrounds, and no place for transparent
cutouts. The end-state paradigm: one bucket of images (generated/imported), each
draggable **onto** the stage (becomes the canvas) **or onto** a WIP canvas
(collage). Bigger; has real UX decisions (transparency, where a cutout comes
from). First step toward it is #2.

### 4. Delete + filter on the sidebar (companion to #2)

- No way to delete a sidebar image today — need a delete affordance (button or
  right-click context menu).
- A **filter** (generated / imported / selected-as-ref) — increasingly necessary
  once the sidebar is a general media drawer, not just generations.

## The contract implication (why #2 is a refactor, not polish)

This is the load-bearing design fact: today `ImagoState` has
**`refs: Reference[]`** as a **separate array** from `batches[].variants[]`, and
**marks are keyed by `variantId`** (`marksByVariant`). So:

- Annotating a ref requires it to be a **focusable, markable entity** — i.e. a
  variant-like thing with an id that `marksByVariant` can key on.
- Unifying means references stop being their own type and become **library
  images with a `selectedAsRef` flag** (or: the library is the union of
  variants + imports, and "ref" is a selection over it).

That's a real data-model change touching the contract (`types.ts`), the server
(refs handlers, the agent projection, the `selectedRefIds` we just added), and a
chunk of surface. It deserves its own **design pass (investigation → plan)**
like the layer system got — not a drive-by.

## Proposed sequencing

1. **#1 thumbnails reflect layers** — high-value info gap, reuses
   `MarkRenderer`; shippable on its own. (Quick-ish polish.)
2. **#4 delete + filter** — contained, and useful immediately; also de-risks #2
   (the sidebar becomes a real managed library first).
3. **#2 references-as-assets** — the data-model refactor; do it deliberately
   with a short design pass first (it changes the contract + the just-shipped
   `selectedRefIds`).
4. **#3 full asset/collage-element library + transparent cutouts** — largest,
   after the model is unified; its own investigation when we get there.

## Open questions (for when #2/#3 are picked up)

- Does `Reference` collapse into the variant/asset type, or stay a thin
  "selection over the library"? (Affects `marksByVariant`, `selectedRefIds`,
  `leanState`.)
- Is "the library" literally `batches[].variants` + imports, or a new top-level
  `assets` collection the batches reference?
- Filter taxonomy: generated / imported / ref-selected / has-layers?
- #3 transparency: where does a cutout come from — `bg-remove` on a layer? a
  dragged transparent PNG? both?
