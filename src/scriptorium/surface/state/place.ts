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
//
// MEASURED on `grimoire/house-style.md` (668 lines), Chromium 2026-09-22, with
// an oracle that reads both panes out of the DOM and locates the text in the
// file — no code from here on either side:
//
//   · WHEN A BLOCK BEGINS AT THE TOP EDGE — the case a human aims at — the
//     other pane's top line is that block's own line, EXACTLY: 25 of 27
//     headings. Both exceptions are the bottom clamp below.
//   · AT 42 ARBITRARY POSITIONS — mid-paragraph, mid-fence, anywhere — the two
//     are within THREE source lines (exact at 20 of 37 locatable, within one at
//     32, within two at 34). The oracle looks DOWN from the top edge for enough
//     text to locate, so it reads late by up to two rendered lines; the figure
//     is therefore an upper bound on the error, not the error.
//   · AT THE VERY BOTTOM the follower is already at its maximum scroll and
//     CANNOT put the leader's line at the top — the residue is the distance
//     from the last anchor to the last line (six lines here). That is a
//     structural floor of scrolling, not a fault in the mapping, and no
//     anchoring scheme removes it.
//
// ⚠ An earlier version of this file claimed "within one source line" on the
// strength of a 24-position sweep whose probe flattered it. It did not
// reproduce. A number in the tree that nobody can reproduce is a defect of its
// own, so the shape above — what was measured, how, and where it stops — is the
// form these claims take from here.
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

/** What the place needs a pane to be able to do. */
export type Pane = {
  /** Scroll so source line N is at the top of this pane. */
  to(line: number): void;
  /** Where this pane is scrolled to now — the number its own scroll events carry. */
  at(): number;
};

/**
 * The shared place — one per open document.
 *
 * ⛔ THE GUARD LIVES HERE, NOT IN THE PANES, because forgetting it is the
 * classic split-view failure: pane A's scroll drives pane B, B's scroll handler
 * reports back, A moves again, and the two ratchet down the document. A pane
 * can only take part through `join`, and `join` is what arms the guard.
 *
 * ⛔ AND THE GUARD IS AN EVENT, NOT A DURATION. It was a 150 ms window first,
 * and a window is a guess about WHICH scroll a report came from: a human scroll
 * that landed inside it was thrown away with nothing to catch it up — measured
 * at FIFTY LINES apart and staying there — while two windows overlapping during
 * a fast wheel let one expire under the other and left the follower stranded
 * twelve lines behind. Both are the same mistake. A programmatic scroll
 * produces exactly ONE scroll event, so the arm is one-shot: the first report
 * after a drive is that drive, and every later one is the human's. Nothing is
 * suppressed for any length of time, so nothing can be lost inside a window.
 *
 * ⚠ THE ONE ORDERING FACT THIS RESTS ON: a scroll event is dispatched in the
 * rendering update's scroll steps, which run BEFORE that frame's animation-frame
 * callbacks. So a drive's own event always reaches `report` before `afterFrame`
 * could disarm it. (Measured for CodeMirror, whose `scrollIntoView` is applied
 * a frame late: immediately after the dispatch `scrollTop` is unchanged, and by
 * the next frame it has landed.)
 */
export type Place = {
  /** The source line last reported at the top of a pane. */
  line(): number;
  /** A pane saying which source line is at its top now. */
  report(pane: string, line: number): void;
  /**
   * Take part: the pane is put where the place already is, and follows it from
   * now on. Returns the leave.
   */
  join(pane: string, controls: Pane): () => void;
};

export function createPlace(
  opts: {
    line?: number;
    /** Injected so the one-frame disarm can be hand-run in a cell. */
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
      // ⛔ A DRIVE THAT ACHIEVED NOTHING HAS NO EVENT COMING, so the arm has to
      // be spent here or it eats the human's next scroll instead. A frame later
      // the pane has settled (CodeMirror's scroll lands then), so an unchanged
      // position is the test. Two ways to get one: the follower was already
      // where it was asked to go (the bottom clamp), or the human yanked it
      // back to where it started while our event was still pending — and that
      // second one is why this cannot be left to the `left` comparison below,
      // which by then sees the pane exactly where the drive found it.
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
        // ⛔ UNLESS THE PANE IS NOT WHERE THE DRIVE LEFT IT. A human scroll in
        // the same frame as ours is COALESCED into one event carrying their
        // position, and swallowing that is the fifty-line defect in miniature.
        // Where the drive left the pane is known by then (it is recorded a
        // frame after the drive, and a scroll event is dispatched a frame
        // later still), so the two cases are told apart exactly rather than by
        // a tolerance. Otherwise this is the drive we asked for arriving: not
        // news, and above all not a reason to move anybody — it is the only
        // thing that stops the panes chasing each other, and it means a
        // FOLLOWER never reports at all.
        if (!pane || where === undefined || pane.at() === where) return;
      }
      if (line === current) return;
      current = line;
      for (const other of panes.keys()) if (other !== id) drive(other);
    },
    join(id, controls) {
      panes.set(id, controls);
      // Arriving from the other view, or mounting beside it: land where the
      // place already is. Same path as a follow, so the same arm covers it.
      drive(id);
      return () => {
        if (panes.get(id) !== controls) return;
        panes.delete(id);
        armed.delete(id);
      };
    },
  };
}
