// surface/components/annotations/tools/LineTool.tsx
// Line: a press-drag-release straight line (no arrowhead). Geometrically identical
// to the arrow — same {x1,y1,x2,y2} drag — it just renders without a marker.
import { Minus } from "lucide-react";
import type { Mark } from "../../../state/types";
import { DEFAULT_STROKE, DEFAULT_WIDTH } from "../style";
import type { ToolPlugin, ToolUpResult } from "./types";

type LineDraft = { x1: number; y1: number; x2: number; y2: number };

function markId(): string {
  return crypto.randomUUID();
}

export const LineTool: ToolPlugin = {
  id: "line",
  icon: Minus,
  title: "Line — draw a straight line",
  cursor: "cursor-crosshair",
  capturePointer: true,
  onDown: (p) => ({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }),
  onMove: (p, draft) => (draft ? { ...(draft as LineDraft), x2: p.x, y2: p.y } : draft),
  onUp: (_p, draft): ToolUpResult => {
    const d = draft as LineDraft | null;
    if (!d) return {};
    if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 0.01) return {};
    const mark: Mark = {
      id: markId(),
      tool: "line",
      x1: d.x1,
      y1: d.y1,
      x2: d.x2,
      y2: d.y2,
    };
    return { mark };
  },
  renderDraft: (draft, ctx) => {
    const d = draft as LineDraft | null;
    if (!d) return null;
    const stroke = ctx.style.color ?? DEFAULT_STROKE;
    const strokeWidth = (ctx.style.width ?? DEFAULT_WIDTH) * ctx.scale;
    return (
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <title>line preview</title>
        <line
          x1={d.x1 * 100}
          y1={d.y1 * 100}
          x2={d.x2 * 100}
          y2={d.y2 * 100}
          stroke={stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
          strokeDasharray="4 3"
          opacity="0.7"
        />
      </svg>
    );
  },
};
