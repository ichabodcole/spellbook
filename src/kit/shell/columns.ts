// The side columns get out of the way: either one, the context on the left or
// the conversation on the right, can collapse on its own or with the other.
//
// COLLAPSED IS THE LIBRARY'S, NOT OURS. `react-resizable-panels` already has
// collapsible panels: a collapsed one is a panel at its collapsed size (here a
// 40 px rail), and the layout that records it is the one `useDefaultLayout`
// already persists (here, in localStorage). The shell keeps no flag of its own:
// on every layout change it asks each panel `isCollapsed()`, so dragging a column
// shut, clicking its button and restoring a saved layout all land on the same
// fact. The layout in percentages cannot say it alone, because a rail in pixels
// is a different percentage in every window; `collapsedSides` reads it off the
// layout only before the panels exist (the first render, from the saved layout).
//
// What the layout cannot hold is the width a collapsed column should come BACK
// to (the library keeps that in memory, so a reload reopened at the minimum).
// That is a different fact, "how wide do I like it" not "is it open", and it gets
// its own small key.
//
// DOM-free, so the rules are tests; `WorkspaceShell` does the wiring.

import { COLUMN_SIDES, type Collapsed, type ColumnSide } from "../context/columns.ts";

/** The two columns that can collapse, as `context` names them for every subpath. */
export const SIDES = COLUMN_SIDES;
export type Side = ColumnSide;
export type { Collapsed };
/** Panel id to percentage of the group, as the library reports it. */
export type Layout = Record<string, number>;
/** The width each column reopens to, as a percentage. */
export type OpenSizes = Partial<Record<Side, number>>;

/** Where each column opens on a fresh browser: the panels' `defaultSize`. */
export const DEFAULT_SIZE: Record<Side, number> = { context: 22, chat: 28 };
/** The narrowest an OPEN column may be dragged to: the panels' `minSize`. */
export const MIN_SIZE: Record<Side, number> = { context: 12, chat: 15 };
/** The centre pane's `minSize`: what a reopening column must leave it. */
export const CENTRE_MIN_SIZE = 25;

/**
 * A COLUMN AT ITS MINIMUM IS NOT A WIDTH TO REOPEN TO. The minimum is what
 * the library's own `expand()` falls back to when it has no remembered width
 * (after a reload), and remembering it turned one bad reopen into every later
 * one. A human who really drags a column to exactly its
 * minimum loses only the remembering of that width, which is the cheaper
 * mistake. Half a percent of slack, because the layout is floating-point.
 */
const atMinimum = (side: Side, size: number) => size <= MIN_SIZE[side] + 0.5;

/**
 * Where the reopen widths live, beside the library's layout. A bare key: the
 * shell's storage adds its own prefix (`storageKey`, "spellbook" by default).
 */
export const OPEN_KEY = "panes:open";

/**
 * The prefix the shell's keys carried before they were bare: with the storage's
 * own prefix on top, they were stored as `story-studio:story-studio:panes:…`.
 * Read once as a fallback (`readKept`), so nobody's stored state is lost.
 */
export const LEGACY_KEY_PREFIX = "story-studio:";

/**
 * A value the shell keeps, read under its bare key, else under the key it was
 * stored under before (`LEGACY_KEY_PREFIX`). The next write stores it bare.
 */
export function readKept(get: (key: string) => string | null, key: string): string | null {
  return get(key) ?? get(`${LEGACY_KEY_PREFIX}${key}`);
}

/**
 * A collapsed column is a RAIL, not nothing: it keeps this many pixels, enough
 * for its reopen button on the row the pane headings share. The panels'
 * `collapsedSize`.
 */
export const RAIL_PX = 40;

/**
 * Whether each column is collapsed, guessed from the layout alone: below its
 * minimum, less half a percent because the layout is floating-point. The library
 * never leaves an OPEN column narrower than its minimum, and a layout saved at 0
 * by an earlier build (before rails) reads as collapsed too. But a rail is 40 px,
 * so in a window narrower than about 350 px it is MORE than the minimum and this
 * guess says open. So it is only the first render's answer; after that
 * `collapsedFrom` asks the panels.
 */
export function collapsedSides(layout: Layout | undefined): Collapsed {
  const at = (side: Side) => {
    const size = layout?.[side];
    return typeof size === "number" && size < MIN_SIZE[side] - 0.5;
  };
  return { context: at("context"), chat: at("chat") };
}

/** What `collapsedFrom` needs of a panel: the library's `PanelImperativeHandle`. */
export type CollapsiblePanel = { isCollapsed(): boolean };

/**
 * Whether each column is collapsed: the panel's own answer wherever there is a
 * panel to ask, and the layout's guess (`collapsedSides`) only where there is not.
 */
export function collapsedFrom(
  layout: Layout | undefined,
  panels: Partial<Record<Side, CollapsiblePanel | null | undefined>>,
): Collapsed {
  const guess = collapsedSides(layout);
  const at = (side: Side) => panels[side]?.isCollapsed() ?? guess[side];
  return { context: at("context"), chat: at("chat") };
}

/**
 * The reopen widths after a layout change: every OPEN column's width is
 * remembered, and a collapsed one keeps what it had. `collapsed` names the shut
 * ones; without it, a rail or a 0 saved by an earlier build is below any minimum,
 * so `atMinimum` covers it everywhere but a very narrow window. Returns `prev`
 * itself when nothing moved, so the caller can skip writing it.
 *
 * ONLY A CHANGE THE HUMAN MADE (`fromUser` — the library's
 * `isUserInteraction`: a drag or a key on a handle). A reopen is an imperative
 * resize, and when the library squeezes a capped reopen, the width it lands
 * on is the library's compromise, not a choice; remembering it overwrote the
 * width the human had actually picked.
 */
export function rememberOpen(
  prev: OpenSizes,
  layout: Layout,
  fromUser: boolean,
  collapsed?: Collapsed,
): OpenSizes {
  if (!fromUser) return prev;
  let next: OpenSizes = prev;
  for (const side of SIDES) {
    const size = layout[side];
    if (typeof size !== "number" || collapsed?.[side] || atMinimum(side, size)) continue;
    if (prev[side] === size) continue;
    next = { ...next, [side]: size };
  }
  return next;
}

/**
 * The width to reopen `side` at, given the layout it reopens into.
 *
 * Capped so reopening one column never pushes the other shut. A width
 * remembered while the other column was collapsed can be too wide once that
 * column is back; resized to it anyway, the library squeezes the centre to its
 * minimum and then the OTHER column below ITS minimum, which collapses it. So
 * the reopen leaves the centre its minimum and takes only what is left, but
 * never less than the column's own minimum.
 */
export function reopenSize(open: OpenSizes, side: Side, layout: Layout | undefined): number {
  const want = open[side] ?? DEFAULT_SIZE[side];
  const other: Side = side === "context" ? "chat" : "context";
  const otherSize = layout?.[other] ?? 0;
  const room = 100 - otherSize - CENTRE_MIN_SIZE;
  return Math.max(MIN_SIZE[side], Math.min(want, room));
}

export function encodeOpenSizes(open: OpenSizes): string {
  return JSON.stringify(open);
}

/** Tolerant on purpose: a bad value costs a default width, never a broken surface. */
export function decodeOpenSizes(raw: string | undefined): OpenSizes {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  // Before any property read: `null`, a number or a string parse fine and
  // must not reach the loop below (`null[side]` throws). JSON.parse yields only
  // plain data, so past this guard nothing can throw.
  if (!parsed || typeof parsed !== "object") return {};
  const out: OpenSizes = {};
  for (const side of SIDES) {
    const v = (parsed as Record<string, unknown>)[side];
    // A zero would "reopen" collapsed, and a minimum is the library's fallback
    // rather than anybody's choice (`atMinimum`).
    if (typeof v === "number" && !atMinimum(side, v) && v < 100) out[side] = v;
  }
  return out;
}

// ── the floating composer ──────────────────────────────────────────────────
// With the conversation collapsed, the composer floats at the foot of the
// centre, so talking to the agent never needs the column (the user,
// 2026-10-13). The human can close the float too, for a truly minimal centre;
// the rail then carries a chat icon that brings it back. Which of the two it is
// is a viewer's choice like the column widths, so it is kept beside them, and a
// new agent message does not undo it: the rail's unseen mark says it instead.

/** Where the float's closed state lives, beside the layout and the reopen widths. */
export const FLOAT_KEY = "panes:float";

/** The stored value for a closed float; anything else (absent included) is open. */
const FLOAT_CLOSED = "closed";

export function encodeFloatClosed(closed: boolean): string {
  return closed ? FLOAT_CLOSED : "open";
}

/** Tolerant: only the one value closes it, so a bad stored value shows the float. */
export function decodeFloatClosed(raw: string | null | undefined): boolean {
  return raw === FLOAT_CLOSED;
}

/**
 * Whether the composer floats in the centre: exactly while the conversation
 * column is collapsed and the human has not closed the float. An open column
 * has its own composer, and the composer is drawn in one place at a time.
 */
export function floatShown(collapsed: Pick<Collapsed, "chat">, closed: boolean): boolean {
  return collapsed.chat && !closed;
}

/**
 * Whether the collapsed chat rail shows the chat icon that brings the float
 * back: exactly while the column is collapsed and the float is closed.
 */
export function floatOnRail(collapsed: Pick<Collapsed, "chat">, closed: boolean): boolean {
  return collapsed.chat && closed;
}
