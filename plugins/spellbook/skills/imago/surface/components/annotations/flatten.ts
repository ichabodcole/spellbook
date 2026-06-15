// surface/components/annotations/flatten.ts
// Flatten-on-commit: rasterize the focused image WITH its marks burned in, at the
// image's natural resolution and viewport-independent (NOT a screenshot of the
// current zoom/pan). Marks are fraction-space, so they map to any resolution.
//
// Mechanism: compose an offscreen SVG (base <image> + marks as SVG) at natural
// dims, load it as an Image, draw it onto a canvas (downscaled if over the long-
// edge cap), and read back a PNG data-url. Pure + best-effort: any failure → "".
//
// Two gotchas handled here:
//  • CSS vars: an SVG loaded via a blob URL can't read the page's `var(--color-*)`
//    tokens, so we resolve them to concrete values up front via getComputedStyle.
//  • Pins are HTML (CSS wrap) on screen; here they become <text>+<tspan> with a
//    \n-split + character-count soft-wrap (spatial-context fidelity, not pixel
//    typography — design OQ4).
import type { Mark } from "../../state/types";
import { DEFAULT_STROKE, DEFAULT_TEXT_SIZE, DEFAULT_WIDTH, PIN_MAX_W_FRACTION } from "./style";

const LONG_EDGE_CAP = 1536; // OQ5: cap the long edge for a fast, small data-url
const PIN_BG_DEFAULT = "var(--color-accent)"; // matches the on-screen `bg-accent`
const PIN_TEXT = "#ffffff";
const CHAR_W = 0.6; // rough advance width as a fraction of font-size (sans-serif)

// Resolve a `var(--token)` to its computed value (SVG-in-a-blob can't read CSS
// vars); pass concrete colors (hex/rgb) through unchanged.
function colorResolver(): (c: string | undefined, fallback?: string) => string {
  const root =
    typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
  return (c, fallback = "") => {
    const v = c ?? fallback;
    const m = v.match(/^var\((--[\w-]+)\)$/);
    if (m && root) return root.getPropertyValue(m[1]).trim() || fallback || v;
    return v;
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Soft-wrap one logical line to a character budget (whole words where possible,
// hard-split a word longer than the budget).
function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(/(\s+)/)) {
    if (cur.length + word.length <= maxChars) {
      cur += word;
    } else if (word.length > maxChars) {
      // flush, then hard-chop the long word
      if (cur.trim()) out.push(cur.trimEnd());
      let rest = (cur + word).trimStart();
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

function pinSvg(
  m: Extract<Mark, { tool: "pin" }>,
  W: number,
  H: number,
  resolve: (c: string | undefined, fallback?: string) => string,
): string {
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
  const bg = resolve(m.color, PIN_BG_DEFAULT);
  const baseline = cy - total / 2 + fontSize * 0.82;
  const tspans = lines
    .map((l, i) => `<tspan x="${cx}"${i ? ` dy="${lh}"` : ""}>${esc(l)}</tspan>`)
    .join("");
  return (
    `<rect x="${cx - bgW / 2}" y="${cy - bgH / 2}" width="${bgW}" height="${bgH}" ` +
    `rx="${fontSize * 0.3}" fill="${bg}"/>` +
    `<text x="${cx}" y="${baseline}" font-family="sans-serif" font-size="${fontSize}" ` +
    `fill="${PIN_TEXT}" text-anchor="middle">${tspans}</text>`
  );
}

// An arrow's head as an explicit filled triangle (avoids relying on SVG2
// context-stroke markers surviving the offscreen rasterize).
function arrowHead(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const len = w * 5;
  const half = w * 2.5;
  const bx = x2 - len * ux;
  const by = y2 - len * uy;
  return `${x2},${y2} ${bx - half * uy},${by + half * ux} ${bx + half * uy},${by - half * ux}`;
}

function markSvg(
  m: Mark,
  W: number,
  H: number,
  resolve: (c: string | undefined, fallback?: string) => string,
): string {
  const stroke = resolve(m.color, DEFAULT_STROKE);
  const sw = m.width ?? DEFAULT_WIDTH; // authored px at natural res (no *scale)
  const common = `stroke="${stroke}" stroke-width="${sw}" fill="none"`;
  switch (m.tool) {
    case "pin":
      return pinSvg(m, W, H, resolve);
    case "arrow": {
      const [x1, y1, x2, y2] = [m.x1 * W, m.y1 * H, m.x2 * W, m.y2 * H];
      return (
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${common} stroke-linecap="round"/>` +
        `<polygon points="${arrowHead(x1, y1, x2, y2, sw)}" fill="${stroke}"/>`
      );
    }
    case "line":
      return `<line x1="${m.x1 * W}" y1="${m.y1 * H}" x2="${m.x2 * W}" y2="${m.y2 * H}" ${common} stroke-linecap="round"/>`;
    case "rect":
      return `<rect x="${m.x * W}" y="${m.y * H}" width="${m.w * W}" height="${m.h * H}" ${common}/>`;
    case "ellipse":
      return `<ellipse cx="${m.cx * W}" cy="${m.cy * H}" rx="${m.rx * W}" ry="${m.ry * H}" ${common}/>`;
    case "draw": {
      const pts = m.points.map((p) => `${p.x * W},${p.y * H}`).join(" ");
      return `<polyline points="${pts}" ${common} stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  }
}

/**
 * Compose `src` + `marks` into a PNG data-url at natural resolution (long edge
 * capped at 1536). Returns "" on any failure (best-effort; caller falls back to
 * the raw variant path + geometry).
 *
 * natW/natH are optional: when omitted (e.g. the chat composer, which has no
 * Canvas `nat` state) they're read from the loaded base image's naturalWidth/
 * Height. Canvas passes them through so it doesn't pay the extra decode.
 */
export async function flattenMarks(
  src: string,
  marks: Mark[],
  natW?: number,
  natH?: number,
): Promise<string> {
  try {
    if (!src) return "";
    let W = natW ?? 0;
    let H = natH ?? 0;
    if (W <= 0 || H <= 0) {
      const base = await loadImage(src); // derive dims from the base image
      W = base.naturalWidth;
      H = base.naturalHeight;
    }
    if (W <= 0 || H <= 0) return "";
    const resolve = colorResolver();
    const sorted = [...marks].sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
    const body = sorted.map((m) => markSvg(m, W, H, resolve)).join("");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<image href="${src}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>` +
      body +
      `</svg>`;

    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, LONG_EDGE_CAP / Math.max(W, H));
      const outW = Math.max(1, Math.round(W * scale));
      const outH = Math.max(1, Math.round(H * scale));
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      ctx.drawImage(img, 0, 0, outW, outH); // scales the natural-res SVG down to the cap
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    console.warn("[imago] flatten failed; falling back to raw variant", err);
    return "";
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
