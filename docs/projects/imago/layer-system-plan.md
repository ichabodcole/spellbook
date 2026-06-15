# Dev plan — imago layer system (container model)

Status: **plan, pending vulcan review** · Date: 2026-06-15 · Supersedes the
flat-model build sequence in `layer-system-investigation.md` (Rec 1). Honors the
"Review outcome — cole's direction" + the two session refinements in that doc.

## The model in one breath

A **Layer is a container of elements.** Storage stays the shipped flat element
list (`marksByVariant`); we add an ordered **`layersByVariant`** of container
metadata on top, and tag each element with a **`layerId`**. The panel lists
layers; **effective z = layer order, then element order (`zOrder`) within the
layer.** Grouping is a **fluid, reversible operation** (group/ungroup), so
"every mark its own layer" and "draw into the active layer" are just default
policies over one structure — and the default is **tool-aware** (pen strokes
accrete into the active sketch layer; discrete objects each become a
group-of-one layer). The base image is the focused **Variant**, shown as a
synthetic locked "Background" row — NOT stored as a layer.

Decoupled axes (load-bearing): **selection/manipulation is always per-element**
(an element stays individually hit-testable regardless of its layer);
**hidden/locked/order live on the layer.** `hidden` doubles as the **handoff
filter** — hidden layers don't render, so they don't flatten, so the agent never
sees them.

## Contract additions (`surface/state/types.ts`) — the heart of the plan

```ts
// NEW — the container. Order is given by array position in layersByVariant
// (index 0 = bottom / back; last = top / front, matching zOrder ascending=on-top).
export type Layer = {
  id: string;
  name: string;                          // editable; doubles as the panel label
  kind: "annotation" | "sketch" | "image"; // auto-name + icon; "sketch" accretes strokes
  hidden?: boolean;                      // visibility + HANDOFF filter (skip in render+flatten)
  locked?: boolean;                      // not hit-testable / not selectable
};

// MarkBase gains two optional fields (old marks stay valid → migration backfills):
export type MarkBase = {
  id: string;
  zOrder?: number;        // CHANGED MEANING: order WITHIN the element's layer
  layerId?: string;       // NEW — which layer this element belongs to
  rotation?: number;      // NEW — degrees about bbox center; image-first (Decision B)
  label?: string;
  color?: string;
  width?: number;
  fontSize?: number;
};

// NEW union member (rect geometry → inherits bounds/hit/resize/translate for free):
| (MarkBase & { tool: "image"; src: string; x: number; y: number; w: number; h: number })
// MARK_TOOLS += "image"

// ImagoState gains the per-variant layer lists:
layersByVariant: Record<string, Layer[]>;   // ordered back→front; defaultState → {}
```

**Naming note (resolves the investigation's confusing rename):** elements stay
`Mark`; the container is `Layer`. We do NOT rename `Mark→Layer`. The bucket
`marksByVariant` keeps its name (wire stability); `layersByVariant` is the new
sibling.

## New client→server messages

```ts
| { type: "layer.add"; name?: string; kind?: Layer["kind"] }          // blank layer (becomes active)
| { type: "layer.addImage"; src: string; name?: string }             // image layer from a data-url (Phase 1)
| { type: "layer.rename"; id: string; name: string }
| { type: "layer.setHidden"; id: string; hidden: boolean }
| { type: "layer.setLocked"; id: string; locked: boolean }
| { type: "layer.reorder"; id: string; toIndex: number }             // absolute placement (drag-drop)
| { type: "layer.remove"; id: string }                               // deletes the layer + its elements
| { type: "layer.setActive"; id: string }                            // where new marks drop
| { type: "group"; markIds: string[]; name?: string }                // wrap selected elements in a new layer
| { type: "ungroup"; id: string }                                    // dissolve: each element → its own group-of-one layer
```

Element ops (`mark.add/update/remove/reorder`) stay as-is — `mark.add` now
stamps `layerId = active layer`. `mark.reorder` keeps direction-based
intra-layer order.

## Phases (each independently shippable; annotations keep working throughout)

### Phase 0 — contract + migration (redeploy, NO behavior change)

- types.ts: all additions above; `defaultState` adds `layersByVariant: {}`.
- server history: **widen the snapshot unit** from `marksByVariant[vid]` to a
  per-variant `{ marks, layers }` pair, so layer ops are undoable and set
  `markUnseen` (touch `pushHistory` @235–248, the undo/redo handler @826–831).
- restore migration (@1018–1030): for each variant with marks, synthesize one
  default layer `{kind:"annotation", name:"Annotations"}`, stamp every existing
  mark's `layerId` to it, keep `zOrder` as intra-layer order. Backfill
  `layersByVariant ??= {}`.
- `mark.add` (@733): create/resolve the active layer (default "Annotations" if
  none) and stamp `layerId`; `zOrder = (count within that layer)`.
- add an **effective-z comparator** helper `(layerIndex, zOrder)` — used by
  MarkRenderer/flatten/hit; with one layer it's identical to today.
- **No UI.** Acceptance: existing annotate/commit/undo flows behave identically;
  `/state` now shows `layersByVariant` with one layer per annotated variant; 41
  tests green + new state/migration tests.

### Phase 1 — image layers (the headline; minimum collage)

- `layer.addImage` handler: `optimizeSrc` the data-url, push an `ImageLayer`
  mark (`tool:"image"`) into a new image-kind layer, centered ~40%-of-box at the
  bitmap's natural aspect (client measures aspect via `createImageBitmap`, like
  `fileIntake`). Through `pushHistory`; no agent event until commit.
- **leanState (@164):** strip `src` from `image` marks in the agent projection
  (add a `markForAgent`; today marks aren't projected — image src would bloat
  `/state`). The agent reads the flattened composite, never per-layer bitmaps.
- MarkRenderer + flatten.ts: add the `image` case (SVG `<image>` for
  render/flatten parity); **skip hidden layers** in both.
- Context-sensitive drop (Canvas.tsx onCanvasDrop): **on the image box →
  `layer.addImage`; on the margin / blank frame → existing `image.import`
  (replace).** Split the drop-hint into two zones/strings.
- "Add as layer" action on ref thumbnails + sidebar variants → `layer.addImage`.
- Acceptance: drop a clipping → it lands as a movable/resizable image layer;
  commit flattens base + layers → `--ref` → harmonizes via the **existing**
  commit path (zero new handoff mechanism).

### Phase 2 — the inspector panel (Info + Layers) with fluid grouping

- **Selection-lift refactor (prereq):** lift `selectedId` out of
  SelectionOverlay local state into Canvas (controlled), so panel ⇆ canvas share
  one source.
- Panel home (OQ5, resolved): a **Layers section/tab in the existing
  right-of-stage details aside** (Canvas.tsx:546, `w-[300px]`) beside **Info**,
  toggled by a stack icon. Conversation column unchanged. **One heterogeneous
  list** (OQ7, resolved): images + sketch + annotations together.
- Row: grip (drag-reorder → `layer.reorder {toIndex}`) · thumb · name (dbl-click
  rename) · eye (`layer.setHidden`) · lock (`layer.setLocked`) · rotate
  affordance on image layers · expand for multi-element layers · ✕ delete.
  Synthetic locked **Background** row at the bottom (the Variant).
- **Active-layer** state + indicator ("new marks drop into …"). **Tool-aware
  default:** pen strokes accrete into the active sketch layer; a discrete tool
  (arrow/shape/note) creates a fresh group-of-one layer.
- `group` / `ungroup` ops wired to a multi-select + the panel's Group button.
- Two-way select sync; retire the per-selection reorder chevrons.
- All ops route through the widened history (undoable — OQ3 resolved: yes).
- Acceptance: the mockup's six states are real; eye toggles exclude a layer from
  the next commit's flatten.

### Phase 3 — rotation + transform polish

- One rotation handle on the selection frame, **image layers first** (Decision
  B); generalize to all elements only if it abstracts for free.
- `rotation` through render (`transform="rotate(deg cx cy)"`), hit-test
  (`rotatePoint(-deg)` pre-step), flatten (`<g transform>` wrap). `mark.update`
  already accepts scalar keys → `rotation` flows with **zero server change**.
- Rotated-resize in the element's **local frame** (~5-line delta-rotation; OQ2
  resolved: local-frame, not deferred).

### Phase 4 — collage → harmonize framing

- Composer "Harmonize collage →" chip that **populates the box**
  (language-first).
- Optional server-derived **`hasImageLayers`** boolean on the commit/say payload
  (`layersByVariant[vid].some(l => l.kind==="image")`) for model routing —
  additive, can't drift (OQ4 resolved: ship the cheap boolean).
- mediaforge.md guidance: which model for harmonize, the restyle/“make cohesive”
  instruction shape.

## Tactical decisions baked in (cole rubber-stamp or override)

| #   | Question                | Decision in this plan                                                                                                |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| OQ1 | drop = layer vs import  | **context-sensitive** (on-image = layer, margin = import)                                                            |
| OQ2 | rotated-resize          | **local-frame in v1**                                                                                                |
| OQ3 | visibility/lock in undo | **yes** (free via widened history)                                                                                   |
| OQ4 | `hasImageLayers` hint   | **ship it** (Phase 4, server-derived)                                                                                |
| OQ8 | image-layer placement   | **centered ~40% at natural aspect**; multi-file drops cascade by a small offset                                      |
| OQ9 | reorder granularity     | **`toIndex`** (drag-drop wants absolute)                                                                             |
| NEW | Background = layer?     | **No — synthetic locked row backed by the Variant** (minimal disruption; matches flatten's base-image-first)         |
| NEW | ungroup semantics       | **dissolve → each element becomes its own group-of-one layer at the same z-band** (reversible round-trip with group) |

## Risks

- **History unit widening** touches the shipped undo/redo + freshness path — the
  one change to working code in Phase 0. Cover with a test that a layer rename/
  reorder is undoable and bumps `marksUnseen`.
- **State bloat** from inlined image-layer bitmaps → the leanState strip (Phase
  1. is a real obligation, not optional.
- **Selection-lift** touches SelectionOverlay (shipped). Low risk (it already
  reports up; we add the inbound direction) but do it carefully w.r.t.
  `liveOverride` + pin re-edit.
- **Library vs extend (Decision C):** this plan **extends** the SVG/fraction
  system (preserves server-authority + flatten-handoff). Re-weigh only if Phase
  2 drag-reorder + Phase 3 rotation start to feel like reimplementing Konva; the
  container model alone doesn't cross that bar.

## Review folded in (vulcan, 2026-06-15) — verdict: OK with changes (blessed)

Hygiene to honor during implementation (none are rework):

**Contract / render (Q1):**

- The **effective-z comparator must thread a `layerId → index` map** into ALL
  three sites that today sort by a global `zOrder`: MarkRenderer:31,
  SelectionOverlay.topHit:270, flatten:176. (Degenerates to today with one layer
  → Phase 0 safe.)
- **MarkRenderer is an if-chain with no exhaustiveness check** — a missing
  `image` case renders nothing with no tsc error. Add the `image` case
  deliberately. The other ~6 switch sites DO fail tsc on the union add (good):
  translate/resize/resizeHandles/geometryPatch (SelectionOverlay),
  markBounds/hitTest (coords), markSvg (flatten). So `image` is **~7 explicit
  `case "image"` bodies** (trivially copied from `rect`), not zero-cost.
- **commitMarks:184** counts marks via `MARK_TOOLS` for the summary — exclude
  `image`-kind from the "marked: N" annotation summary so it doesn't read oddly.

**Selection-lift (Q2):**

- SelectionOverlay is `key={resetKey}` (variantId) in AnnotationLayer:182 — the
  **remount is what clears selection on image switch.** After lifting
  `selectedId` to Canvas, that clear is gone → **reset it in Canvas's variantId
  layoutEffect (:95)**, else a stale selection points at a nonexistent mark.
- **Lift ONLY `selectedId`.** Keep `gesture` + `editingId` local to
  SelectionOverlay; remove the internal `onSelectionChange` mirror (:240) when
  controlled (else it echoes).
- **`topHit` (:269) + panel-select must skip marks whose layer is locked or
  hidden** — net-new logic in the refactored path; scope it in.
- `liveOverride` is safe (single-pointer, drag-local; a panel click can't strand
  it).

**History (Q3):** sound. `marksUnseen` **over-fires on cosmetic layer ops** (a
rename doesn't change pixels) — **accept it**; over-firing is the safe direction
(a spurious "Take marks" nudge beats the agent missing a real z/hidden change).
Keep the rename/reorder-undoable + bumps-marksUnseen test.

**Phasing (Q4):** sound, order correct. **Phase 1 ships image layers on the
UN-lifted SelectionOverlay** (a rect-geometry mark → existing move/resize/✕ work
with no panel) — Phase 2 then refactors; no ordering conflict. **Decision C
(vulcan's call): extend, no library, not flagged** — panel-list drag-reorder is
list-DnD tier; image-first rotation is one handle + `rotate(deg cx cy)` +
`rotatePoint(-deg)` hit pre-step + local-frame resize delta (tens of lines on
axis-aligned rects). **Tripwire:** re-weigh only if rotation generalizes to ALL
marks (rotated-stroke local-frame resize, rotated-ellipse hit) — kept behind the
"only if it abstracts for free" guardrail. **Phase 3 footnote:** rotation must
also rotate the SelectionOverlay **chrome** (highlightBox + handles derive from
the AABB `markBounds`).

**Decision kicked to cole — pin-vs-image z (surfaces at Phase 1, not Phase 0):**
MarkRenderer draws vector marks in one `<svg>` then pins as **HTML after it**,
so HTML pins ALWAYS paint above the SVG. flatten.ts builds pins as SVG `<text>`,
so it z-orders them correctly. → a pin in a low layer under an image layer: the
**flatten correctly hides it, the live canvas wrongly floats it on top** —
render and handoff disagree. Does NOT block Phase 0.

> **DECIDED (cole, 2026-06-15): SVG pins — true parity.** Render pins as SVG in
> MarkRenderer so they z-order correctly behind image layers (mirroring the path
> flatten.ts already uses); keep the **HTML editor overlay only while a pin is
> being edited** (`editingId`). Live canvas == flattened handoff. Land this as
> part of Phase 1 (when image layers make the divergence reachable). Preserves
> the what-you-see-is-what-the-agent-sees invariant.

## Reference

- `docs/projects/imago/layer-system-investigation.md` — analysis + cole's
  direction + the two refinements (container model, fluid grouping,
  eye=handoff).
- `docs/projects/imago/layers-panel-mockup.html` — the interactive panel mockup
  cole reviewed (the six states Phase 2 makes real).
- `surface/state/types.ts` — the contract this plan extends.
