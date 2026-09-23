// The selection the chat's chip mirrors, and what the rendered pane does with a
// `selectionchange` (Cole, 2026-09-20: "the context chip should mirror what is
// actually selected").
import { describe, expect, test } from "bun:test";
import {
  applySelectionEvent,
  contextPressAfter,
  type HeldSelection,
  heldAfter,
  type Reveal,
  renderedSelectionAct,
  revealAfter,
} from "./selection";

const A: HeldSelection = {
  doc: "alpha",
  version: 1,
  from: 10,
  to: 20,
  fromLine: 2,
  toLine: 2,
  text: "0123456789",
};
const B: HeldSelection = {
  doc: "alpha",
  version: 1,
  from: 30,
  to: 35,
  fromLine: 4,
  toLine: 4,
  text: "abcde",
};

describe("heldAfter — what the surface (and so the daemon) holds", () => {
  test("a report replaces what was held", () => {
    expect(heldAfter(A, { type: "report", selection: B })).toEqual(B);
  });

  test("an empty report is a clear", () => {
    expect(heldAfter(A, { type: "report", selection: { ...B, to: B.from } })).toBeNull();
  });

  test("the same range again is the SAME value, so nothing re-renders or re-sends", () => {
    expect(heldAfter(A, { type: "report", selection: { ...A } })).toBe(A);
  });

  test("the chip's X drops the selection itself, not just the chip", () => {
    // `say` attaches what the DAEMON holds, so dropping has to clear the held
    // selection — which the daemon is told about — rather than hide the chip.
    expect(heldAfter(A, { type: "drop" })).toBeNull();
  });

  test("after the X, the next selection attaches — even the same passage again", () => {
    const dropped = heldAfter(A, { type: "drop" });
    expect(heldAfter(dropped, { type: "report", selection: B })).toEqual(B);
    expect(heldAfter(dropped, { type: "report", selection: { ...A } })).toEqual(A);
  });
});

describe("applySelectionEvent — what the panes are told to unpaint", () => {
  // Cole, 2026-09-22: "clicking in either clears the selection, it's the
  // simpler ux pattern". A click in the RENDERED half clears a selection the
  // RAW half is holding — and CodeMirror only reports on a selection change of
  // its own, so without this it kept its range and its blurred grey highlight.
  test("a clear reaches both panes' paint, wherever the click was", () => {
    expect(applySelectionEvent(A, { type: "report", selection: { ...B, to: B.from } })).toEqual({
      held: null,
      clearPaint: true,
    });
  });

  test("so does the chip's X", () => {
    expect(applySelectionEvent(A, { type: "drop" })).toEqual({ held: null, clearPaint: true });
  });

  test("a selection REPLACING another paints nothing away", () => {
    expect(applySelectionEvent(A, { type: "report", selection: B })).toEqual({
      held: B,
      clearPaint: false,
    });
  });

  test("⛔ a clear when nothing is held does NOT echo", () => {
    // The pane told to unpaint collapses its own selection, which it reports as
    // an empty range. That second clear must not send the panes round again.
    expect(applySelectionEvent(null, { type: "report", selection: { ...B, to: B.from } })).toEqual({
      held: null,
      clearPaint: false,
    });
  });

  test("the same selection again is no news at all", () => {
    const again = applySelectionEvent(A, { type: "report", selection: { ...A } });
    expect(again.held).toBe(A);
    expect(again.clearPaint).toBe(false);
  });
});

describe("E66 — the open document changing is a clear", () => {
  // The reviewer's repro: select in alpha, click beta in the context list, and
  // the chip read `beta.md · v1 · line 2` over alpha's words — and so did the
  // daemon, so a `say` would have sent alpha's text attributed to beta.
  test("⛔ another document shown: the selection goes, and so does its paint", () => {
    expect(applySelectionEvent(A, { type: "shown", doc: "beta", version: 1 })).toEqual({
      held: null,
      clearPaint: true,
    });
  });

  test("another version of the same document shown: the same clear", () => {
    expect(applySelectionEvent(A, { type: "shown", doc: "alpha", version: 2 })).toEqual({
      held: null,
      clearPaint: true,
    });
  });

  test("no document shown at all: the same clear", () => {
    expect(applySelectionEvent(A, { type: "shown", doc: null, version: null })).toEqual({
      held: null,
      clearPaint: true,
    });
  });

  test("the document it was made in, still shown: no news", () => {
    const same = applySelectionEvent(A, { type: "shown", doc: "alpha", version: 1 });
    expect(same.held).toBe(A);
    expect(same.clearPaint).toBe(false);
  });

  test("nothing held: nothing to unpaint", () => {
    expect(applySelectionEvent(null, { type: "shown", doc: "beta", version: 1 })).toEqual({
      held: null,
      clearPaint: false,
    });
  });

  test("the same range in ANOTHER document is a new selection, not the one held", () => {
    const onBeta = { ...A, doc: "beta" };
    expect(heldAfter(A, { type: "report", selection: onBeta })).toBe(onBeta);
  });
});

describe("E66 — a reveal is one shot, for the text it was aimed at", () => {
  // The verifier's repro: a search jump into gamma left `reveal` standing; open
  // long.md, switch to Raw, and the editor re-created itself, applied gamma's
  // offsets to long.md, and the chip read `long.md · v1 · line 3 / "h fill"`.
  const R: Reveal = { doc: "gamma", version: 1, from: 40, to: 46, seq: 7 };

  test("⛔ another document shown: the reveal goes", () => {
    expect(revealAfter(R, { type: "shown", doc: "long", version: 1 })).toBeNull();
  });

  test("another version of the same document shown: the reveal goes", () => {
    expect(revealAfter(R, { type: "shown", doc: "gamma", version: 2 })).toBeNull();
  });

  test("the text it was aimed at, still shown: it waits, unchanged", () => {
    expect(revealAfter(R, { type: "shown", doc: "gamma", version: 1 })).toBe(R);
  });

  test("⛔ once applied it is spent, so a re-created editor cannot replay it", () => {
    expect(revealAfter(R, { type: "applied", seq: 7 })).toBeNull();
  });

  test("applying an OLDER reveal does not spend a newer one", () => {
    expect(revealAfter(R, { type: "applied", seq: 6 })).toBe(R);
  });

  test("⛔ the held selection changing — the chip's X, a click, a new passage — ends it", () => {
    // The same-document variant: X, then a view switch, brought the passage
    // back. A reveal is a request about what to select NOW, and the human has
    // since said something else.
    expect(revealAfter(R, { type: "selection" })).toBeNull();
  });
});

describe("renderedSelectionAct — one selectionchange in the rendered pane", () => {
  const base = {
    ours: true,
    collapsed: false,
    gone: false,
    resolved: { from: 1, to: 5 },
    contextClick: false,
    pressedHere: true,
  };

  test("a selection in this pane that resolves is reported", () => {
    expect(renderedSelectionAct(base)).toBe("report");
  });

  test("a selection somewhere else is not this pane's to report or clear", () => {
    expect(renderedSelectionAct({ ...base, ours: false })).toBe("ignore");
    expect(renderedSelectionAct({ ...base, ours: false, collapsed: true, resolved: null })).toBe(
      "ignore",
    );
  });

  test("a click that collapses the selection in this pane CLEARS it", () => {
    expect(renderedSelectionAct({ ...base, collapsed: true, resolved: null })).toBe("clear");
  });

  test("a right-click OVER the selection that collapses it keeps it, for the note menu", () => {
    // The browser collapses the selection on the button press that opens the
    // menu; the menu is ABOUT that selection (MarkdownView's `lastRange`).
    expect(
      renderedSelectionAct({ ...base, collapsed: true, resolved: null, contextClick: true }),
    ).toBe("keep");
  });

  test("a right-click elsewhere is an ordinary click and clears", () => {
    // `contextClick` is only true for a press INSIDE the held passage
    // (MarkdownView measures the point), so this is the same as any click.
    expect(
      renderedSelectionAct({ ...base, collapsed: true, resolved: null, contextClick: false }),
    ).toBe("clear");
  });

  test("a selection that cannot be placed says nothing rather than something wrong", () => {
    expect(renderedSelectionAct({ ...base, resolved: null })).toBe("ignore");
  });

  // ⛔ MEASURED IN CHROME, twice: a click landing INSIDE the selected text
  // EMPTIES the selection rather than collapsing it, so there is no range at
  // all. The handler gave up on `rangeCount === 0`, so no clear was ever
  // reported: the paint went and the chip stayed reading `line 262`, on a
  // passage nothing was holding — Cole's "the chip mirrors the selection" rule
  // broken in the one case nobody had tested. The two readings of the DOM are
  // the same event and must reach the same act.
  const emptied = { ...base, gone: true, collapsed: true, ours: false, resolved: null };

  test("a click inside the selection, which the browser EMPTIES, clears it", () => {
    expect(renderedSelectionAct(emptied)).toBe("clear");
  });

  test("an emptied selection reaches the same act a collapsed one does", () => {
    // ⚠ PIN THE VALUE, not just the agreement: comparing the two calls to each
    // other passes just as happily when both have regressed to "ignore", which
    // is precisely the defect this cell is here to catch.
    const collapsed = { ...base, collapsed: true, resolved: null };
    expect(renderedSelectionAct(collapsed)).toBe("clear");
    expect(renderedSelectionAct(emptied)).toBe("clear");
    expect(renderedSelectionAct(emptied)).toBe(renderedSelectionAct(collapsed));
  });

  // ⛔ AND THE PRESS IS WHAT MAKES IT OURS. Clicking into the chat composer to
  // WRITE ABOUT the passage must not clear it — that is the entire point of the
  // chip — and an emptied selection has no node to say where it went.
  test("an emptied selection with no press in this pane is not ours to clear", () => {
    expect(renderedSelectionAct({ ...emptied, pressedHere: false })).toBe("ignore");
  });

  test("a right-click over the selection still keeps it, emptied or collapsed", () => {
    expect(renderedSelectionAct({ ...emptied, contextClick: true })).toBe("keep");
  });
});

describe("contextPressAfter — how long a context press excuses a collapse", () => {
  test("a context press over the selection is live", () => {
    expect(contextPressAfter({ kind: "pointerdown", context: true })).toBe(true);
  });

  test("an ordinary press ends it", () => {
    expect(contextPressAfter({ kind: "pointerdown", context: false })).toBe(false);
  });

  test("a KEY ends it — a caret move is not a menu", () => {
    // ⛔ It used to be recomputed only on a pointer press, so after one
    // right-click every later collapse with no pointer — shift-arrow, an arrow
    // key, Escape — was read as "the menu is about to open" and the chip stayed
    // on the old passage until the next ordinary click.
    expect(contextPressAfter({ kind: "keydown" })).toBe(false);
  });
});
