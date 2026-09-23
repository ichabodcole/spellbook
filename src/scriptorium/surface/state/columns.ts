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
/** The document pane's `minSize` — what a reopening column must leave it. */
export const DOC_MIN_SIZE = 25;

/**
 * ⚠ A COLUMN AT ITS MINIMUM IS NOT A WIDTH TO REOPEN TO. The minimum is what
 * the library's own `expand()` falls back to when it has no remembered width
 * (after a reload), and remembering it turned one bad reopen into every later
 * one (verifier, 2026-09-22). A human who really drags a column to exactly its
 * minimum loses only the remembering of that width, which is the cheaper
 * mistake. Half a percent of slack, because the layout is floating-point.
 */
const atMinimum = (side: Side, size: number) => size <= MIN_SIZE[side] + 0.5;

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
    if (collapsed[side] || typeof size !== "number" || atMinimum(side, size) || prev[side] === size)
      continue;
    next = { ...next, [side]: size };
  }
  return next;
}

/**
 * The width to reopen `side` at, given the layout it reopens into.
 *
 * ⛔ CAPPED SO REOPENING ONE COLUMN NEVER PUSHES THE OTHER SHUT (verifier,
 * 2026-09-22). A width remembered while the other column was collapsed can be
 * too wide once that column is back; resized to it anyway, the library
 * squeezes the document to its minimum and then the OTHER column below ITS
 * minimum, which collapses it. So the reopen leaves the document its minimum
 * and takes only what is left — but never less than the column's own minimum.
 */
export function reopenSize(open: OpenSizes, side: Side, layout: Layout | undefined): number {
  const want = open[side] ?? DEFAULT_SIZE[side];
  const other: Side = side === "context" ? "chat" : "context";
  const otherSize = layout?.[other] ?? 0;
  const room = 100 - otherSize - DOC_MIN_SIZE;
  return Math.max(MIN_SIZE[side], Math.min(want, room));
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
    // A zero would "reopen" collapsed, and a minimum is the library's fallback
    // rather than anybody's choice (`atMinimum`).
    if (typeof v === "number" && Number.isFinite(v) && !atMinimum(side, v) && v < 100)
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
  // Rounded to the pixel: the browser lays the pane out in 1/64 px units and
  // the layout's percentages are rounded to three decimals, so the estimate
  // lands a few hundredths either side of the whole-pixel width the document
  // would really get (in a 722 px window, where collapsing leaves exactly
  // 720, three layouts read 720.003–720.014, and the verifier's read short).
  return { now, ifCollapsed: Math.round((paneWidth * 100) / docPercent) >= SPLIT_MIN_PX };
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

/**
 * ⛔ WHAT READER MODE'S FADE LEAVES ALONE (Cole, 2026-09-22): while the document
 * has unsaved edits, Save and the "Unsaved" marker stay at full strength and
 * everything else still fades. A quiet reading view must not make an unsaved
 * edit easy to forget; with nothing unsaved, Save has nothing to do and fades
 * with the rest.
 */
export function readerStaysLoud(part: "save" | "unsaved" | "other", dirty: boolean): boolean {
  return dirty && part !== "other";
}
