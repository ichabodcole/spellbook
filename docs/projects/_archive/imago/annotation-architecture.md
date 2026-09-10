# imago — annotation system architecture

**Status:** approved 2026-06-12 (live-spin design pass). Guides the build-out of
imago's on-canvas annotation tools beyond the initial arrow + pin.

## Why

Annotation started as two tools (arrow, pin) implemented inline in the large
`surface/components/Canvas.tsx`. We're growing it into a small, idiomatic,
extensible annotation system — shape tools (rectangle, ellipse) alongside
arrow/pin, plus **select → move → resize → reorder (z-order)** of placed shapes
— organized so new tools (and eventually **masking**) drop in cleanly. Not
Photoshop; no layers panel. Priorities: idiomatic tool UX, an architecture you
can add tools onto, code separation/maintainability, and a foundation that
directly serves masking.

## Invariants to preserve

- **One coordinate space.** Marks are stored as fractions (0–1) of the image box
  and rendered _inside_ it, so they transform with pan/zoom automatically. This
  is load-bearing — masking reuses the same mapping. `frac()` (screen→fraction)
  is the single source of truth.
- **Daemon holds canonical state; surface broadcasts.** The surface sends typed
  `ClientToServer` messages; the daemon mutates `ImagoState` and re-broadcasts.
  Mid-gesture drafts are local React state; committed shapes live in
  `state.marks`. Any persistent op (move/resize/reorder a committed mark) is a
  contract message + server handler.
- **Annotations are a comms layer, not paint.** The durable image stays clean;
  the agent receives committed marks via the `marks.commit` event and formats
  them for whichever model (words for reasoning models, mask for inpaint).
- **Semantic theme only** (bg-surface, text-muted, border-edge, bg-accent, …).

## Data model

`Mark` becomes a `tool`-discriminated union with a shared base. Coords are
fractions; every mark has a stable `id` and a `zOrder` integer (higher = on top,
assigned at add time as `state.marks.length`).

```ts
type MarkBase = { id: string; zOrder: number; label?: string };
type PinMark = MarkBase & { tool: "pin"; x: number; y: number };
type ArrowMark = MarkBase & {
  tool: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
type RectMark = MarkBase & {
  tool: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
};
type EllipseMark = MarkBase & {
  tool: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};
// later: MaskMark = MarkBase & { tool: "mask"; points: {x,y}[]; opacity?: number };
type Mark = PinMark | ArrowMark | RectMark | EllipseMark;
```

Transient vs. committed: mid-gesture preview = local state (never sent);
completed gesture = `mark.add` immediately; move/resize = optimistic-local
during drag, commit on `pointerUp`; z-order nudge = fire immediately.

## Contract additions

New `ClientToServer` messages (consistent with existing add/clear/commit; **no
new agent SSE events** — the agent still only hears `marks.commit`, now with the
richer union):

- `{ type: "mark.update"; id; patch }` — move/resize a committed mark (server
  merges, preserving id/tool/zOrder; rejects cross-tool patches).
- `{ type: "mark.remove"; id }` — delete one mark (complements `marks.clear`).
- `{ type: "mark.reorder"; id; direction: "forward"|"back"|"front"|"back-most" }`
  — server re-indexes `zOrder`.

`server.ts` `mark.add` validates the new tools + assigns `zOrder`; restore
backfills missing `zOrder` (same pattern as the `analysis` backfill).

## Module structure

Extract annotation out of `Canvas.tsx` (which keeps the viewport, reference
drawer, details sidebar) into `surface/components/annotations/`:

```
annotations/
  coords.ts            frac() + hitTest() + markBounds()  (fraction space)
  tools/
    types.ts           ToolPlugin interface + DraftState
    registry.ts        TOOL_REGISTRY map  (add a tool = register it)
    ArrowTool.tsx  PinTool.tsx  RectTool.tsx  EllipseTool.tsx
  MarkRenderer.tsx     pure render of committed marks (SVG + HTML pins), sorted by zOrder
  SelectionOverlay.tsx hit-test, handles, drag-move, resize, bring-forward/send-back
  AnnotationLayer.tsx  lives in the image box; owns active-tool dispatch + drafts + selection
AnnotationToolbar.tsx  the tool strip (built from the registry)
```

**`ToolPlugin`** (the extension point):
`{ icon, title, cursor, onDown(point, draft) → draft, onMove(point, draft) → draft, onUp(point, draft) → Mark | null, renderDraft(draft) → ReactNode }`.
`select` is NOT a plugin — it's a separate branch (hands pointer to the viewport
pan + activates `SelectionOverlay`).

`MarkRenderer` is `pointer-events-none`; all interaction is in
`SelectionOverlay` (hit targets rendered in `zOrder` _descending_ so the topmost
is hit first; `MarkRenderer` draws _ascending_ for correct visual stacking).

## Interaction model

- **Select:** click a hit target (sized from `markBounds`) → `selectedMarkId`
  (local state).
- **Move:** drag the hit area; optimistic local offset during drag;
  `mark.update` on release; a sub-threshold drag is treated as a click (select
  only).
- **Resize:** corner/edge handles for rect/ellipse, endpoint handles for arrow;
  pin has none; min-size clamped client-side.
- **Reorder:** bring-forward / send-back buttons near the selection →
  `mark.reorder`.
- **Occlusion:** resolved by reorder, not click-through.

## Masking-readiness

A future `MaskTool` is just another `ToolPlugin` building a polygon in fraction
space; add `MaskMark` to the union; `MarkRenderer` gets a `<polygon>` branch;
`SelectionOverlay` uses bbox + point-in-polygon. The agent gets the polygon at
commit and converts to a pixel mask using the image's natural dims (from
`Variant.path`). Zero architectural change.

## Build sequence (each step independently shippable)

1. **Extract the module — pure refactor, zero behavior change.** Move frac →
   coords; ArrowTool/PinTool as plugins; registry; MarkRenderer;
   AnnotationLayer; AnnotationToolbar; `Canvas.tsx` delegates. Output is
   pixel-identical. _(zOrder + the contract messages fold into step 2, so step 1
   needs no daemon redeploy — keep it a clean surface-only refactor.)_
2. **rect + ellipse tools** — extend the `Mark` union (+ `zOrder`), `mark.add`
   validation, `mark.remove`; `MarkRenderer` branches.
3. **select + move + delete** — `mark.update`; `SelectionOverlay` (hit-test,
   move, delete).
4. **resize** — handles per shape.
5. **z-order reorder** — `mark.reorder`; bring-forward/send-back; sort.
6. _(optional)_ inline label editing for arrows.

## Testing

`bun test` over `annotations/coords.ts` — pure-function unit tests for `hitTest`
and `markBounds` across all mark types (no DOM).
