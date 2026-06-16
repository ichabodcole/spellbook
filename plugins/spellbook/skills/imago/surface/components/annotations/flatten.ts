// surface/components/annotations/flatten.ts
// Flatten-on-commit: rasterize the focused image WITH its marks burned in, at the
// image's natural resolution and viewport-independent (NOT a screenshot of the
// current zoom/pan). Marks are fraction-space, so they map to any resolution.
//
// Mechanism: compose an offscreen SVG (base <image> + marks as SVG) at natural
// dims, load it as an Image, draw it onto a canvas (downscaled if over the long-
// edge cap), and read back a PNG data-url. Pure + best-effort: any failure → "".
//
// Geometry is shared with the LIVE renderer via svgMark.ts (pinLayout,
// arrowHeadPoints, wrapLine) — pins are SVG <rect>+<text>/<tspan> both here AND on
// screen (MarkRenderer), with the same \n-split + character-count soft-wrap, so
// what-you-see == what-the-agent-sees (spatial-context fidelity, not pixel
// typography — design OQ4). One gotcha is local to this offscreen path:
//  • CSS vars: an SVG loaded via a blob URL can't read the page's `var(--color-*)`
//    tokens, so we resolve them to concrete values up front via getComputedStyle.
//    (The live renderer reads the vars directly, so it skips this step.)
import type { Layer, Mark } from "../../state/types";
import { markBounds, visibleSorted } from "./coords";
import { DEFAULT_STROKE, DEFAULT_WIDTH } from "./style";
import { arrowHeadPoints, PIN_BG_DEFAULT, PIN_TEXT, pinLayout } from "./svgMark";

const LONG_EDGE_CAP = 1536; // OQ5: cap the long edge for a fast, small data-url

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

function pinSvg(
  m: Extract<Mark, { tool: "pin" }>,
  W: number,
  H: number,
  resolve: (c: string | undefined, fallback?: string) => string,
): string {
  const { fontSize, cx, cy, lines, lh, bgW, bgH, baseline, rx } = pinLayout(m, W, H);
  const bg = resolve(m.color, PIN_BG_DEFAULT);
  const tspans = lines
    .map((l, i) => `<tspan x="${cx}"${i ? ` dy="${lh}"` : ""}>${esc(l)}</tspan>`)
    .join("");
  return (
    `<rect x="${cx - bgW / 2}" y="${cy - bgH / 2}" width="${bgW}" height="${bgH}" ` +
    `rx="${rx}" fill="${bg}"/>` +
    `<text x="${cx}" y="${baseline}" font-family="sans-serif" font-size="${fontSize}" ` +
    `fill="${PIN_TEXT}" text-anchor="middle">${tspans}</text>`
  );
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
    case "image":
      // an image layer element: place its bitmap by its fraction-space bbox.
      return `<image href="${m.src}" x="${m.x * W}" y="${m.y * H}" width="${m.w * W}" height="${m.h * H}" preserveAspectRatio="none"/>`;
    case "arrow": {
      const [x1, y1, x2, y2] = [m.x1 * W, m.y1 * H, m.x2 * W, m.y2 * H];
      return (
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${common} stroke-linecap="round"/>` +
        `<polygon points="${arrowHeadPoints(x1, y1, x2, y2, sw)}" fill="${stroke}"/>`
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
 *
 * `layers` drives effective z (layer order then zOrder) AND the handoff filter:
 * marks in hidden layers are dropped, so the agent never receives them. Empty
 * layers → today's flat zOrder-only behavior.
 */
export async function flattenMarks(
  src: string,
  marks: Mark[],
  natW?: number,
  natH?: number,
  layers: Layer[] = [],
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
    const body = visibleSorted(marks, layers)
      .map((m) => {
        const svg = markSvg(m, W, H, resolve);
        // rotation (image-first): same rotate-about-bbox-center the live renderer
        // applies, burned in here so the handoff PNG matches what's on screen.
        if (!m.rotation) return svg;
        const b = markBounds(m);
        const cx = (b.x + b.w / 2) * W;
        const cy = (b.y + b.h / 2) * H;
        return `<g transform="rotate(${m.rotation} ${cx} ${cy})">${svg}</g>`;
      })
      .join("");
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
