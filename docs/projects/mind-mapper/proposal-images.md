# Proposal — mind-mapper image / media support (Round 7)

**Status: PROPOSAL (queued for Round 7).** Author: prospero. Origin: drive-4
finding #1, recurring every dogfood drive (drive-5 #9). Cole: "an important
piece of functionality… the way to build it is to build it and then test it."
Sequenced as its OWN round (after Round 6's drive-5 fixes) because it's a new
subsystem, not a feature — it earns a dedicated proposal, ratify round, and
dogfood drive.

## The want

Import images as **context** (album covers, artist photos, stills, diagrams) and
display them as **nodes** and/or in the **context-detail** pane. Cole: "display
them as nodes or in the context details."

## The load-bearing insight — images fit the existing evidence model

The mapper's evidence grammar is **a `span` into a `doc`** (a text region
grounds a node). The image analogue is **a `bbox` region into an image**:

> `text span : doc  ::  bbox : image`

So an image is just another **source** in the source→staging→knowledge layering
— but binary — and a _region of an image_ can ground a node exactly the way a
text span does today (a face in a cast photo grounds the actor node; a poster
detail grounds the film). Images become a natural extension of the evidence
model, not a bolt-on. This is the design's north star.

## Borrow, don't build

- **magpie** (rebuild in flight): already has image intake + an editable
  co-presence **bbox canvas** (`bbox = source-px, canvas = fraction`) + rembg
  cutouts. The bbox primitive + canvas component are the load-bearing borrow.
- **media-buffet**: ships a media UI as a Spellbook spell (the media-as-context
  pattern). Check its shape for the intake/serve half.
- Borrow-audit both before building; a shared image-context component is a
  candidate Track-B house extraction (a fifth pillar).

## Design questions to resolve at the proposal→plan boundary

- **Storage**: docs are text/markdown today. Images need an **assets dir** +
  binary serving (a `GET /asset/:id` route). An image is a doc of `kind:image`
  (ties to the K1 doc-kind work — kind becomes load-bearing) or a distinct asset
  type? Lean: an image IS a doc (kind:image) so it lives in the same source
  layer, lens, and provenance machinery; the binary is an attached asset.
- **Evidence**: adopt magpie's **bbox** as the image-region evidence primitive
  (region-of-image grounds a node); whole-image evidence is the degenerate case.
  Contract 9 gains an evidence variant `{imageId, bbox}` alongside
  `{docId, span}` / `{messageId, span}`.
- **Display**: an image **node** (thumbnail on the canvas, a React Flow custom
  node) AND the full image in the **context-detail** pane where bbox regions are
  visible/selectable — two views of one asset, like the map/grid split. Cole
  said "or"; lean "both, as modes."
- **Intake**: drag-drop into the context rail (mirrors doc drop), paste, or a
  `image add <path>` verb. The bbox-authoring is a surface act on the detail
  pane (magpie's canvas).
- **Agent side**: the agent can attach an image as a source and ground nodes in
  bbox regions; casting-draft gains the image-evidence shape.

## Scope shape (for the Round-7 plan)

- **Engine**: assets storage + `GET /asset/:id`; `kind:image` docs (or asset
  type); `{imageId, bbox}` evidence variant end-to-end (propose → ratify → state
  wire); intake verb. Contract 9 image amendments.
- **Surface**: image node (canvas thumbnail) + context-detail image view with
  bbox authoring (magpie borrow); drag-drop intake; evidence-jump to a bbox (the
  span-flash analogue for regions).
- **Gate**: cold drive covering image intake, bbox-grounding a node, both
  display modes.

## Explicitly NOT in this proposal

Video/audio (images first); generative image editing; the rembg cutout is
optional/borrowed, not required for v1. Multi-image-per-node is a follow-on.

## Dependencies / sequencing

After **Round 6** (drive-5 fixes + tooling: ratify-batch, node deletion,
add-node processing phase + queue, submap-create affordance, the render/edge
bugs). The K1 doc-kind honesty (Round 4) is a prerequisite the `kind:image`
approach leans on — already shipped. Borrow-audit magpie + media-buffet is the
first plan-phase task.
