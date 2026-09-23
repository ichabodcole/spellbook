// E64: the side columns get out of the way. Cole asked for more room, above all
// where two documents share the centre (split and compare), and either column —
// the context on the left, the conversation on the right — can collapse on its
// own or with the other.
//
// ⛔ COLLAPSED IS A WIDTH, NOT A FLAG. `react-resizable-panels` already has
// collapsible panels: a collapsed one is simply a panel at its collapsed size
// (0), and the layout that records it is the one `useDefaultLayout` already
// persists in the home's prefs beside every other pane size. So "is the chat
// collapsed?" is read OFF the layout, and there is no second piece of state
// that could disagree with what is on screen — dragging a column shut, clicking
// its button and restoring a saved layout all land on the same fact.
//
// What the layout cannot hold is the width a collapsed column should come BACK
// to (the library keeps that in memory, so a reload reopened at the minimum).
// That is a different fact — "how wide do I like it", not "is it open" — and
// it gets its own small pref.
//
// DOM-free, like `place.ts`; `App.tsx` does the wiring.

/** The two columns that can collapse. The document never does. */
export const SIDES = ["context", "chat"] as const;
export type Side = (typeof SIDES)[number];

export type Collapsed = Record<Side, boolean>;
/** Panel id → percentage of the group, as the library reports it. */
export type Layout = Record<string, number>;
/** The width each column reopens to, as a percentage. */
export type OpenSizes = Partial<Record<Side, number>>;

/** Where each column opens on a fresh home — the panels' `defaultSize`. */
export const DEFAULT_SIZE: Record<Side, number> = { context: 22, chat: 28 };
/** The narrowest an OPEN column may be dragged to — the panels' `minSize`. */
export const MIN_SIZE: Record<Side, number> = { context: 12, chat: 15 };

/** The pref the reopen widths live in, beside the library's layout pref. */
export const OPEN_PREF = "panes:open";

/**
 * Below this a column is collapsed. The library writes exactly 0, but a
 * layout is floating-point percentages and a hand-edited pref is anybody's
 * guess; anything under 1% is not a column a human could read, and every OPEN
 * column is at least its minimum (12%).
 */
const COLLAPSED_BELOW = 1;

export function collapsedSides(layout: Layout | undefined): Collapsed {
  const at = (side: Side) => {
    const size = layout?.[side];
    return typeof size === "number" && size < COLLAPSED_BELOW;
  };
  return { context: at("context"), chat: at("chat") };
}

/**
 * The reopen widths after a layout change: every OPEN column's width is
 * remembered, and a collapsed one keeps what it had. Returns `prev` itself when
 * nothing moved, so the caller can skip writing the pref.
 */
export function rememberOpen(prev: OpenSizes, layout: Layout): OpenSizes {
  const collapsed = collapsedSides(layout);
  let next: OpenSizes = prev;
  for (const side of SIDES) {
    const size = layout[side];
    if (collapsed[side] || typeof size !== "number" || prev[side] === size) continue;
    next = { ...next, [side]: size };
  }
  return next;
}

export function reopenSize(open: OpenSizes, side: Side): number {
  return open[side] ?? DEFAULT_SIZE[side];
}

export function encodeOpenSizes(open: OpenSizes): string {
  return JSON.stringify(open);
}

/** Tolerant on purpose: a bad pref costs a default width, never a broken surface. */
export function decodeOpenSizes(raw: string | undefined): OpenSizes {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: OpenSizes = {};
  for (const side of SIDES) {
    const v = (parsed as Record<string, unknown>)[side];
    // A zero (or anything under the collapsed line) would "reopen" collapsed.
    if (typeof v === "number" && Number.isFinite(v) && v >= COLLAPSED_BELOW && v < 100)
      out[side] = v;
  }
  return out;
}

/**
 * Below this the document pane cannot hold two readable columns: the raw
 * view's measure is 76ch and the rendered view's the same, so a split narrower
 * than this is two columns of broken lines rather than a comparison.
 */
export const SPLIT_MIN_PX = 720;

/**
 * Whether split fits in the width the document pane actually has — and, when
 * it does not, whether collapsing the side columns would make it fit. The
 * second answer is what lets the disabled split button name the act that
 * enables it instead of only saying no.
 *
 * `docPercent` is the document pane's share of the group, which is what turns
 * its measured width into the width it would have alone. Width 0 is "not
 * measured yet", not "too narrow": a saved split must not flicker through
 * rendered on the first frame.
 */
export function splitRoom(
  paneWidth: number,
  docPercent: number,
): { now: boolean; ifCollapsed: boolean } {
  const now = paneWidth === 0 || paneWidth >= SPLIT_MIN_PX;
  if (now || docPercent <= 0 || docPercent >= 100 - COLLAPSED_BELOW)
    return { now, ifCollapsed: false };
  return { now, ifCollapsed: (paneWidth * 100) / docPercent >= SPLIT_MIN_PX };
}

/**
 * ⛔ READER MODE IS A PRESET, NOT A FIFTH VIEW MODE (Cole): rendered, both
 * columns collapsed, quieter chrome. So it is DERIVED — true exactly when the
 * view is rendered and both columns are shut, however that came about — and
 * there is no reader flag to fall out of step with the columns it describes.
 */
export function isReader(mode: string, collapsed: Collapsed): boolean {
  return mode === "rendered" && collapsed.context && collapsed.chat;
}

/**
 * What the reader toggle does. Entering sets rendered and collapses whatever is
 * open; leaving reopens both columns and leaves the view rendered — a preset
 * remembers nothing about where you were, which is what keeps it one state.
 */
export function readerAct(
  mode: string,
  collapsed: Collapsed,
): { mode?: "rendered"; collapse: Side[]; expand: Side[] } {
  if (isReader(mode, collapsed)) return { expand: [...SIDES], collapse: [] };
  return {
    mode: "rendered",
    collapse: SIDES.filter((s) => !collapsed[s]),
    expand: [],
  };
}
