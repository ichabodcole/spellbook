// Pure unit tests for the BreakdownCanvas geometry seam (fraction↔pixel + the
// rect resize/draw helpers). No DOM — fast + deterministic.

import { expect, test } from "bun:test";
import {
  bboxToFrac,
  clampFrac,
  drawBoxFromCorners,
  type FracBox,
  fracToBbox,
  isDrawable,
  MIN_FRAC,
  resizeFracBox,
} from "../surface/components/breakdown/geometry";
import type { Bbox } from "../surface/state/types";

const SIZE: [number, number] = [1408, 768];

test("bbox→frac→bbox round-trips within ±1px", () => {
  const boxes: Bbox[] = [
    [61, 518, 142, 606],
    [0, 0, 400, 80],
    [700, 300, 1408, 768],
    [13, 7, 1407, 767],
  ];
  for (const b of boxes) {
    const round = fracToBbox(bboxToFrac(b, SIZE), SIZE);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs((round[i] ?? 0) - (b[i] ?? 0))).toBeLessThanOrEqual(1);
    }
  }
});

test("bboxToFrac maps corners to 0..1 fractions", () => {
  const f = bboxToFrac([0, 0, 1408, 768], SIZE);
  expect(f).toEqual({ x: 0, y: 0, w: 1, h: 1 });
});

test("fracToBbox clamps out-of-range fractions into image bounds + orders corners", () => {
  // a box that overshoots both ends → clamped to [0..w]/[0..h]
  const b = fracToBbox({ x: -0.5, y: -0.2, w: 2, h: 2 }, SIZE);
  expect(b).toEqual([0, 0, 1408, 768]);
  // a flipped (negative-size) box normalizes so x1<x2, y1<y2
  const flipped = fracToBbox({ x: 0.5, y: 0.5, w: -0.25, h: -0.25 }, SIZE);
  expect(flipped[0]).toBeLessThan(flipped[2]);
  expect(flipped[1]).toBeLessThan(flipped[3]);
});

test("resizeFracBox anchors the opposite edge", () => {
  const box: FracBox = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  // drag the east edge right → left edge (x) is fixed, width grows
  const e = resizeFracBox(box, "e", 0.1, 0);
  expect(e.x).toBeCloseTo(0.2, 6);
  expect(e.w).toBeCloseTo(0.5, 6);
  expect(e.y).toBeCloseTo(0.2, 6);
  expect(e.h).toBeCloseTo(0.4, 6);
  // drag the west edge right → right edge (x+w) is fixed, width shrinks
  const w = resizeFracBox(box, "w", 0.1, 0);
  expect(w.x + w.w).toBeCloseTo(0.6, 6);
  expect(w.x).toBeCloseTo(0.3, 6);
  // a corner moves two edges; the opposite corner stays put
  const nw = resizeFracBox(box, "nw", 0.05, 0.05);
  expect(nw.x + nw.w).toBeCloseTo(0.6, 6);
  expect(nw.y + nw.h).toBeCloseTo(0.6, 6);
});

test("resizeFracBox never lets an edge cross past MIN_FRAC", () => {
  const box: FracBox = { x: 0.2, y: 0.2, w: 0.1, h: 0.1 };
  // shove the east edge far left past the west edge → floored at MIN_FRAC width
  const e = resizeFracBox(box, "e", -1, 0);
  expect(e.w).toBeCloseTo(MIN_FRAC, 6);
});

test("clampFrac keeps a box in-bounds (slides it back without resizing)", () => {
  const c = clampFrac({ x: 0.9, y: 0.95, w: 0.3, h: 0.2 });
  expect(c.x).toBeGreaterThanOrEqual(0);
  expect(c.y).toBeGreaterThanOrEqual(0);
  expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
  expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
  // size preserved (box fits inside the unit square)
  expect(c.w).toBeCloseTo(0.3, 6);
  expect(c.h).toBeCloseTo(0.2, 6);
});

test("drawBoxFromCorners normalizes any drag direction", () => {
  const a = drawBoxFromCorners(0.3, 0.3, 0.1, 0.1);
  expect(a.x).toBeCloseTo(0.1, 6);
  expect(a.y).toBeCloseTo(0.1, 6);
  expect(a.w).toBeCloseTo(0.2, 6);
  expect(a.h).toBeCloseTo(0.2, 6);
});

test("isDrawable gates a tiny draw", () => {
  expect(isDrawable(drawBoxFromCorners(0.5, 0.5, 0.502, 0.502))).toBe(false);
  expect(isDrawable(drawBoxFromCorners(0.1, 0.1, 0.4, 0.4))).toBe(true);
});
