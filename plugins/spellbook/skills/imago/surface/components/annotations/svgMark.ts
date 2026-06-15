// surface/components/annotations/svgMark.ts
// Shared, PURE SVG geometry for marks — the single source of truth behind BOTH the
// live render (MarkRenderer: JSX in a natural-dimension viewBox) and the flattened
// handoff (flatten.ts: an offscreen SVG string rasterized for the agent). Sharing
// it is what makes what-you-see == what-the-agent-sees: pins wrap identically,
// arrowheads are the same explicit triangle, coords map the same way. Everything
// is emitted in caller-supplied W×H units (fractions × the target width/height) —
// the live renderer passes the image's natural px, and so does flatten, so the two
// are pixel-congruent at 100% zoom (the resolution flatten always rasterizes at).
import type { Mark } from "../../state/types";
import { DEFAULT_TEXT_SIZE, PIN_MAX_W_FRACTION } from "./style";

export const CHAR_W = 0.6; // rough advance width as a fraction of font-size (sans-serif)
export const PIN_TEXT = "#ffffff"; // label text — white on the accent chip (matches `text-white`)
export const PIN_BG_DEFAULT = "var(--color-accent)"; // matches the on-screen `bg-accent`

// Soft-wrap one logical line to a character budget (whole words where possible,
// hard-split a word longer than the budget).
export function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(/(\s+)/)) {
    if (cur.length + word.length <= maxChars) {
      cur += word;
    } else if (word.length > maxChars) {
      // flush, then hard-chop the long word (cur is already flushed above —
      // start the chop from the long word alone, never re-prepend cur)
      if (cur.trim()) out.push(cur.trimEnd());
      let rest = word.trimStart();
      cur = "";
      while (rest.length > maxChars) {
        out.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      cur = rest;
    } else {
      if (cur.trim()) out.push(cur.trimEnd());
      cur = word.trimStart();
    }
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out.length ? out : [line];
}

// A pin's text + box geometry in W×H space (caller passes the target width/height,
// e.g. natural px). The bg box is centered on the pin's point; `lines` is the
// \n-split + soft-wrapped label; `baseline` is the first line's text baseline.
export type PinLayout = {
  fontSize: number;
  cx: number;
  cy: number;
  lines: string[];
  lh: number; // line height
  bgW: number;
  bgH: number;
  baseline: number;
  rx: number; // bg corner radius
};
export function pinLayout(m: Extract<Mark, { tool: "pin" }>, W: number, H: number): PinLayout {
  const fontSize = m.fontSize ?? DEFAULT_TEXT_SIZE;
  const cx = m.x * W;
  const cy = m.y * H;
  const maxChars = Math.max(1, Math.floor((PIN_MAX_W_FRACTION * W) / (fontSize * CHAR_W)));
  const lines = (m.label ?? "").split("\n").flatMap((l) => wrapLine(l, maxChars));
  const lh = fontSize * 1.2;
  const total = lines.length * lh;
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const padX = fontSize * 0.45;
  const padY = fontSize * 0.18;
  const bgW = longest * fontSize * CHAR_W + padX * 2;
  const bgH = total + padY * 2;
  const baseline = cy - total / 2 + fontSize * 0.82;
  const rx = fontSize * 0.3;
  return { fontSize, cx, cy, lines, lh, bgW, bgH, baseline, rx };
}

// An arrow's head as an explicit filled triangle (avoids relying on SVG2
// context-stroke markers surviving render/rasterize). `w` is the arrow's stroke
// width in the SAME W×H units as the endpoints. Returns an SVG `points` string.
export function arrowHeadPoints(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const len = w * 5;
  const half = w * 2.5;
  const bx = x2 - len * ux;
  const by = y2 - len * uy;
  return `${x2},${y2} ${bx - half * uy},${by + half * ux} ${bx + half * uy},${by - half * ux}`;
}
