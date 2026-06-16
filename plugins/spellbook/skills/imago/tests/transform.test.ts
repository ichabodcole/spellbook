// Pure-geometry tests for the aspect-constrained resize math (Phase 3, slice A).
// resizeBoxAspect/resizeBoxFor are exported from SelectionOverlay for this; the
// component itself isn't rendered — these exercise the diagonal-projection math:
//   - a corner resize keeps w:h (uniform scale from the OPPOSITE corner anchor)
//   - the projection means an off-diagonal drag still scales uniformly (no distort)
//   - the opposite corner stays put for any handle
//   - the min-size clamp gates on the smaller side (neither axis underflows)
//   - resizeBoxFor only locks on CORNER handles; edge handles stay free

import { expect, test } from "bun:test";
import {
  type Box,
  hitTest,
  type Point,
  rotatePoint,
} from "../surface/components/annotations/coords";
import {
  resizeBox,
  resizeBoxAspect,
  resizeBoxFor,
} from "../surface/components/annotations/SelectionOverlay";
import type { Mark } from "../surface/state/types";

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

// ── rotatePoint (aspect-aware rotation; render/flatten/hit/gesture all share it) ──

const ORIGIN: Point = { x: 0, y: 0 };

test("rotatePoint: 90° clockwise about origin on a square maps +x → +y (screen y-down)", () => {
  const r = rotatePoint({ x: 1, y: 0 }, 90, ORIGIN, 1);
  expect(r.x).toBeCloseTo(0, 6);
  expect(r.y).toBeCloseTo(1, 6);
});

test("rotatePoint: deg=0 is identity (short-circuit)", () => {
  const p = { x: 0.37, y: 0.62 };
  expect(rotatePoint(p, 0, { x: 0.5, y: 0.5 }, 1.7)).toEqual(p);
});

test("rotatePoint: rotating by deg then -deg round-trips (non-square aspect)", () => {
  const p: Point = { x: 0.3, y: 0.7 };
  const c: Point = { x: 0.5, y: 0.5 };
  const aspect = 16 / 9;
  const there = rotatePoint(p, 37, c, aspect);
  const back = rotatePoint(there, -37, c, aspect);
  expect(back.x).toBeCloseTo(p.x, 6);
  expect(back.y).toBeCloseTo(p.y, 6);
});

test("rotatePoint: aspect is load-bearing — a horizontal offset rotated 90° scales by aspect", () => {
  // on a 2:1 image, a horizontal fraction span is twice as many px as the same
  // vertical fraction, so a 90° turn must lengthen it by `aspect` (no shear).
  const r = rotatePoint({ x: 0.1, y: 0 }, 90, ORIGIN, 2);
  expect(r.x).toBeCloseTo(0, 6);
  expect(r.y).toBeCloseTo(0.2, 6); // 0.1 * aspect
  // and the anisotropy actually matters: aspect=1 would give 0.1, not 0.2
  expect(rotatePoint({ x: 0.1, y: 0 }, 90, ORIGIN, 1).y).toBeCloseTo(0.1, 6);
});

test("hitTest: a rotated mark is hit in its ROTATED footprint, not its original AABB", () => {
  // a wide-horizontal rect; 90° turns it tall-vertical about its center (0.5, 0.5)
  const rect = { id: "r", tool: "rect", x: 0.35, y: 0.45, w: 0.3, h: 0.1, rotation: 90 } as Mark;
  // a point below center is inside the ROTATED (vertical) footprint but outside the
  // original horizontal box — only an un-rotating hit-test can get this right
  expect(hitTest({ x: 0.5, y: 0.62 }, rect, undefined, undefined, 1)).toBe(true);
  // a point right of center is inside the original AABB but outside the rotated shape
  expect(hitTest({ x: 0.62, y: 0.5 }, rect, undefined, undefined, 1)).toBe(false);
  // sanity: drop the rotation and the two truths flip (proves rotation is the cause)
  const flat = { ...rect, rotation: 0 } as Mark;
  expect(hitTest({ x: 0.62, y: 0.5 }, flat, undefined, undefined, 1)).toBe(true);
  expect(hitTest({ x: 0.5, y: 0.62 }, flat, undefined, undefined, 1)).toBe(false);
});
