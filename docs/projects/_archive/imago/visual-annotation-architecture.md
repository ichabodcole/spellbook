# imago — Visual annotation handoff + freeform draw tool

Status: **approved-pending-build** (design pass complete; decisions resolved
below) Extends: [annotation-architecture.md](./annotation-architecture.md)

## Why

The annotate→edit handoff was coordinate/text-based: the agent received mark
geometry (fractions) + note text and had to _interpret_ intent ("what does the
arrow mean?", "is the pin position or motion?"). That's fragile, and a
**freeform sketch tool** makes it impossible — you can't convey a hand-drawn
shape as line data; the agent has to _see_ it.

So imago moves to a **visual-primary** handoff:

- **Primary:** a **flattened annotated image** — the focused image with every
  mark (shapes, arrows, lines, notes, freeform strokes) burned in at correct
  positions — sent to the image model as the `--ref`. What you see is what I
  send.
- **Alongside:** the **note text** stays in the instruction (for what a picture
  can't say — "blur this", "match the painterly style", "make it bigger").
- **Backup:** the **raw geometry** stays in the payload (cheap; logging, spatial
  fallback, future masking) but is no longer the primary channel.

This also lays the masking groundwork (a freeform region → an inpaint mask).

## Two additions

### 1. Freeform draw tool (`tool: "draw"`)

```ts
DrawMark = MarkBase & { tool: "draw"; points: { x: number; y: number }[] } // fraction space
```

Points array (not an SVG path string) — plain JSON, every consumer uses existing
geometry primitives. Follows all annotation conventions: fraction coords,
`color`/`width` from MarkBase, `vectorEffect="non-scaling-stroke"` × zoom scale,
durable per-variant. Rendered as `<polyline>`; selectable + move + bbox-resize
(no per-vertex handles); hitTest = min point-to-segment distance. Commit guard:
`points.length >= 2` and a minimum span (drops a stray tap).

### 2. Flatten-on-commit capture pipeline

On "Take marks to the conversation →", the surface rasterizes the focused image
**with marks composited in, at the image's NATURAL resolution and
viewport-independent** (NOT a screenshot of the current zoom/pan crop — marks
are fractional so they map to any resolution).

**Mechanism: offscreen SVG compose + canvas rasterize** (chosen over canvas
re-render and html-to-image):

- Build an SVG at `natW × natH`: `<image>` of the base + the marks as SVG
  (shapes/arrows/lines/polyline at fraction×natural; pins as `<text>`+`<tspan>`
  with a background `<rect>`). Stroke widths are authored px at natural scale.
- Draw the SVG blob to an `OffscreenCanvas` → `toDataURL("image/png")`.
- Pure module `flatten.ts` — no React; returns `""` on failure (best-effort).

Pins are HTML today (CSS wrap); in the capture they convert to SVG `<text>` with
`\n`-split + character-count soft-wrap. "Good enough for spatial context," not
pixel-perfect typography (decision OQ4).

**Data flow:**

```
commitMarks() [Canvas] — async:
  flattenMarks(variant.src, marks, nat.w, nat.h) → PNG data-url
  send { type:"marks.commit", text, batchId, variantId, flattenedSrc }
        ↓ WebSocket
server marks.commit:
  saveDataUrl(flattenedSrc) → flattenedImagePath (session files dir)
  emit { type:"marks.commit", text, batchId, variantId, marks, flattenedImagePath }
        ↓ SSE
agent:
  --ref <flattenedImagePath>  +  note text in the prompt  +  marks[] as backup
```

The data-url is browser→server only; only the on-disk **path** rides the SSE
event (no blob bloat). `leanState` unchanged (marks are geometry; the flattened
image is ephemeral, event-only).

## Contract changes (types.ts)

- `Mark` union += DrawMark; `MARK_TOOLS` += `"draw"`.
- `ClientToServer` `marks.commit` += `flattenedSrc?: string`.
- `AgentEventPayload["marks.commit"]` += `flattenedImagePath?: string`.
- Server `mark.update` must accept a `points` array patch (special-case beyond
  the current number|string merge).

## Resolved decisions

- **OQ1 icon:** `PenLine` (Pencil is taken by the edit-note button).
- **OQ2 points update:** special-case `points` (array of {x,y}) in the server
  `mark.update` handler (keeps the optimistic move/resize pattern).
- **OQ3 flatten failure:** silent fallback (omit `flattenedSrc`; agent falls
  back to the raw variant path + geometry). Console-log only; no user-facing
  error v1.
- **OQ4 pin text wrapping:** character-count heuristic is acceptable v1.
- **OQ5 resolution cap:** cap the flatten at **1536px on the long edge** for v1
  (fast, small data-url; preserves spatial intent; reasoning models downsample
  anyway). Revisit if edits need finer detail.
- **OQ6 gesture text:** special-case `"draw"` → "sketch" in the commit summary
  ("marked: 1 sketch, 2 arrows").

## Build sequence

- **Phase A — contract + server (redeploy):** types.ts (DrawMark, MARK_TOOLS,
  marks.commit fields), server.ts (materialize flattenedSrc → emit path; accept
  points in mark.update). Redeploy.
- **Phase B — draw tool (HMR):** coords.ts (markBounds/hitTest for draw +
  tests), DrawTool.tsx, registry, MarkRenderer polyline, SelectionOverlay
  branches.
- **Phase C — flatten pipeline (HMR, needs Phase A live):** flatten.ts,
  Canvas.commitMarks async.
- **Phase D — agent integration:** use `flattenedImagePath` as `--ref` + note
  text; fall back to variant path if absent.

## Masking groundwork

A `draw` mark whose points enclose a region rasterizes to an inpaint mask (WHITE
= regenerate) at the variant's natural dims — no schema change; the agent
decides to call `generate inpaint --mask` instead of `generate image --ref`. A
dedicated mask tool can come later.
