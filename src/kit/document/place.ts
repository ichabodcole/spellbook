// Keeping your place. A reader flips between raw and rendered constantly (rendered
// to read, raw to select and edit), and a flip that lands at the top of the
// document loses the passage they were on.
//
// The shared currency is the SOURCE LINE at the top of a pane: the one coordinate
// both views can name. The raw view has it from CodeMirror, the rendered view
// derives it through the projection, and neither knows anything about the other's
// geometry. A pane reports where it is, and any other pane in the place follows.
//
// CLOSE, NOT EXACT. A rendered document and its source have no common measure: a
// fenced block is twenty source lines and one rendered box, a wrapped paragraph is
// one source line and four rendered ones. So the rendered pane is described by
// anchors (the source line each rendered block begins on, and where that block
// sits in the scroller) and anything between two anchors is interpolated. That
// makes the mapping monotone and invertible, so a round trip does not drift, and
// puts the error at "somewhere inside the right block", which is what a reader
// looks for when they switch views.
//
// DOM-free on purpose: the node walking and the rects are `renderedRange.ts`'s.
import { lineAt, type Projection, toSource } from "./projection";

/** Where one rendered block begins: the source line, and its top in the scroller. */
export type Anchor = { line: number; top: number };

/**
 * The source line a rendered offset came from. A single character is asked for
 * rather than a span, because `toSource` widens a non-exact run (an inline code
 * span) to the whole run, which still names the line the code is on.
 */
export function sourceLine(p: Projection, text: string, plainAt: number): number {
  return lineAt(text, toSource(p, plainAt, plainAt + 1).from);
}

/** The anchor pair a line falls between, or null at either end. */
function bracket(anchors: readonly Anchor[], line: number): [Anchor, Anchor] | null {
  for (let i = 0; i < anchors.length - 1; i++) {
    const lo = anchors[i] as Anchor;
    const hi = anchors[i + 1] as Anchor;
    if (line >= lo.line && line <= hi.line) return [lo, hi];
  }
  return null;
}

/**
 * Where to scroll so source line `line` is at the top of the pane. Before the first
 * anchor the answer is 0: nothing rendered came from there (a document's leading
 * blank lines), so the top of the pane is the honest place to be.
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
 * What the place needs a pane to be able to do. It assumes `to` scrolls
 * instantly: the guard below is one-shot because an instant scroll produces
 * exactly one scroll event. A scroller with smooth scrolling emits a stream of
 * them, and the first would spend the arm while every later one read as the human
 * moving the pane.
 */
export type Pane = {
  /** Scroll so source line N is at the top of this pane. */
  to(line: number): void;
  /** Where this pane is scrolled to now: the number its own scroll events carry. */
  at(): number;
};

/**
 * The shared place: one per open document. The guard lives here, not in the
 * panes, because forgetting it is the classic two-pane failure: pane A's scroll
 * drives pane B, B's handler reports back, A moves again, and the two ratchet down
 * the document. A pane takes part only through `join`, and `join` arms the guard.
 *
 * The guard is an event, not a duration. A programmatic scroll produces exactly
 * one scroll event, so the arm is one-shot: the first report after a drive is that
 * drive, and every later one is the human's. Nothing is suppressed for any length
 * of time, so nothing can be lost inside a window. A scroll event is dispatched
 * before the frame's animation callbacks, so a drive's own event always reaches
 * `report` before `afterFrame` could disarm it.
 *
 * Known hole: a human scroll coalesced with a drive's own event in the same frame
 * is told apart by where the drive left the pane (`left`), and a coalesced scroll
 * that lands exactly there is indistinguishable from the drive.
 */
export type Place = {
  /** The source line last reported at the top of a pane. */
  line(): number;
  /** A pane saying which source line is at its top now. */
  report(pane: string, line: number): void;
  /** Take part: the pane is put where the place already is, and follows it from now on. Returns the leave. */
  join(pane: string, controls: Pane): () => void;
};

export function createPlace(
  opts: {
    line?: number;
    /** Injected so the one-frame disarm can be hand-run in a test. */
    afterFrame?: (fn: () => void) => void;
  } = {},
): Place {
  const afterFrame = opts.afterFrame ?? ((fn) => void requestAnimationFrame(fn));
  let current = opts.line ?? 1;
  const panes = new Map<string, Pane>();
  /** Panes whose next report will be the scroll this place just asked them for. */
  const armed = new Set<string>();
  /** Where each drive left its pane, once it had settled. */
  const left = new Map<string, number>();

  const drive = (id: string) => {
    const pane = panes.get(id);
    if (!pane) return;
    const before = pane.at();
    armed.add(id);
    left.delete(id);
    pane.to(current);
    afterFrame(() => {
      if (!armed.has(id)) return;
      const now = pane.at();
      // A drive that achieved nothing has no event coming, so the arm is spent
      // here or it would eat the human's next scroll. A frame later the pane has
      // settled, so an unchanged position is the test: the follower was already
      // where it was asked to go, or the human yanked it back to where it started.
      if (now === before) armed.delete(id);
      else left.set(id, now);
    });
  };

  return {
    line: () => current,
    report(id, line) {
      if (armed.delete(id)) {
        const pane = panes.get(id);
        const where = left.get(id);
        left.delete(id);
        // Unless the pane is not where the drive left it: a human scroll in the
        // same frame is coalesced into one event carrying their position. Where
        // the drive left the pane is known by then, so the two cases are told
        // apart exactly. Otherwise this is the drive arriving: not news, and it
        // is the only thing that stops the panes chasing each other.
        if (!pane || where === undefined || pane.at() === where) return;
      }
      if (line === current) return;
      current = line;
      for (const other of panes.keys()) if (other !== id) drive(other);
    },
    join(id, controls) {
      panes.set(id, controls);
      // Arriving from the other view: land where the place already is. Same path
      // as a follow, so the same arm covers it.
      drive(id);
      return () => {
        if (panes.get(id) !== controls) return;
        panes.delete(id);
        armed.delete(id);
      };
    },
  };
}

/**
 * The rendered pane's anchor table, measured once and kept until it is stale.
 * Measuring walks every element and reads a rect from each, which forces layout,
 * so the table is cached, cleared by whoever sees the rendering move (the pane's
 * ResizeObserver, a new html), and re-measured whenever the width differs from the
 * one it was measured at: a column collapsing widens the pane in one layout and
 * the scroll event it causes arrives before the observer's callback.
 */
export function anchorCache(
  measure: () => Anchor[],
  width: () => number,
): { get(): Anchor[]; clear(): void } {
  let anchors: Anchor[] | null = null;
  let measuredAt = -1;
  return {
    get() {
      const w = width();
      if (!anchors || w !== measuredAt) {
        anchors = measure();
        measuredAt = w;
      }
      return anchors;
    },
    clear() {
      anchors = null;
    },
  };
}
