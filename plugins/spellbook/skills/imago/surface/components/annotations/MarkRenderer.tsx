// surface/components/annotations/MarkRenderer.tsx
// Pure render of committed marks (SVG arrow/line/rect/ellipse + HTML pins).
// pointer-events-none — all interaction lives in the layer/tools; this just
// draws. Coords are fractions of the image box (% / viewBox 0–100), so positions
// ride the viewport's pan/zoom. Stroke width + pin text size are authored px "at
// 100% zoom" and multiplied by `scale` so they WELD to the image (no bloat when
// zoomed out). Drawn in zOrder ascending (higher = on top).
import { useLayoutEffect, useRef } from "react";
import type { Mark } from "../../state/types";
import type { PinSize } from "./coords";
import { DEFAULT_STROKE, DEFAULT_TEXT_SIZE, DEFAULT_WIDTH, PIN_MAX_W_FRACTION } from "./style";

export function MarkRenderer({
  marks,
  scale,
  onMeasurePin,
  liveOverride,
}: {
  marks: Mark[];
  scale: number;
  // report each pin's rendered text box (fractions of the image box) so SELECT
  // can size its hit area + highlight to the note, not a fixed point.
  onMeasurePin?: (id: string, size: PinSize) => void;
  // mid-drag geometry for the selected mark: substituted for the stored mark of
  // the same id so the SHAPE (not just the highlight) moves live with the cursor.
  liveOverride?: Mark | null;
}) {
  const display = liveOverride
    ? marks.map((m) => (m.id === liveOverride.id ? liveOverride : m))
    : marks;
  const sorted = [...display].sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
  return (
    <>
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <title>annotations</title>
        <defs>
          {/* context-stroke → the arrowhead inherits each arrow's stroke color */}
          <marker
            id="imago-arrowhead"
            markerWidth="6"
            markerHeight="6"
            refX="3"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
          </marker>
        </defs>
        {sorted.map((m) => {
          const stroke = m.color ?? DEFAULT_STROKE;
          // px stroke authored at 100%, scaled by the viewport; non-scaling-stroke
          // renders it at exactly that many px (no viewBox distortion).
          const strokeWidth = (m.width ?? DEFAULT_WIDTH) * scale;
          if (m.tool === "arrow" || m.tool === "line") {
            return (
              <line
                key={m.id}
                x1={m.x1 * 100}
                y1={m.y1 * 100}
                x2={m.x2 * 100}
                y2={m.y2 * 100}
                stroke={stroke}
                strokeWidth={strokeWidth}
                vectorEffect="non-scaling-stroke"
                markerEnd={m.tool === "arrow" ? "url(#imago-arrowhead)" : undefined}
              />
            );
          }
          if (m.tool === "rect") {
            return (
              <rect
                key={m.id}
                x={m.x * 100}
                y={m.y * 100}
                width={m.w * 100}
                height={m.h * 100}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
                vectorEffect="non-scaling-stroke"
              />
            );
          }
          if (m.tool === "ellipse") {
            return (
              <ellipse
                key={m.id}
                cx={m.cx * 100}
                cy={m.cy * 100}
                rx={m.rx * 100}
                ry={m.ry * 100}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
                vectorEffect="non-scaling-stroke"
              />
            );
          }
          if (m.tool === "draw") {
            return (
              <polyline
                key={m.id}
                points={m.points.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          }
          return null;
        })}
      </svg>
      {sorted.map((m) =>
        m.tool === "pin" ? (
          <PinLabel key={m.id} mark={m} scale={scale} onMeasure={onMeasurePin} />
        ) : null,
      )}
    </>
  );
}

// A committed pin's label. Self-measuring: after layout it reports its rendered
// box as a fraction of the image box (its positioned parent = the layer's inset-0
// div). The fraction is scale-invariant — both the span and the image grow with
// zoom by the same factor — so the reported size is stable across zoom.
function PinLabel({
  mark,
  scale,
  onMeasure,
}: {
  mark: Extract<Mark, { tool: "pin" }>;
  scale: number;
  onMeasure?: (id: string, size: PinSize) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  // Re-measure whenever the span's rendered size changes — driven by a
  // ResizeObserver rather than prop deps, so label / fontSize / zoom edits all
  // retrigger it without listing values the effect doesn't itself read.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !onMeasure) return;
    const measure = () => {
      const box = el.offsetParent as HTMLElement | null;
      if (!box) return;
      const pw = box.clientWidth;
      const ph = box.clientHeight;
      if (pw > 0 && ph > 0) onMeasure(mark.id, { w: el.offsetWidth / pw, h: el.offsetHeight / ph });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mark.id, onMeasure]);

  return (
    <span
      ref={ref}
      className="absolute -translate-x-1/2 -translate-y-1/2 w-max bg-accent text-white px-1.5 py-0.5 rounded shadow pointer-events-none leading-tight whitespace-pre-wrap [overflow-wrap:anywhere]"
      style={{
        left: `${mark.x * 100}%`,
        top: `${mark.y * 100}%`,
        fontSize: `${(mark.fontSize ?? DEFAULT_TEXT_SIZE) * scale}px`,
        // wrap at a fraction of the image box (scales with zoom) so a long note
        // doesn't sprawl across the image; honors explicit \n via pre-wrap above.
        // w-max (width:max-content) sizes to content REGARDLESS of position — without
        // it, abspos shrink-to-fit = (container − left) so the note wraps earlier the
        // further right it's dragged. With it, the wrap point is constant.
        maxWidth: `${PIN_MAX_W_FRACTION * 100}%`,
        ...(mark.color ? { backgroundColor: mark.color } : {}),
      }}
    >
      {mark.label}
    </span>
  );
}
