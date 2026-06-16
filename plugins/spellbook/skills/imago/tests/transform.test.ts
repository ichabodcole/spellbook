// Pure-geometry tests for the aspect-constrained resize math (Phase 3, slice A).
// resizeBoxAspect/resizeBoxFor are exported from SelectionOverlay for this; the
// component itself isn't rendered — these exercise the diagonal-projection math:
//   - a corner resize keeps w:h (uniform scale from the OPPOSITE corner anchor)
//   - the projection means an off-diagonal drag still scales uniformly (no distort)
//   - the opposite corner stays put for any handle
//   - the min-size clamp gates on the smaller side (neither axis underflows)
//   - resizeBoxFor only locks on CORNER handles; edge handles stay free

import { expect, test } from "bun:test";
import type { Box } from "../surface/components/annotations/coords";
import {
  resizeBox,
  resizeBoxAspect,
  resizeBoxFor,
} from "../surface/components/annotations/SelectionOverlay";

const aspect = (b: Box) => b.w / b.h;
const BOX: Box = { x: 0.2, y: 0.2, w: 0.4, h: 0.2 }; // 2:1, anchor corners at the box edges

test("resizeBoxAspect (SE): uniform scale along the diagonal, NW anchor fixed", () => {
  // drag the SE corner outward along the diagonal
  const b = resizeBoxAspect(BOX, "se", 0.04, 0.02);
  expect(aspect(b)).toBeCloseTo(2, 6); // w:h preserved
  expect(b.x).toBeCloseTo(0.2, 6); // NW anchor (top-left) stays put
  expect(b.y).toBeCloseTo(0.2, 6);
  expect(b.w).toBeGreaterThan(BOX.w); // grew
});

test("resizeBoxAspect: an off-diagonal drag still scales uniformly (projection, no distort)", () => {
  // purely-horizontal drag on a corner — free resize would distort; aspect projects it
  const b = resizeBoxAspect(BOX, "se", 0.04, 0);
  expect(aspect(b)).toBeCloseTo(2, 6);
});

test("resizeBoxAspect (NW): the OPPOSITE corner (SE) stays fixed", () => {
  const seX = BOX.x + BOX.w; // 0.6
  const seY = BOX.y + BOX.h; // 0.4
  const b = resizeBoxAspect(BOX, "nw", -0.04, -0.02); // drag top-left outward
  expect(aspect(b)).toBeCloseTo(2, 6);
  expect(b.x + b.w).toBeCloseTo(seX, 6); // SE corner pinned
  expect(b.y + b.h).toBeCloseTo(seY, 6);
});

test("resizeBoxAspect: min-size clamp gates on the smaller side, aspect preserved", () => {
  // shrink hard past zero — the smaller side (h) must floor, not invert
  const b = resizeBoxAspect(BOX, "se", -1, -1);
  expect(b.h).toBeCloseTo(0.01, 6); // MIN_SIZE on the smaller axis
  expect(b.w).toBeCloseTo(0.02, 6); // larger axis scaled to match (still 2:1)
  expect(aspect(b)).toBeCloseTo(2, 6);
});

test("resizeBoxFor: locks only on CORNER handles; edge handles stay free", () => {
  // lock + corner → aspect path
  expect(resizeBoxFor(BOX, "se", 0.04, 0, true)).toEqual(resizeBoxAspect(BOX, "se", 0.04, 0));
  // lock + EDGE → free path (a 1-axis stretch is never aspect-locked)
  expect(resizeBoxFor(BOX, "e", 0.04, 0, true)).toEqual(resizeBox(BOX, "e", 0.04, 0));
  // no lock + corner → free path
  expect(resizeBoxFor(BOX, "se", 0.04, 0, false)).toEqual(resizeBox(BOX, "se", 0.04, 0));
});

test("resizeBox (free) distorts: an edge drag changes one axis only", () => {
  const b = resizeBox(BOX, "e", 0.04, 0);
  expect(b.w).toBeCloseTo(0.44, 6); // width grew
  expect(b.h).toBeCloseTo(0.2, 6); // height unchanged → aspect changed
});
