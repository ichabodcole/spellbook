// A zoomed and panned view of a drawing or a picture in a pane: the arithmetic
// shared by Atlas's map and the kit's image viewer. Pure, no DOM.
//
// - a view is FITTED to the pane: as large as fits, never past a ceiling;
// - the wheel zooms about the pointer, and so does a trackpad pinch (a wheel
//   event with ctrlKey), between a floor and a ceiling of zoom;
// - a two-finger scroll pans.

export type Size = { w: number; h: number };
/** The transform of the drawing: scale `k`, then offset by `x`, `y` (pane pixels). */
export type View = { k: number; x: number; y: number };
/** How far a view may zoom out and in. */
export type ZoomLimits = { min: number; max: number };

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;
/** The map's zoom range, the default. */
export const MAP_ZOOM: ZoomLimits = { min: ZOOM_MIN, max: ZOOM_MAX };
/** How much one press of + or − zooms. */
export const ZOOM_STEP = 1.25;
/** A pane that reports no size (a test's DOM, a pane not yet laid out) is taken as this. */
export const FALLBACK_SIZE: Size = { w: 800, h: 600 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The view that fits `content` in `pane`: as large as fits, no larger than
 * `ceil`, and no smaller than `floor`. Content that still does not fit at the
 * floor is aligned to its start (top left), so its first column is on screen
 * and the rest is a pan away; content that fits is centred.
 */
export function fitView(
  pane: Size,
  content: Size,
  opts: { floor?: number; ceil?: number; limits?: ZoomLimits } = {},
): View {
  const limits = opts.limits ?? MAP_ZOOM;
  const floor = opts.floor ?? limits.min;
  const ceil = opts.ceil ?? 1;
  const w = Math.max(1, content.w);
  const h = Math.max(1, content.h);
  let k = Math.min(pane.w / w, pane.h / h, ceil);
  // Too wide to fit at a readable size: fit the height instead, and start at the
  // left, so the first columns are readable and the rest is a pan away.
  if (k < floor) k = Math.max(floor, Math.min(ceil, pane.h / h));
  k = clamp(k, limits.min, limits.max);
  const x = content.w * k <= pane.w ? (pane.w - content.w * k) / 2 : 0;
  const y = content.h * k <= pane.h ? (pane.h - content.h * k) / 2 : 0;
  return { k, x, y };
}

/** Zoom `view` by `factor` about the pane point (`cx`, `cy`), which stays put. */
export function zoomAt(
  view: View,
  factor: number,
  cx: number,
  cy: number,
  limits: ZoomLimits = MAP_ZOOM,
): View {
  const k = clamp(view.k * factor, limits.min, limits.max);
  const f = k / view.k;
  return { k, x: cx - (cx - view.x) * f, y: cy - (cy - view.y) * f };
}

/** What a wheel event is: a pinch, a mouse wheel's notch, or a trackpad's two-finger scroll. */
export type WheelIntent = "pinch" | "wheel" | "pan";

/** `WheelEvent.deltaMode`: pixels, lines, pages. */
const DOM_DELTA_PIXEL = 0;

/**
 * Which gesture a wheel event is, the way Figma reads them, since browsers send
 * all three as `wheel`:
 *
 * - **Pinch**: `ctrlKey`. A trackpad pinch arrives as a wheel with ctrlKey (and
 *   so does ctrl plus a mouse wheel, which zooms too). Zooms about the pointer.
 * - **Mouse wheel**: the delta is in lines or pages (`deltaMode` 1 or 2), or it
 *   is in pixels with no sideways part and a large whole step: a multiple of 100
 *   or 120, the notch sizes browsers report for a wheel. Zooms about the pointer.
 * - **Two-finger scroll**: anything else, which is what trackpads send: pixel
 *   deltas that are small or fractional, or any `deltaX`. Pans.
 *
 * A heuristic, not a fact the event states: no browser says which device it
 * came from. A trackpad flick can produce a whole multiple of 100 and zoom; a
 * smooth-scrolling mouse can produce small deltas and pan.
 */
export function wheelIntent(e: {
  ctrlKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
}): WheelIntent {
  if (e.ctrlKey) return "pinch";
  if (e.deltaMode !== DOM_DELTA_PIXEL) return "wheel";
  if (e.deltaX !== 0) return "pan";
  const step = Math.abs(e.deltaY);
  const notch = Number.isInteger(step) && step > 0 && (step % 100 === 0 || step % 120 === 0);
  return notch ? "wheel" : "pan";
}

/** A wheel's vertical delta in pixels: lines and pages read as their usual sizes. */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  return deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY;
}

/** A wheel event's zoom factor: a pinch (ctrlKey) is finer-grained than a wheel notch. */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  return Math.exp(-deltaY * (pinch ? 0.01 : 0.0015));
}

/**
 * A wheel event as a change of view: a pan for a two-finger scroll, else a zoom
 * about the pointer (`cx`, `cy` in pane pixels). Missing numbers (a synthetic
 * event leaves some out) read as none.
 */
export function wheelView(
  view: View,
  e: { ctrlKey?: boolean; deltaMode?: number; deltaX?: number; deltaY?: number },
  cx: number,
  cy: number,
  limits: ZoomLimits = MAP_ZOOM,
): View {
  const n = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const w = {
    ctrlKey: e.ctrlKey === true,
    deltaMode: n(e.deltaMode),
    deltaX: n(e.deltaX),
    deltaY: n(e.deltaY),
  };
  const intent = wheelIntent(w);
  if (intent === "pan") return { ...view, x: view.x - w.deltaX, y: view.y - w.deltaY };
  const dy = wheelPixels(w.deltaY, w.deltaMode);
  return zoomAt(view, wheelFactor(dy, intent === "pinch"), n(cx), n(cy), limits);
}
