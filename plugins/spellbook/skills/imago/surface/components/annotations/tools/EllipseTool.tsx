// surface/components/annotations/tools/EllipseTool.tsx
// Ellipse: a drag-from-origin gesture that inscribes an ellipse in the dragged
// bounding box. pointerdown sets one corner, pointermove sizes it, pointerup
// commits {cx,cy,rx,ry} (fractions). A press with no real drag is ignored.
// zOrder is server-assigned, so the tool omits it.
import { Circle } from "lucide-react";
import type { Mark } from "../../../state/types";
import { bbox } from "../coords";
import { DEFAULT_STROKE, DEFAULT_WIDTH } from "../style";
import type { ToolPlugin, ToolUpResult } from "./types";

type BoxDraft = { x1: number; y1: number; x2: number; y2: number };

function markId(): string {
  return crypto.randomUUID();
}

export const EllipseTool: ToolPlugin = {
  id: "ellipse",
  icon: Circle,
  title: "Ellipse — circle an area",
  cursor: "cursor-crosshair",
  capturePointer: true,
  onDown: (p) => ({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }),
  onMove: (p, draft) => (draft ? { ...(draft as BoxDraft), x2: p.x, y2: p.y } : draft),
  onUp: (_p, draft): ToolUpResult => {
    const d = draft as BoxDraft | null;
    if (!d) return {};
    if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 0.01) return {};
    const b = bbox(d);
    const mark: Mark = {
      id: markId(),
      tool: "ellipse",
      cx: b.x + b.w / 2,
      cy: b.y + b.h / 2,
      rx: b.w / 2,
      ry: b.h / 2,
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
        <title>ellipse preview</title>
        <ellipse
          cx={(b.x + b.w / 2) * 100}
          cy={(b.y + b.h / 2) * 100}
          rx={(b.w / 2) * 100}
          ry={(b.h / 2) * 100}
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
