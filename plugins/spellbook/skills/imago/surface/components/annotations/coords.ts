// surface/components/annotations/coords.ts
// The single screen→image coordinate mapping plus fraction-space geometry. Marks
// are stored as fractions (0–1) of the image box and rendered INSIDE it, so they
// transform with the viewport's pan/zoom automatically. This is the load-bearing
// seam every tool (and, later, masking) shares.
import type React from "react";
import type { Mark } from "../../state/types";

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

// Pointer position as a 0–1 fraction of the event's currentTarget box, clamped
// to [0,1] so a drag that leaves the image still yields in-bounds coords.
export function frac(e: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>): Point {
  const r = e.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

// Normalize the two corners of a drag into a top-left bounding box (fractions),
// so a shape gesture works in any drag direction. Shared by the box-drag tools.
export function bbox(d: { x1: number; y1: number; x2: number; y2: number }): Box {
  return {
    x: Math.min(d.x1, d.x2),
    y: Math.min(d.y1, d.y2),
    w: Math.abs(d.x2 - d.x1),
    h: Math.abs(d.y2 - d.y1),
  };
}

// A pin's rendered box: its measured text size (fractions of the image box),
// centered on its point (the span is translate -50%/-50%). Unmeasured → a 0×0
// point at the pin, so callers fall back to today's point behavior.
export type PinSize = { w: number; h: number };
export function pinBox(m: { x: number; y: number }, size?: PinSize): Box {
  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  return { x: m.x - w / 2, y: m.y - h / 2, w, h };
}

// Axis-aligned bounding box of a mark, in fraction space. A pin is a point (0×0)
// until its rendered text box is measured and passed in as `pinSize`.
export function markBounds(m: Mark, pinSize?: PinSize): Box {
  switch (m.tool) {
    case "pin":
      return pinBox(m, pinSize);
    case "arrow":
    case "line":
      return bbox({ x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2 });
    case "rect":
      return { x: m.x, y: m.y, w: m.w, h: m.h };
    case "ellipse":
      return { x: m.cx - m.rx, y: m.cy - m.ry, w: m.rx * 2, h: m.ry * 2 };
    case "draw":
      return pointsBounds(m.points);
  }
}

// Bounding box of a freeform stroke's points (empty → a 0×0 point at origin).
function pointsBounds(points: Point[]): Box {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Shortest distance from point p to segment a→b (fraction space).
function pointToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

// Default hit tolerance (~2% of the image box) for the distance-based tools.
export const HIT_THRESHOLD = 0.02;

// Is point p "on" mark m? A measured pin is its text box (grab from anywhere on
// the note); an unmeasured pin falls back to a point-distance test. arrow/line
// are distance tests (threshold); rect/ellipse are area tests. All in fractions.
export function hitTest(p: Point, m: Mark, threshold = HIT_THRESHOLD, pinSize?: PinSize): boolean {
  switch (m.tool) {
    case "pin": {
      if (!pinSize || (pinSize.w === 0 && pinSize.h === 0)) {
        return Math.hypot(p.x - m.x, p.y - m.y) <= threshold;
      }
      const b = pinBox(m, pinSize);
      return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    }
    case "arrow":
    case "line":
      return pointToSegment(p, { x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 }) <= threshold;
    case "rect":
      return (
        p.x >= m.x - threshold &&
        p.x <= m.x + m.w + threshold &&
        p.y >= m.y - threshold &&
        p.y <= m.y + m.h + threshold
      );
    case "ellipse": {
      if (m.rx <= 0 || m.ry <= 0) return false;
      const dx = (p.x - m.cx) / m.rx;
      const dy = (p.y - m.cy) / m.ry;
      return dx * dx + dy * dy <= 1;
    }
    case "draw": {
      // on the stroke = near any of its segments (or its single point)
      const pts = m.points;
      if (pts.length === 0) return false;
      if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= threshold;
      for (let i = 1; i < pts.length; i++) {
        if (pointToSegment(p, pts[i - 1], pts[i]) <= threshold) return true;
      }
      return false;
    }
  }
}
