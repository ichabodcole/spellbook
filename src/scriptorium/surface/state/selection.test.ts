// The selection the chat's chip mirrors, and what the rendered pane does with a
// `selectionchange` (Cole, 2026-09-20: "the context chip should mirror what is
// actually selected").
import { describe, expect, test } from "bun:test";
import {
  contextPressAfter,
  type HeldSelection,
  heldAfter,
  renderedSelectionAct,
} from "./selection";

const A: HeldSelection = { from: 10, to: 20, fromLine: 2, toLine: 2, text: "0123456789" };
const B: HeldSelection = { from: 30, to: 35, fromLine: 4, toLine: 4, text: "abcde" };

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

describe("renderedSelectionAct — one selectionchange in the rendered pane", () => {
  const base = { ours: true, collapsed: false, resolved: { from: 1, to: 5 }, contextClick: false };

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
