import { expect, test } from "bun:test";
import { hitTest, markBounds } from "../surface/components/annotations/coords";
import type { Mark } from "../surface/state/types";

const pin: Mark = { id: "p", tool: "pin", label: "n", x: 0.5, y: 0.5 };
const arrow: Mark = { id: "a", tool: "arrow", x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.2 };
const rect: Mark = { id: "r", tool: "rect", x: 0.3, y: 0.3, w: 0.4, h: 0.2 };
const ellipse: Mark = { id: "e", tool: "ellipse", cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.1 };
// an L-shaped freeform stroke: (0.2,0.2) → (0.2,0.6) → (0.6,0.6)
const draw: Mark = {
  id: "d",
  tool: "draw",
  points: [
    { x: 0.2, y: 0.2 },
    { x: 0.2, y: 0.6 },
    { x: 0.6, y: 0.6 },
  ],
};

function expectBox(
  b: { x: number; y: number; w: number; h: number },
  x: number,
  y: number,
  w: number,
  h: number,
) {
  expect(b.x).toBeCloseTo(x, 6);
  expect(b.y).toBeCloseTo(y, 6);
  expect(b.w).toBeCloseTo(w, 6);
  expect(b.h).toBeCloseTo(h, 6);
}

test("markBounds: pin is a point, shapes are their extents", () => {
  expectBox(markBounds(pin), 0.5, 0.5, 0, 0);
  // arrow bounds = bbox of endpoints (horizontal arrow → zero height)
  expectBox(markBounds(arrow), 0.2, 0.2, 0.6, 0);
  expectBox(markBounds(rect), 0.3, 0.3, 0.4, 0.2);
  // ellipse bounds = center ± radii
  expectBox(markBounds(ellipse), 0.3, 0.4, 0.4, 0.2);
  // draw bounds = bbox over all points
  expectBox(markBounds(draw), 0.2, 0.2, 0.4, 0.4);
});

test("hitTest pin: within ~radius hits, beyond misses", () => {
  expect(hitTest({ x: 0.5, y: 0.5 }, pin)).toBe(true);
  expect(hitTest({ x: 0.51, y: 0.5 }, pin)).toBe(true); // 0.01 < 0.02
  expect(hitTest({ x: 0.6, y: 0.5 }, pin)).toBe(false); // 0.10 > 0.02
});

test("hitTest arrow: on the segment hits, off the line misses", () => {
  expect(hitTest({ x: 0.5, y: 0.2 }, arrow)).toBe(true); // on the line
  expect(hitTest({ x: 0.5, y: 0.205 }, arrow)).toBe(true); // just off, within threshold
  expect(hitTest({ x: 0.5, y: 0.3 }, arrow)).toBe(false); // 0.1 off the line
  expect(hitTest({ x: 0.05, y: 0.2 }, arrow)).toBe(false); // past the start endpoint
});

test("hitTest rect: inside hits, outside misses", () => {
  expect(hitTest({ x: 0.5, y: 0.4 }, rect)).toBe(true);
  expect(hitTest({ x: 0.31, y: 0.31 }, rect)).toBe(true);
  expect(hitTest({ x: 0.9, y: 0.4 }, rect)).toBe(false);
});

test("hitTest ellipse: (dx/rx)²+(dy/ry)²≤1", () => {
  expect(hitTest({ x: 0.5, y: 0.5 }, ellipse)).toBe(true); // center
  expect(hitTest({ x: 0.69, y: 0.5 }, ellipse)).toBe(true); // inside on the x-axis (0.19 < rx 0.2)
  expect(hitTest({ x: 0.71, y: 0.5 }, ellipse)).toBe(false); // just outside on the x-axis
  expect(hitTest({ x: 0.5, y: 0.61 }, ellipse)).toBe(false); // outside on the y-axis (0.11 > ry 0.1)
});

test("hitTest draw: near a segment hits, off the stroke + inside the bend miss", () => {
  expect(hitTest({ x: 0.2, y: 0.4 }, draw)).toBe(true); // on the vertical segment
  expect(hitTest({ x: 0.4, y: 0.6 }, draw)).toBe(true); // on the horizontal segment
  expect(hitTest({ x: 0.215, y: 0.4 }, draw)).toBe(true); // just off, within threshold
  expect(hitTest({ x: 0.5, y: 0.4 }, draw)).toBe(false); // inside the L's bend, off both segments
  expect(hitTest({ x: 0.9, y: 0.9 }, draw)).toBe(false); // far away
});
