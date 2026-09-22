// E63: keeping your place. Cole flips raw ↔ rendered constantly — rendered to
// read, raw to select and edit — and every flip used to land him at the top of
// the document; in split, the two halves scrolled apart.
//
// ⛔ ONE PRIMITIVE, TWO CALLERS. Both halves of that want the same two things:
// WHICH SOURCE LINE is at the top of this pane, and PUT THIS PANE at source
// line N. The source line is the shared currency because it is the one
// coordinate both views can name — the raw view has it from CodeMirror, the
// rendered view derives it through E51's projection, and neither has to know
// anything about the other's geometry. A mode switch and a split are then the
// same mechanism: a pane reports where it is, and any other pane follows.
//
// ⛔ AND THE ANCHOR IS THE TOP-VISIBLE LINE, NOT THE SELECTION (Cole,
// 2026-09-22). Whatever sits at the top of the pane you leave sits at the top
// of the pane you arrive in. One rule, and it holds whether or not anything is
// selected — the same "simpler UX model" reasoning he gave the day before for
// dismissing the chip clearing the selection itself.
//
// ⚠ CLOSE, NOT EXACT — and this file is where "close" is defined. A rendered
// document and its source have no common measure: a fenced block is twenty
// source lines and one rendered box, a wrapped paragraph is one source line and
// four rendered ones. So the rendered pane is described by ANCHORS — the source
// line each rendered block begins on, and where that block sits in the
// scroller — and anything between two anchors is placed by interpolating
// between them. That makes the mapping monotone and invertible, so a round trip
// through it does not drift, and puts the error at "somewhere inside the right
// block" rather than "the right pixel". A block is the unit a human looks for
// when they switch views, so that is the bar Cole set and the bar this meets.
// MEASURED on `grimoire/house-style.md` (668 lines) at 24 scroll positions: the
// pane that follows lands within ONE source line of the pane that led.
//
// DOM-free on purpose: the node walking and the rects are `renderedRange.ts`'s,
// the same split E51 already draws.
import { lineAt, type Projection, toSource } from "./projection";

/** Where one rendered block begins: the source line, and its top in the scroller. */
export type Anchor = { line: number; top: number };

/**
 * The source line a rendered offset came from.
 *
 * A single character is asked for rather than a span, because `toSource` widens
 * a non-exact run (an inline code span) to the whole run — harmless for a line
 * number, and it means an anchor inside `` `code` `` still names the line the
 * code is on.
 */
export function sourceLine(p: Projection, text: string, plainAt: number): number {
  return lineAt(text, toSource(p, plainAt, plainAt + 1).from);
}

/** The anchor pair a line falls between, as indices, or null at either end. */
function bracket(anchors: readonly Anchor[], line: number): [Anchor, Anchor] | null {
  for (let i = 0; i < anchors.length - 1; i++) {
    const lo = anchors[i] as Anchor;
    const hi = anchors[i + 1] as Anchor;
    if (line >= lo.line && line <= hi.line) return [lo, hi];
  }
  return null;
}

/**
 * Where to scroll so source line `line` is at the top of the pane.
 *
 * Before the first anchor the answer is 0: nothing rendered came from there
 * (the frontmatter, a document's leading blank lines), so the top of the pane
 * is the honest place to be.
 */
export function topForLine(anchors: readonly Anchor[], line: number): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (!first || !last) return 0;
  if (line <= first.line) return 0;
  if (line >= last.line) return last.top;
  const pair = bracket(anchors, line);
  if (!pair) return last.top;
  const [lo, hi] = pair;
  const span = hi.line - lo.line;
  if (span <= 0) return lo.top;
  return lo.top + ((hi.top - lo.top) * (line - lo.line)) / span;
}

/** Which source line is at the top of a pane scrolled to `top`. */
export function lineAtTop(anchors: readonly Anchor[], top: number): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (!first || !last) return 1;
  if (top <= first.top) return first.line;
  if (top >= last.top) return last.line;
  for (let i = 0; i < anchors.length - 1; i++) {
    const lo = anchors[i] as Anchor;
    const hi = anchors[i + 1] as Anchor;
    if (top < lo.top || top > hi.top) continue;
    const span = hi.top - lo.top;
    if (span <= 0) return lo.line;
    return Math.round(lo.line + ((hi.line - lo.line) * (top - lo.top)) / span);
  }
  return last.line;
}

/**
 * How long a programmatic scroll is given to settle before the pane it moved is
 * believed again. A scroll event is asynchronous and a smooth one arrives in
 * pieces, so the guard cannot be lifted on the next tick; this is long enough
 * for an instant scroll's events to have landed and short enough that a human
 * who grabs the other pane immediately afterwards is not ignored.
 */
export const SETTLE_MS = 150;

/**
 * The shared place — one per open document.
 *
 * ⛔ THE GUARD LIVES HERE, NOT IN THE PANES, because forgetting it is the
 * classic split-view failure: pane A's scroll drives pane B, B's scroll handler
 * reports back, A moves again, and the two ratchet down the document. A caller
 * that has to remember to suppress its own handler is a caller that will
 * forget, so `follow` is only ever invoked from inside a drive, and a report
 * from a pane that is being driven is dropped.
 */
export type Place = {
  /** The source line last reported at the top of a pane. */
  line(): number;
  /** A pane saying where its top now is. Ignored while that pane is being driven. */
  report(pane: string, line: number): void;
  /** Scroll `pane` programmatically: its own reports are dropped until settled. */
  driven(pane: string, run: () => void): void;
  /** Be moved when another pane reports. Returns the unsubscribe. */
  follow(pane: string, fn: (line: number) => void): () => void;
};

export function createPlace(
  opts: {
    line?: number;
    /** Injected so the guard can be hand-run in a test. */
    schedule?: (fn: () => void, ms: number) => void;
    settleMs?: number;
  } = {},
): Place {
  const schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const settleMs = opts.settleMs ?? SETTLE_MS;
  let current = opts.line ?? 1;
  const driving = new Set<string>();
  const followers = new Map<string, (line: number) => void>();

  const driven = (pane: string, run: () => void) => {
    driving.add(pane);
    try {
      run();
    } finally {
      schedule(() => driving.delete(pane), settleMs);
    }
  };

  return {
    line: () => current,
    driven,
    report(pane, line) {
      if (driving.has(pane) || line === current) return;
      current = line;
      for (const [id, fn] of followers) if (id !== pane) driven(id, () => fn(line));
    },
    follow(pane, fn) {
      followers.set(pane, fn);
      return () => {
        if (followers.get(pane) === fn) followers.delete(pane);
      };
    },
  };
}
