// surface/components/annotations/tools/RectTool.tsx
// Rectangle: a drag-from-origin gesture. pointerdown sets one corner, pointermove
// sizes the box to the cursor, pointerup commits {x,y,w,h} (fractions, normalized
// so any drag direction works). A press with no real drag is ignored. zOrder is
// server-assigned on mark.add, so the tool omits it.
import { Square } from "lucide-react";
import type { Mark } from "../../../state/types";
import { bbox } from "../coords";
import { DEFAULT_STROKE, DEFAULT_WIDTH } from "../style";
import type { ToolPlugin, ToolUpResult } from "./types";

// the two drag corners; the committed shape is their normalized bounding box
type BoxDraft = { x1: number; y1: number; x2: number; y2: number };

function markId(): string {
  return crypto.randomUUID();
}

export const RectTool: ToolPlugin = {
  id: "rect",
  icon: Square,
  title: "Rectangle — box an area",
  cursor: "cursor-crosshair",
  capturePointer: true,
  onDown: (p) => ({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }),
  onMove: (p, draft) => (draft ? { ...(draft as BoxDraft), x2: p.x, y2: p.y } : draft),
  onUp: (_p, draft): ToolUpResult => {
    const d = draft as BoxDraft | null;
    if (!d) return {};
    if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 0.01) return {}; // a click, not a shape
    const b = bbox(d);
    const mark: Mark = {
      id: markId(),
      tool: "rect",
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
    };
    return { mark };
  },
  renderDraft: (draft, ctx) => {
    const d = draft as BoxDraft | null;
    if (!d) return null;
    const b = bbox(d);
    const stroke = ctx.style.color ?? DEFAULT_STROKE;
    const strokeWidth = (ctx.style.width ?? DEFAULT_WIDTH) * ctx.scale;
    return (
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <title>rectangle preview</title>
        <rect
          x={b.x * 100}
          y={b.y * 100}
          width={b.w * 100}
          height={b.h * 100}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          opacity="0.7"
        />
      </svg>
    );
  },
};
