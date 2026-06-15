// surface/components/annotations/MarkRenderer.tsx
// Pure render of committed marks. ONE SVG in the image's NATURAL-dimension coord
// system (viewBox 0 0 natW natH) — the same basis flatten.ts composites in — so
// images, vector marks, AND pins all live in a single z-ordered tree and what you
// see on screen is exactly what the agent receives. (Pins were HTML before, which
// forced them permanently above everything; an SVG <text> in the old stretched
// 0–100 viewBox would shear on a non-square image, so we adopt flatten's uniform
// natural-dim viewBox instead.) pointer-events-none — all interaction lives in the
// layer/tools; this just draws. Stroke widths weld to the image (non-scaling-stroke
// at width×scale px); pin text + arrowheads use flatten's shared geometry.
import { useEffect } from "react";
import type { Layer, Mark } from "../../state/types";
import { type PinSize, visibleSorted } from "./coords";
import { DEFAULT_STROKE, DEFAULT_WIDTH } from "./style";
import { arrowHeadPoints, PIN_BG_DEFAULT, PIN_TEXT, pinLayout } from "./svgMark";

export function MarkRenderer({
  marks,
  layers,
  scale,
  natW,
  natH,
  onMeasurePin,
  liveOverride,
}: {
  marks: Mark[];
  layers: Layer[]; // back→front; drives effective z + the hidden-layer skip
  scale: number; // viewport zoom → vector stroke widths weld to the image
  natW: number; // image natural px (the viewBox basis); 0 until the image loads
  natH: number;
  // report each pin's box (fraction of the image box) so SELECT can size its hit
  // area + highlight to the note. Now derived geometrically (same layout as
  // flatten) rather than DOM-measured — render and handoff can't disagree.
  onMeasurePin?: (id: string, size: PinSize) => void;
  // mid-drag geometry for the selected mark: substituted for the stored mark of
  // the same id so the SHAPE (not just the highlight) moves live with the cursor.
  liveOverride?: Mark | null;
}) {
  const display = liveOverride
    ? marks.map((m) => (m.id === liveOverride.id ? liveOverride : m))
    : marks;

  // Report pin boxes (pure geometry — no DOM measure). The parent's setter guards
  // on value-equality, so redundant reports while dragging/zooming are no-ops.
  useEffect(() => {
    if (!onMeasurePin || natW <= 0 || natH <= 0) return;
    // mirror the render: only VISIBLE pins (hidden-layer pins aren't drawn and
    // shouldn't leave stale bounds behind for hit-testing).
    for (const m of visibleSorted(display, layers)) {
      if (m.tool === "pin") {
        const { bgW, bgH } = pinLayout(m, natW, natH);
        onMeasurePin(m.id, { w: bgW / natW, h: bgH / natH });
      }
    }
  }, [display, layers, natW, natH, onMeasurePin]);

  if (natW <= 0 || natH <= 0) return null; // image not measured yet (box hidden)
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox={`0 0 ${natW} ${natH}`}
    >
      <title>annotations</title>
      {visibleSorted(display, layers).map((m) => {
        const stroke = m.color ?? DEFAULT_STROKE;
        const sw = (m.width ?? DEFAULT_WIDTH) * scale; // px (non-scaling-stroke)
        switch (m.tool) {
          case "image":
            return (
              <image
                key={m.id}
                href={m.src}
                x={m.x * natW}
                y={m.y * natH}
                width={m.w * natW}
                height={m.h * natH}
                preserveAspectRatio="none"
              />
            );
          case "arrow":
            return (
              <g key={m.id}>
                <line
                  x1={m.x1 * natW}
                  y1={m.y1 * natH}
                  x2={m.x2 * natW}
                  y2={m.y2 * natH}
                  stroke={stroke}
                  strokeWidth={sw}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                />
                {/* explicit triangle (matches flatten) — head welds to the image
                    in natural-px units; w is authored px, NOT ×scale */}
                <polygon
                  points={arrowHeadPoints(
                    m.x1 * natW,
                    m.y1 * natH,
                    m.x2 * natW,
                    m.y2 * natH,
                    m.width ?? DEFAULT_WIDTH,
                  )}
                  fill={stroke}
                />
              </g>
            );
          case "line":
            return (
              <line
                key={m.id}
                x1={m.x1 * natW}
                y1={m.y1 * natH}
                x2={m.x2 * natW}
                y2={m.y2 * natH}
                stroke={stroke}
                strokeWidth={sw}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
              />
            );
          case "rect":
            return (
              <rect
                key={m.id}
                x={m.x * natW}
                y={m.y * natH}
                width={m.w * natW}
                height={m.h * natH}
                fill="none"
                stroke={stroke}
                strokeWidth={sw}
                vectorEffect="non-scaling-stroke"
              />
            );
          case "ellipse":
            return (
              <ellipse
                key={m.id}
                cx={m.cx * natW}
                cy={m.cy * natH}
                rx={m.rx * natW}
                ry={m.ry * natH}
                fill="none"
                stroke={stroke}
                strokeWidth={sw}
                vectorEffect="non-scaling-stroke"
              />
            );
          case "draw":
            return (
              <polyline
                key={m.id}
                points={m.points.map((p) => `${p.x * natW},${p.y * natH}`).join(" ")}
                fill="none"
                stroke={stroke}
                strokeWidth={sw}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          case "pin": {
            const { fontSize, cx, cy, lines, lh, bgW, bgH, baseline, rx } = pinLayout(
              m,
              natW,
              natH,
            );
            const bg = m.color ?? PIN_BG_DEFAULT; // live SVG reads CSS vars directly
            // stable per-line keys from cumulative char offset — the wrapped lines
            // never reorder (the whole pin re-renders), so this avoids array-index
            // keys without risking a collision on duplicate line text.
            let off = 0;
            const rows = lines.map((text) => {
              const row = { text, dy: off === 0 ? 0 : lh, key: `${m.id}@${off}` };
              off += text.length + 1;
              return row;
            });
            return (
              <g key={m.id}>
                <rect
                  x={cx - bgW / 2}
                  y={cy - bgH / 2}
                  width={bgW}
                  height={bgH}
                  rx={rx}
                  fill={bg}
                />
                <text
                  x={cx}
                  y={baseline}
                  fontFamily="sans-serif"
                  fontSize={fontSize}
                  fill={PIN_TEXT}
                  textAnchor="middle"
                >
                  {rows.map((row) => (
                    <tspan key={row.key} x={cx} {...(row.dy ? { dy: row.dy } : {})}>
                      {row.text}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          }
          default:
            // exhaustive: every Mark tool returns above. A new tool makes `m`
            // non-never here → a compile error, never a silently-unrendered mark.
            return m satisfies never;
        }
      })}
    </svg>
  );
}
