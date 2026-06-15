// Pure-geometry unit tests for fileIntake's centeredLayerBox — the contain-fit
// placement for image layers. Critical because ImageLayer renders with
// preserveAspectRatio="none": the fraction box MUST encode the image's aspect in
// the BASE box's pixel space, or the dropped image stretches.
//
// (The other fileIntake exports touch DOM APIs — createImageBitmap/canvas — and
// are exercised live, not here; centeredLayerBox is pure arithmetic.)

import { expect, test } from "bun:test";
import { centeredLayerBox } from "../surface/state/fileIntake";

// the rendered-pixel aspect of a box on a base = (w*baseW)/(h*baseH); it must
// equal the source image's aspect for there to be no stretch.
const renderedAspect = (box: { w: number; h: number }, baseW: number, baseH: number): number =>
  (box.w * baseW) / (box.h * baseH);

test("square image on a square base → centered 40% box", () => {
  const box = centeredLayerBox(100, 100, 1000, 1000);
  expect(box).toEqual({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
});

test("wide image preserves aspect (no stretch) and fits within 40%", () => {
  const box = centeredLayerBox(200, 100, 1000, 1000); // 2:1 image
  // contained by width at 40%; height is half → 0.2
  expect(box.w).toBeCloseTo(0.4, 10);
  expect(box.h).toBeCloseTo(0.2, 10);
  // rendered pixel aspect equals the source 2:1
  expect(renderedAspect(box, 1000, 1000)).toBeCloseTo(2, 10);
  // centered
  expect(box.x).toBeCloseTo(0.3, 10);
  expect(box.y).toBeCloseTo(0.4, 10);
});

test("aspect is preserved across a NON-square base too", () => {
  // square image onto a 2:1 base — the box fractions differ per axis, but the
  // rendered pixels must still be square.
  const box = centeredLayerBox(100, 100, 1000, 500);
  expect(renderedAspect(box, 1000, 500)).toBeCloseTo(1, 10);
  // contained by the base's short axis (height) at 40% → 200px tall on a 500px base
  expect(box.h).toBeCloseTo(0.4, 10);
  expect(box.w).toBeCloseTo(0.2, 10);
});

test("tall image fits within the 40% region by height", () => {
  const box = centeredLayerBox(100, 200, 1000, 1000); // 1:2 image
  expect(box.h).toBeCloseTo(0.4, 10);
  expect(box.w).toBeCloseTo(0.2, 10);
  expect(renderedAspect(box, 1000, 1000)).toBeCloseTo(0.5, 10);
});
