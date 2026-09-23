// E63: keeping your place — the source line at the top of a pane, and what it
// takes to put another pane at the same line without the two chasing each other.
import { describe, expect, test } from "bun:test";
import { anchorCache, createPlace, lineAtTop, type Place, sourceLine, topForLine } from "./place";
import { project } from "./projection";

/**
 * A document with frontmatter, a fenced block and a list — the shapes the
 * anchors have to survive. ⚠ The assertions below ask THE SOURCE what is on
 * the line they were given (`src.split("\n")[line - 1]`) rather than counting
 * newlines a second time; re-deriving the expectation with the code's own
 * arithmetic is the defect branch 1 hit twice.
 */
const DOC = `---
title: A test
---

# The heading

A paragraph of prose that sits under the heading.

\`\`\`ts
const x = 1;
\`\`\`

- **Boundary check:** the theme organises and must never derive.
- A second item.

> A quoted line.
`;

describe("sourceLine", () => {
  const p = project(DOC);
  const at = (needle: string) => p.plain.indexOf(needle);

  test("a rendered offset names the source line that text is written on", () => {
    const lines = DOC.split("\n");
    for (const needle of ["The heading", "A paragraph", "Boundary check", "quoted"]) {
      const line = sourceLine(p, DOC, at(needle));
      expect(lines[line - 1]).toContain(needle);
    }
  });

  // A fenced block renders as ONE run whose source span is the whole fence, so
  // it is not `exact` and every offset inside it resolves to the fence's own
  // start (E51). That is the honest answer — there is no per-line mapping to
  // be had — and it is what an anchor wants anyway: the block begins there.
  test("an offset inside a fenced block names the line the fence opens on", () => {
    const line = sourceLine(p, DOC, at("const x = 1;"));
    expect(DOC.split("\n")[line - 1]).toBe("```ts");
  });

  test("the frontmatter is not rendered, so no offset points into it", () => {
    expect(sourceLine(p, DOC, 0)).toBeGreaterThan(3);
  });
});

describe("topForLine / lineAtTop", () => {
  /** Ten source lines to a hundred pixels — chosen so the midpoints are round. */
  const anchors = [
    { line: 1, top: 0 },
    { line: 11, top: 100 },
    { line: 21, top: 300 },
  ];

  test("an anchor's own line scrolls to that anchor's top", () => {
    expect(topForLine(anchors, 1)).toBe(0);
    expect(topForLine(anchors, 11)).toBe(100);
    expect(topForLine(anchors, 21)).toBe(300);
  });

  test("a line between two anchors lands proportionally between them", () => {
    expect(topForLine(anchors, 6)).toBe(50);
    expect(topForLine(anchors, 16)).toBe(200);
  });

  // The rendered pane's first block does NOT start at 0 — the metadata header
  // sits above it — and the frontmatter those first source lines belong to is
  // not rendered at all. Landing on the first block's own top would scroll the
  // header out of sight for a document you had not scrolled.
  test("a line at or before the first rendered block goes to the very top of the pane", () => {
    const belowAHeader = [
      { line: 12, top: 180 },
      { line: 20, top: 400 },
    ];
    expect(topForLine(belowAHeader, 1)).toBe(0);
    expect(topForLine(belowAHeader, 12)).toBe(0);
    expect(lineAtTop(belowAHeader, 0)).toBe(12);
  });

  test("a line outside the anchors clamps to the ends", () => {
    expect(topForLine(anchors, 0)).toBe(0);
    expect(topForLine(anchors, 99)).toBe(300);
  });

  test("a scroll position reads back as the line that put it there", () => {
    for (const a of anchors) expect(lineAtTop(anchors, topForLine(anchors, a.line))).toBe(a.line);
    expect(lineAtTop(anchors, 50)).toBe(6);
    expect(lineAtTop(anchors, 200)).toBe(16);
  });

  // ⚠ THE ROUNDING DIRECTION, which nothing exercised while every cell landed
  // on a whole line: `Math.round` → `Math.floor` survived mutation. Halfway
  // between two source lines, the line whose text is actually at the top edge
  // is the NEARER one, so a scroll 45% of the way from line 1 to line 11 reads
  // as 6 and not as 5.
  test("a position between two source lines reads as the nearer one", () => {
    expect(lineAtTop(anchors, 45)).toBe(6);
    expect(lineAtTop(anchors, 55)).toBe(7);
    expect(lineAtTop(anchors, 44)).toBe(5);
  });

  test("a scroll position outside the anchors clamps to the end lines", () => {
    expect(lineAtTop(anchors, -40)).toBe(1);
    expect(lineAtTop(anchors, 9999)).toBe(21);
  });

  test("a line with no anchor of its own — inside a fence — still lands between its neighbours", () => {
    const top = topForLine(anchors, 14);
    expect(top).toBeGreaterThan(100);
    expect(top).toBeLessThan(300);
  });

  test("a document with nothing measurable answers the top and the first line", () => {
    expect(topForLine([], 40)).toBe(0);
    expect(lineAtTop([], 400)).toBe(1);
  });

  test("a document shorter than the pane has one anchor and never scrolls", () => {
    const one = [{ line: 5, top: 0 }];
    expect(topForLine(one, 1)).toBe(0);
    expect(topForLine(one, 900)).toBe(0);
    expect(lineAtTop(one, 0)).toBe(5);
  });
});

describe("createPlace", () => {
  /**
   * A pane as the store sees one, plus the browser's half of the contract: a
   * scroll changes the position and then sends ONE scroll event, in a later
   * frame. `flush` is the browser delivering it; `frame` is the rendering
   * update's animation callbacks, which run AFTER any scroll event.
   */
  function fakePane(place: () => Place, id: string, map: (line: number) => number) {
    const pane = {
      at: () => pane.position,
      to: (line: number) => {
        const next = map(line);
        if (next === pane.position) return;
        pane.position = next;
        pane.queued = true;
      },
      position: 0,
      queued: false,
      /** The line this pane would report from where it is now. */
      read: () => Math.round(pane.position / 10) + 1,
      /** Deliver the pending scroll event, if the browser has one. */
      flush() {
        if (!pane.queued) return;
        pane.queued = false;
        place().report(id, pane.read());
      },
      /**
       * The human scrolls before the browser has delivered our own scroll's
       * event: the two COALESCE into one event carrying the human's position.
       */
      coalesce(position: number) {
        pane.position = position;
        pane.queued = false;
        place().report(id, pane.read());
      },
      /**
       * The human moves the pane while our own scroll's event is still pending,
       * so the one event the browser finally sends carries THEIR position.
       */
      yank(position: number) {
        pane.position = position;
        pane.queued = true;
      },
      /** The human scrolls this pane: position changes, event follows. */
      human(position: number) {
        pane.position = position;
        place().report(id, pane.read());
      },
    };
    return pane;
  }

  /** The deferred one-frame disarms, run by hand. */
  function clock() {
    const queued: (() => void)[] = [];
    return {
      afterFrame: (fn: () => void) => {
        queued.push(fn);
      },
      frame: () => {
        for (const fn of queued.splice(0)) fn();
      },
    };
  }

  /** Two panes, ten pixels to the line, joined to one place. */
  function pair(line = 1) {
    const c = clock();
    let place: Place;
    const get = () => place;
    const raw = fakePane(get, "raw", (n) => (n - 1) * 10);
    const rendered = fakePane(get, "rendered", (n) => (n - 1) * 10);
    place = createPlace({ line, afterFrame: c.afterFrame });
    place.join("raw", raw);
    place.join("rendered", rendered);
    raw.flush();
    rendered.flush();
    c.frame();
    return { place, raw, rendered, frame: c.frame };
  }

  test("a pane's scroll moves the other one to the same line", () => {
    const { place, raw, rendered, frame } = pair();
    raw.human(400);
    expect(place.line()).toBe(41);
    expect(rendered.position).toBe(400);
    rendered.flush();
    frame();
    expect(place.line()).toBe(41);
  });

  test("⛔ the follower does not report back — the panes cannot chase each other", () => {
    // The follower's own scroll event is the drive arriving. If it were news,
    // each pane's read-back would move the other and the two would ratchet.
    const { place, raw, rendered, frame } = pair();
    const moved: number[] = [];
    raw.human(400);
    // The follower reads back one line late, as a real mapping does.
    rendered.position = 406;
    rendered.flush();
    frame();
    expect(place.line()).toBe(41);
    expect(raw.position).toBe(400);
    expect(moved).toEqual([]);
  });

  /**
   * ⛔ THE INVARIANT, and the defect that made it a cell: a real scroll of the
   * pane that was JUST driven used to be discarded by the settle window, with
   * nothing to catch it up — measured in the browser at fifty lines apart, and
   * still fifty lines apart four seconds later. Settled means agreed.
   */
  test("a human scroll of the pane that was just driven is heard, and the panes agree", () => {
    const { place, raw, rendered, frame } = pair();
    raw.human(1500);
    expect(rendered.position).toBe(1500);
    // The drive's own event arrives a frame later, as the browser delivers it.
    rendered.flush();
    frame();
    // NOW the human grabs the pane that was just driven — the 60 ms case, well
    // inside any settle window anyone might have chosen.
    rendered.human(3000);
    expect(place.line()).toBe(301);
    expect(raw.position).toBe(3000);
    raw.flush();
    frame();
    expect(raw.read()).toBe(rendered.read());
    expect(place.line()).toBe(301);
  });

  /**
   * The sub-frame case: the human scrolls before the browser has delivered our
   * drive's own event, so the two arrive as ONE event carrying their position.
   * Told apart by WHERE the pane is, not by how long ago the drive was.
   */
  test("a human scroll coalesced with the drive's own event is still heard", () => {
    const { place, raw, rendered, frame } = pair();
    raw.human(1500);
    // The drive's frame first: this is CODEMIRROR's ordering, where the scroll
    // lands a frame late and its event follows in the frame after that.
    frame();
    rendered.coalesce(3000);
    expect(place.line()).toBe(301);
    expect(raw.position).toBe(3000);
  });

  /**
   * ⚠ A KNOWN HOLE, PINNED RATHER THAN FIXED — see
   * `docs/backlog/2026-09-22-scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md`.
   *
   * The cell above is CodeMirror's ordering. The RENDERED pane has the other
   * one: its `to` sets `scrollTop` synchronously, so its scroll event can be
   * dispatched BEFORE the drive's `afterFrame` has run. `left` is then still
   * undefined, `report` has nothing to compare the pane's position against, and
   * it takes the conservative branch and swallows — including when the event
   * carries a HUMAN scroll coalesced with ours. The panes are left disagreeing.
   *
   * ⛔ THIS ASSERTS WHAT THE CODE DOES TODAY, NOT WHAT IT SHOULD DO. It is here
   * so that a later change to the guard cannot move this behaviour silently: if
   * this cell starts failing, the hole has been closed (or widened) and the
   * backlog item wants updating either way. Cole ruled it filed rather than
   * fixed, on the measurements in that item — reaching it needs a synthetic
   * injection, real alternating wheel input could not provoke worse than three
   * lines, and it self-heals completely on the next scroll tick, which the
   * second half of this cell is.
   */
  test("PINNED 1/2: the event beats `afterFrame`, so there is nothing to compare against", () => {
    const { place, raw, rendered, frame } = pair();
    raw.human(1500);
    // No frame() — the event beats `afterFrame`, which is the rendered pane's
    // ordering, and `left` is still undefined when the report arrives.
    rendered.coalesce(3000);
    expect(place.line()).toBe(151);
    expect(raw.position).toBe(1500);
    expect(rendered.position).toBe(3000);

    // And the next tick puts it right: the arm is spent, so the following
    // report is heard and both panes agree again. ⚠ A REAL SCROLL TO A NEW
    // PLACE, because a browser sends no event for a scroll that moves nothing
    // — asking the fake to report from where it already sits would be a
    // gesture the thing being modelled cannot make.
    frame();
    rendered.human(3200);
    expect(place.line()).toBe(321);
    expect(raw.position).toBe(3200);
    expect(raw.read()).toBe(rendered.read());
  });

  /**
   * ⚠ THE SECOND HALF OF THE SAME HOLE, and the one that falsified the first
   * telling of it. `left` is recorded a frame AFTER the drive, so a human
   * scroll landing in the window BETWEEN the drive and `afterFrame` is folded
   * into `left` itself: the comparison then asks "is the pane where the drive
   * left it", is told yes, and swallows the human's scroll. This needs no
   * special ordering — the event here arrives after `afterFrame`, which is
   * CodeMirror's — so the hole is in BOTH panes, not only the rendered one.
   *
   * ⛔ ASSERTS WHAT THE CODE DOES TODAY, like its neighbour, and for the same
   * reason: see
   * `docs/backlog/2026-09-22-scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md`.
   * The "yanked back to where it started" cell above is the special case of
   * this one where the yank lands exactly on `before`, which is why the
   * one-frame disarm rescues that one and not this.
   */
  test("PINNED 2/2: a scroll inside the drive→afterFrame window is folded into `left`", () => {
    const { place, raw, rendered, frame } = pair();
    raw.human(1500);
    // The human grabs the follower before the frame that records where the
    // drive left it, and to somewhere it was NOT before (0) — so the disarm
    // cannot spend the arm and the comparison absorbs their position instead.
    rendered.yank(700);
    frame();
    rendered.flush();
    expect(place.line()).toBe(151);
    expect(raw.position).toBe(1500);
    expect(rendered.position).toBe(700);

    // Self-heals on the next tick, exactly as its neighbour does.
    rendered.human(900);
    expect(place.line()).toBe(91);
    expect(raw.position).toBe(900);
    expect(raw.read()).toBe(rendered.read());
  });

  test("a burst of scrolls down one pane leaves both at the same line", () => {
    const { place, raw, rendered, frame } = pair();
    for (let px = 100; px <= 2000; px += 100) {
      raw.human(px);
      rendered.flush();
      frame();
    }
    expect(place.line()).toBe(201);
    expect(rendered.read()).toBe(raw.read());
  });

  test("scrolls alternating between the two panes still settle agreed", () => {
    const { place, raw, rendered, frame } = pair();
    const panes = [raw, rendered];
    for (let i = 0; i < 12; i++) {
      const lead = panes[i % 2] as typeof raw;
      const follow = panes[(i + 1) % 2] as typeof raw;
      lead.human(500 + i * 130);
      follow.flush();
      frame();
    }
    expect(raw.read()).toBe(rendered.read());
    expect(place.line()).toBe(raw.read());
  });

  /**
   * ⛔ A DRIVE THAT MOVED NOTHING SENDS NO EVENT. Without the one-frame disarm
   * the arm would sit there and eat the human's next scroll instead — the same
   * defect as the settle window, just waiting longer for its victim.
   */
  test("a drive that moves nothing does not eat the next real scroll", () => {
    const { place, raw, rendered, frame } = pair();
    raw.human(400);
    rendered.flush();
    frame();
    // Both are already at line 41; reporting it again drives nothing.
    raw.human(400);
    frame();
    rendered.human(900);
    expect(place.line()).toBe(91);
    expect(raw.position).toBe(900);
  });

  /**
   * ⛔ THE BOTTOM CLAMP, which is where a drive really does move nothing: the
   * follower is already at its maximum scroll and cannot go further, so the
   * browser sends no scroll event and the arm would sit there — and then eat
   * the human's next scroll of that pane. The one-frame disarm is what spends
   * it. (Without it every cell above still passes; this is the one that
   * convicts.)
   */
  test("a drive the follower cannot honour does not eat its next real scroll", () => {
    const c = clock();
    let place: Place;
    const get = () => place;
    const raw = fakePane(get, "raw", (n) => (n - 1) * 10);
    // A shorter pane: it runs out at 500px however far down the place goes.
    const rendered = fakePane(get, "rendered", (n) => Math.min((n - 1) * 10, 500));
    place = createPlace({ afterFrame: c.afterFrame });
    place.join("raw", raw);
    place.join("rendered", rendered);
    raw.flush();
    rendered.flush();
    c.frame();

    raw.human(5000);
    rendered.flush();
    c.frame();
    expect(rendered.position).toBe(500);
    // Further still: the follower is pinned, so its `to` moves nothing at all.
    raw.human(6000);
    expect(rendered.position).toBe(500);
    c.frame();
    // The human now grabs the pinned pane. This must be heard.
    rendered.human(200);
    expect(place.line()).toBe(21);
    expect(raw.position).toBe(200);
  });

  /**
   * ⛔ AND THE PANE MAY BE YANKED BACK TO WHERE IT STARTED. Then the drive and
   * the human cancel out in POSITION — the pane is where the drive found it —
   * so "is it where the drive left it" cannot tell them apart. What can is that
   * the drive achieved nothing: a frame later the pane has not moved, so no
   * event of ours is coming and the arm is spent. Without that the human's yank
   * is swallowed and the two panes are left disagreeing.
   */
  test("the follower yanked back to where it started is still heard", () => {
    const { place, raw, rendered, frame } = pair();
    raw.human(400);
    expect(rendered.position).toBe(400);
    rendered.yank(0);
    frame();
    rendered.flush();
    expect(place.line()).toBe(1);
    expect(raw.position).toBe(0);
  });

  test("joining puts the pane where the place already is", () => {
    const c = clock();
    let place: Place;
    const late = fakePane(
      () => place,
      "rendered",
      (n) => (n - 1) * 10,
    );
    place = createPlace({ line: 120, afterFrame: c.afterFrame });
    place.join("rendered", late);
    expect(late.position).toBe(1190);
    late.flush();
    c.frame();
    expect(place.line()).toBe(120);
  });

  test("a pane that has left is neither driven nor heard", () => {
    const { place, raw, rendered, frame } = pair();
    const leave = place.join("rendered", rendered);
    rendered.flush();
    frame();
    leave();
    raw.human(400);
    expect(rendered.position).toBe(0);
    expect(place.line()).toBe(41);
  });

  test("the same line twice is not news", () => {
    const { raw, rendered, frame } = pair();
    raw.human(400);
    rendered.flush();
    frame();
    const was = rendered.position;
    raw.human(404);
    expect(rendered.position).toBe(was);
  });
});

describe("anchorCache — the rendered pane's anchors, and when they are stale (E64)", () => {
  const counting = () => {
    let measured = 0;
    let width = 600;
    const cache = anchorCache(
      () => {
        measured += 1;
        return [{ line: measured, top: 0 }];
      },
      () => width,
    );
    return {
      cache,
      measured: () => measured,
      widen: (w: number) => {
        width = w;
      },
    };
  };

  test("measured once, then served from the cache while nothing changes", () => {
    const c = counting();
    c.cache.get();
    c.cache.get();
    expect(c.measured()).toBe(1);
  });

  test("a clear (the ResizeObserver, a new rendering) forces a re-measure", () => {
    const c = counting();
    c.cache.get();
    c.cache.clear();
    c.cache.get();
    expect(c.measured()).toBe(2);
  });

  test("a DIFFERENT WIDTH re-measures even with no clear — the event that beats the observer", () => {
    // A collapse widens the pane in one layout; scroll anchoring's own scroll
    // event is dispatched before the ResizeObserver callback, so the cache is
    // asked before anyone has cleared it. The width is the evidence.
    const c = counting();
    c.cache.get();
    c.widen(997);
    expect(c.cache.get()).toEqual([{ line: 2, top: 0 }]);
    expect(c.measured()).toBe(2);
  });
});
