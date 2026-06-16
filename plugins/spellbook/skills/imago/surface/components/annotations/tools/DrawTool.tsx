// surface/components/annotations/tools/DrawTool.tsx
// Freeform sketch: press-drag-release collects a polyline of fraction-space
// points (one per pointermove). pointerup commits if it's a real stroke (≥2
// points AND a non-trivial span) — a stray tap is dropped. The captured stroke
// is the visual-handoff primitive: what you draw is what the model sees.
import { PenLine } from "lucide-react";
import type { Mark } from "../../../state/types";
import { markBounds } from "../coords";
import { DEFAULT_STROKE, DEFAULT_WIDTH } from "../style";
import type { ToolPlugin, ToolUpResult } from "./types";

type DrawDraft = { points: { x: number; y: number }[] };

// minimum bounding span (max of w,h, fractions) for a stroke to count — drops a
// stray tap/click that produced a couple of near-identical points
const MIN_SPAN = 0.005;

function markId(): string {
  return crypto.randomUUID();
}

function polyPoints(points: { x: number; y: number }[]): string {
  return points.map((p) => `${p.x * 100},${p.y * 100}`).join(" ");
}

export const DrawTool: ToolPlugin = {
  id: "draw",
  icon: PenLine,
  title: "Draw — freeform sketch",
  cursor: "cursor-crosshair",
  capturePointer: true, // track the drag past the image edges
  onDown: (p) => ({ points: [{ x: p.x, y: p.y }] }),
  onMove: (p, draft) =>
    draft ? { points: [...(draft as DrawDraft).points, { x: p.x, y: p.y }] } : draft,
  onUp: (_p, draft): ToolUpResult => {
    const d = draft as DrawDraft | null;
    if (!d || d.points.length < 2) return {}; // a tap, not a stroke
    const b = markBounds({ id: "", tool: "draw", points: d.points });
    if (Math.max(b.w, b.h) < MIN_SPAN) return {}; // a jittery tap, not a stroke
    const mark: Mark = { id: markId(), tool: "draw", points: d.points };
    return { mark };
  },
  renderDraft: (draft, ctx) => {
    const d = draft as DrawDraft | null;
    if (!d || d.points.length === 0) return null;
    // preview the active style × scale (dashed/translucent) so it matches the commit
    const stroke = ctx.style.color ?? DEFAULT_STROKE;
    const strokeWidth = (ctx.style.width ?? DEFAULT_WIDTH) * ctx.scale;
    return (
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <title>sketch preview</title>
        <polyline
          points={polyPoints(d.points)}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="4 3"
          opacity="0.7"
        />
      </svg>
    );
  },
};
