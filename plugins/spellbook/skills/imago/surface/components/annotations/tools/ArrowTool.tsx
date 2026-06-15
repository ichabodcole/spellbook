// surface/components/annotations/tools/ArrowTool.tsx
// Arrow: a press-drag-release gesture. pointerdown sets the start, pointermove
// stretches a live preview to the cursor, pointerup commits one arrow start→end.
// A press with no real drag is ignored (no phantom zero-length arrow).
import { MoveUpRight } from "lucide-react";
import type { Mark } from "../../../state/types";
import { DEFAULT_STROKE, DEFAULT_WIDTH } from "../style";
import type { ToolPlugin, ToolUpResult } from "./types";

type ArrowDraft = { x1: number; y1: number; x2: number; y2: number };

function markId(): string {
  return crypto.randomUUID();
}

export const ArrowTool: ToolPlugin = {
  id: "arrow",
  icon: MoveUpRight,
  title: "Arrow — move this → there",
  cursor: "cursor-crosshair",
  capturePointer: true, // track the drag past the image edges
  onDown: (p) => ({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }),
  onMove: (p, draft) => (draft ? { ...(draft as ArrowDraft), x2: p.x, y2: p.y } : draft),
  onUp: (_p, draft): ToolUpResult => {
    const d = draft as ArrowDraft | null;
    if (!d) return {};
    // a press with no real drag isn't an arrow
    if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 0.01) return {};
    const mark: Mark = {
      id: markId(),
      tool: "arrow",
      x1: d.x1,
      y1: d.y1,
      x2: d.x2,
      y2: d.y2,
    };
    return { mark };
  },
  renderDraft: (draft, ctx) => {
    const d = draft as ArrowDraft | null;
    if (!d) return null;
    // preview the active style × scale (dashed/translucent) so it matches the commit
    const stroke = ctx.style.color ?? DEFAULT_STROKE;
    const strokeWidth = (ctx.style.width ?? DEFAULT_WIDTH) * ctx.scale;
    return (
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <title>arrow preview</title>
        <defs>
          <marker
            id="imago-arrowhead-draft"
            markerWidth="6"
            markerHeight="6"
            refX="3"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
          </marker>
        </defs>
        <line
          x1={d.x1 * 100}
          y1={d.y1 * 100}
          x2={d.x2 * 100}
          y2={d.y2 * 100}
          stroke={stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
          strokeDasharray="4 3"
          markerEnd="url(#imago-arrowhead-draft)"
          opacity="0.7"
        />
      </svg>
    );
  },
};
