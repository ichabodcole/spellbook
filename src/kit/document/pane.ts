// The document pane's small decisions, as pure rules so they have tests.
import type { DocView, Version } from "../workspace/protocol";

/**
 * How the human looks at the document. Raw is where it is edited (and an app's inline
 * shapes are text); rendered is where it is read (and they are its widgets); split is
 * both side by side, offered only by an app that turns it on; compare shows two
 * versions and is a different kind of thing that shares the toolbar anyway: "how am I
 * looking at this document" is the question the toolbar answers, and a comparison is
 * an answer to it.
 */
export const VIEW_MODES = ["raw", "rendered", "split", "compare"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** Where the pane keeps the view mode when the app names no key of its own. */
export const DEFAULT_VIEW_MODE_KEY = "spellbook:view-mode";

/**
 * A stored mode, or raw. Compare is never restored: it needs a payload that is gone.
 * Split is restored only for an app that offers it; another app sharing the key, or
 * this one after turning it off, reads raw.
 */
export function readViewMode(stored: string | null, opts: { split?: boolean } = {}): ViewMode {
  if (stored === "rendered") return "rendered";
  if (stored === "split" && opts.split) return "split";
  return "raw";
}

/**
 * The narrowest pane split is offered in. Below it the two halves are each under
 * 360 px, and the raw editor's 40 px side padding leaves about 280 px of text: a
 * column of broken lines on both sides rather than two readable views.
 */
export const SPLIT_MIN_PX = 720;

/**
 * Whether split fits a pane `width` pixels wide. Zero means "not measured yet", not
 * "too narrow": a saved split must not flash through raw before the first measure.
 */
export function splitFits(width: number): boolean {
  return width === 0 || width >= SPLIT_MIN_PX;
}

/**
 * The mode actually drawn. A split the app does not offer, or that does not fit the
 * pane, is drawn as raw: raw rather than rendered because split's left half IS the
 * raw editor, so the caret, its undo history and an app's toolbar (which inserts at
 * the caret whenever there is an editor) carry on as they were. The chosen mode is
 * kept, so widening the pane brings split back.
 */
export function shownViewMode(mode: ViewMode, opts: { split: boolean; width: number }): ViewMode {
  if (mode !== "split") return mode;
  return opts.split && splitFits(opts.width) ? "split" : "raw";
}

/** Where the pane keeps the line-number choice when the app names no key of its own. */
export const DEFAULT_LINE_NUMBERS_KEY = "spellbook:line-numbers";

/**
 * Whether the raw editor numbers its lines: only when the human turned it on. A
 * viewer preference, stored as "on" or "off" beside the view mode, so it
 * survives a reload; anything else (nothing stored, a value it cannot read) is off.
 */
export function readLineNumbers(stored: string | null): boolean {
  return stored === "on";
}

/** The stored form of the line-number choice. */
export function storedLineNumbers(on: boolean): "on" | "off" {
  return on ? "on" : "off";
}

/**
 * The split's two halves, as the layout library knows them, and the id their sizes
 * are kept under, in the workspace's `storage` as
 * `react-resizable-panels:doc-split:doc-raw:doc-rendered`. Renaming one forgets a
 * viewer's width.
 */
export const SPLIT_LAYOUT_ID = "doc-split";
export const SPLIT_PANES = ["doc-raw", "doc-rendered"] as const;

/**
 * Where the split opens (the raw half's share; the rendered half takes the rest),
 * and the narrowest either half may be, in percent of the pane.
 */
export const SPLIT_DEFAULT_SIZE = 50;
export const SPLIT_MIN_SIZE = 25;

/**
 * Whether a layout the split's group reports is the split's own, both halves in it.
 * The group outlives the split: raw and rendered are drawn in it too, one panel
 * wide, so moving between them and split keeps the editor mounted. The layout
 * hook keeps each layout under its own panels' ids, so a one-panel layout would be
 * a key of its own (`…:doc-split:doc-raw`), a write to the app's store on every
 * switch that nothing reads.
 */
export function isSplitLayout(layout: Readonly<Record<string, number>>): boolean {
  return SPLIT_PANES.every((id) => typeof layout[id] === "number");
}

/** Whether a mode shows the raw editor, so there is a caret to insert at. */
export function hasEditor(mode: ViewMode): boolean {
  return mode === "raw" || mode === "split";
}

/** The number a new version will get: one past the highest there is, which numbers never reuse. */
export function nextVersionNumber(versions: readonly Pick<Version, "n">[]): number {
  return Math.max(0, ...versions.map((v) => v.n)) + 1;
}

/** What the status strip says about the document's relation to its file. */
export function saveState(doc: Pick<DocView, "outsideChanged" | "dirty" | "missing">): string {
  if (doc.missing) return "File gone";
  return doc.outsideChanged ? "Changed on disk" : doc.dirty ? "Unsaved" : "Saved";
}

/**
 * The text to show for a document: its active version's text when the surface has
 * it, else the last text shown for THIS document, so a newly active version's text on
 * its way never blanks the pane.
 */
export function textToShow(
  slug: string,
  current: string | undefined,
  last: { slug: string; text: string } | null,
): string | undefined {
  if (current !== undefined) return current;
  return last && last.slug === slug ? last.text : undefined;
}

/**
 * The text with `insert` placed at `at`: how a toolbar inserts in the rendered view,
 * where there is no caret but there may be a selection.
 */
export function insertAt(text: string, at: number, insert: string): string {
  const i = Math.max(0, Math.min(at, text.length));
  return text.slice(0, i) + insert + text.slice(i);
}

/**
 * Where a passage the agent pointed at is in the active text now. The daemon
 * placed it in `version`; if that is still the text on screen the offsets
 * stand, and otherwise (another version became active, or the text moved
 * under it) the quote is found again. Null when it is not there at all: the
 * pane then says so, rather than leaving the chat's line claiming it was shown.
 */
export function pointedRange(
  p: { version: number; from: number; to: number; quote: string },
  active: number,
  text: string,
): { from: number; to: number } | null {
  if (active === p.version && text.slice(p.from, p.to) === p.quote)
    return { from: p.from, to: p.to };
  const at = text.indexOf(p.quote);
  return at === -1 ? null : { from: at, to: at + p.quote.length };
}
