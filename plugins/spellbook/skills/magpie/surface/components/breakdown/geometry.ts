// surface/components/breakdown/geometry.ts
// Pure, unit-tested bbox↔fraction geometry for the BreakdownCanvas. `Element.bbox`
// is canonical SOURCE PIXELS [x1,y1,x2,y2]; the canvas works in FRACTION space
// (0..1 of the image box, the imago model) and converts at the edges via
// `source.size`. Rect-only — no rotation/ellipse/draw (much simpler than imago's
// SelectionOverlay geometry, which this adapts).

import type { Bbox } from "../../state/types";

// A box in fraction space (0..1 of the image box): top-left origin + size.
export type FracBox = { x: number; y: number; w: number; h: number };

// Minimum extent (fractions) for a resize edge and a drawn region — a sub-min
// drag is a click, not a shape.
export const MIN_FRAC = 0.01;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// px bbox → fraction box. Guards a degenerate (0-sized) source so we never /0.
export function bboxToFrac(b: Bbox, size: [number, number]): FracBox {
  const [w, h] = size;
  const [x1, y1, x2, y2] = b;
  const sw = w > 0 ? w : 1;
  const sh = h > 0 ? h : 1;
  return { x: x1 / sw, y: y1 / sh, w: (x2 - x1) / sw, h: (y2 - y1) / sh };
}

// fraction box → px bbox: round to ints, clamp to [0..w]/[0..h], ensure x1<x2,
// y1<y2 (a flipped drag normalizes). The canonical write path back to Element.bbox.
export function fracToBbox(f: FracBox, size: [number, number]): Bbox {
  const [w, h] = size;
  let x1 = clamp(Math.round(f.x * w), 0, w);
  let y1 = clamp(Math.round(f.y * h), 0, h);
  let x2 = clamp(Math.round((f.x + f.w) * w), 0, w);
  let y2 = clamp(Math.round((f.y + f.h) * h), 0, h);
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  return [x1, y1, x2, y2];
}

// Keep a box within [0,1] WITHOUT changing its size where possible: shift it back
// inside the unit box; only a box larger than the image is shrunk to fit. This is
// the move-friendly clamp (a drag that pushes a box off-edge slides it back).
export function clampFrac(f: FracBox): FracBox {
  const cw = Math.min(Math.max(f.w, 0), 1);
  const ch = Math.min(Math.max(f.h, 0), 1);
  const x = clamp(f.x, 0, 1 - cw);
  const y = clamp(f.y, 0, 1 - ch);
  return { x, y, w: cw, h: ch };
}

// Resize a box by dragging the named handle (corner ids nw/ne/se/sw, edge ids
// n/e/s/w); the OPPOSITE edge(s) stay anchored. Adapted from imago's resizeBox —
// rect-only, MIN_FRAC floor. Pure.
export function resizeFracBox(box: FracBox, handle: string, dx: number, dy: number): FracBox {
  let L = box.x;
  let R = box.x + box.w;
  let T = box.y;
  let B = box.y + box.h;
  if (handle.includes("w")) L = Math.min(R - MIN_FRAC, box.x + dx);
  if (handle.includes("e")) R = Math.max(L + MIN_FRAC, box.x + box.w + dx);
  if (handle.includes("n")) T = Math.min(B - MIN_FRAC, box.y + dy);
  if (handle.includes("s")) B = Math.max(T + MIN_FRAC, box.y + box.h + dy);
  return { x: L, y: T, w: R - L, h: B - T };
}

// Normalize a drag's two corners into a top-left FracBox (any drag direction).
// The "mark a missed region" draft. Mirrors imago coords.ts `bbox`.
export function drawBoxFromCorners(x1: number, y1: number, x2: number, y2: number): FracBox {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

// Is a drawn/drafted region big enough to commit? (gates the tiny-drag "click".)
export function isDrawable(f: FracBox, min = MIN_FRAC): boolean {
  return f.w >= min && f.h >= min;
}
