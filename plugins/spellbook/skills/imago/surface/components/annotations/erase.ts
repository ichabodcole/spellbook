// surface/components/annotations/erase.ts
// Pen-eraser geometry (pure, no React). With the Draw tool active, holding
// Option turns the drag into an erase: points of existing `draw` strokes within
// the eraser radius of the cursor path are removed, and a stroke SPLITS where a
// middle section is erased. Pen-only — every other mark passes through untouched.
import type { Mark } from "../../state/types";
import type { Point } from "./coords";

// Eraser radius in fraction space (~2.5% of the image box). Tunable; could later
// scale with zoom or expose a size control.
export const ERASER_RADIUS = 0.025;

function markId(): string {
  return crypto.randomUUID();
}

// Is p within r of any point on the eraser path?
function nearPath(p: Point, eraserPath: Point[], r: number): boolean {
  const r2 = r * r;
  for (const q of eraserPath) {
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

// Trim a stroke's points by the eraser path: drop every point within r of any
// eraser-path point; return the surviving contiguous RUNS (a run breaks wherever
// points were removed). Runs shorter than 2 points are dropped (not a line).
export function erasePolyline(points: Point[], eraserPath: Point[], r: number): Point[][] {
  const runs: Point[][] = [];
  let cur: Point[] = [];
  for (const p of points) {
    if (nearPath(p, eraserPath, r)) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

// Apply the eraser path to every mark. `draw` marks are trimmed/split:
//   0 runs ⇒ drop the mark; 1 run ⇒ keep it (same id) with the trimmed points;
//   ≥2 runs ⇒ the first run keeps the id, each extra run becomes a NEW draw mark
//   (same color/width). Non-draw marks pass through. Order is preserved (server
//   re-assigns zOrder on marks.replace).
export function eraseMarks(marks: Mark[], eraserPath: Point[], r: number): Mark[] {
  if (eraserPath.length === 0) return marks;
  const out: Mark[] = [];
  for (const m of marks) {
    if (m.tool !== "draw") {
      out.push(m);
      continue;
    }
    const runs = erasePolyline(m.points, eraserPath, r);
    runs.forEach((run, i) => {
      out.push(i === 0 ? { ...m, points: run } : { ...m, id: markId(), points: run });
    });
    // 0 runs ⇒ nothing pushed ⇒ the stroke is dropped
  }
  return out;
}
