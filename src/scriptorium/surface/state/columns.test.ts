// E64: the side columns get out of the way — what counts as collapsed, the width
// a column reopens to, whether split has room, and the reader-mode preset.
//
// ⚠ Every expectation below is a fact stated independently of the code: a
// layout the library actually wrote (copied from a real `prefs.json`), widths
// chosen so the answer is obvious by eye, or the rule Cole gave. None of them
// is re-derived with the arithmetic the module uses.
import { describe, expect, test } from "bun:test";
import {
  collapsedSides,
  decodeOpenSizes,
  encodeOpenSizes,
  isReader,
  readerAct,
  readerStaysLoud,
  rememberOpen,
  reopenSize,
  SPLIT_MIN_PX,
  splitRoom,
} from "./columns";

/** A layout `useDefaultLayout` wrote to a real home's prefs, verbatim. */
const REAL = { context: 21.722, document: 52.742, chat: 25.536 };
/** The same home with the context collapsed — plenty of room to reopen it. */
const CONTEXT_SHUT = { context: 0, document: 74.464, chat: 25.536 };

describe("collapsedSides — what counts as collapsed", () => {
  test("a layout the library saved with both columns open: nothing is collapsed", () => {
    expect(collapsedSides(REAL)).toEqual({ context: false, chat: false });
  });

  test("a column at zero width is collapsed, and only that one", () => {
    expect(collapsedSides({ context: 0, document: 74.464, chat: 25.536 })).toEqual({
      context: true,
      chat: false,
    });
    expect(collapsedSides({ context: 21.722, document: 78.278, chat: 0 })).toEqual({
      context: false,
      chat: true,
    });
  });

  test("both at zero is both", () => {
    expect(collapsedSides({ context: 0, document: 100, chat: 0 })).toEqual({
      context: true,
      chat: true,
    });
  });

  test("a narrow but OPEN column is not collapsed — the smallest width a drag can leave is the minimum, 12%", () => {
    expect(collapsedSides({ context: 12, document: 73, chat: 15 })).toEqual({
      context: false,
      chat: false,
    });
  });

  test("a fresh home (no saved layout) opens with both columns showing", () => {
    expect(collapsedSides(undefined)).toEqual({ context: false, chat: false });
  });
});

describe("the width a column reopens to — kept in the home's prefs", () => {
  test("an open column's width is remembered", () => {
    expect(rememberOpen({}, REAL, true)).toEqual({ context: 21.722, chat: 25.536 });
  });

  test("collapsing does NOT overwrite the width it will reopen to", () => {
    const before = { context: 30, chat: 25 };
    expect(rememberOpen(before, { context: 0, document: 75, chat: 25 }, true)).toEqual({
      context: 30,
      chat: 25,
    });
  });

  test("nothing changed is the SAME object, so no pref is written", () => {
    const before = { context: 21.722, chat: 25.536 };
    expect(rememberOpen(before, REAL, true)).toBe(before);
  });

  test("reopening uses the remembered width, else the column's default", () => {
    expect(reopenSize({ context: 30 }, "context", CONTEXT_SHUT)).toBe(30);
    // The defaults are the ones `App.tsx` gives the panels: 22 and 28.
    expect(reopenSize({}, "context", CONTEXT_SHUT)).toBe(22);
    expect(reopenSize({}, "chat", { context: 22, document: 78, chat: 0 })).toBe(28);
  });

  test("a column at its MINIMUM is not a width to reopen to — it is what the library falls back to", () => {
    // Verifier, 2026-09-22: Enter on the handle after a reload reopened the
    // context at 12% (153 px of 1280), and that 12 was then saved, so every
    // later reopen came back at 153 px too.
    const before = { context: 40, chat: 25 };
    expect(rememberOpen(before, { context: 12, document: 63, chat: 25 }, true)).toBe(before);
    expect(rememberOpen(before, { context: 40, document: 45, chat: 15 }, true)).toBe(before);
  });

  test("the minimum has half a percent of slack, and no more", () => {
    // The layout is floating-point: a column the library left "at" 12% can
    // read 12.2. A width a whole percent above the minimum is a real choice.
    expect(rememberOpen({}, { context: 12.2, document: 62.8, chat: 25 }, true)).toEqual({
      chat: 25,
    });
    expect(rememberOpen({}, { context: 13, document: 62, chat: 25 }, true)).toEqual({
      context: 13,
      chat: 25,
    });
  });

  test("only the HUMAN's resize is remembered — a reopen the library squeezed is not a choice", () => {
    // Reviewer: a capped reopen the library squeezed to 60 became the new
    // reopen width. Imperative resizes (a reopen, a collapse, the initial
    // mount) report isUserInteraction false; a drag or a key on a handle true.
    const before = { context: 40, chat: 25 };
    expect(rememberOpen(before, { context: 60, document: 25, chat: 15 }, false)).toBe(before);
    expect(rememberOpen(before, { context: 60, document: 25, chat: 15 }, true)).toEqual({
      context: 60,
      chat: 25, // 15 is the conversation's minimum: not remembered either
    });
  });

  test("a stored minimum decodes to nothing, so a pref the old bug wrote heals itself", () => {
    expect(decodeOpenSizes('{"context":12,"chat":15}')).toEqual({});
  });

  test("reopening never pushes the OTHER column shut: the document keeps its 25% minimum", () => {
    // Verifier: context remembered at ~75%, conversation dragged out to ~55%;
    // reopening the context at 75% squeezed the conversation shut.
    // 100 − 55 (conversation) − 25 (document's minimum) leaves 20.
    expect(reopenSize({ context: 75 }, "context", { context: 0, document: 45, chat: 55 })).toBe(20);
  });

  test("…and never below the column's own minimum, even when that means squeezing", () => {
    // 100 − 70 − 25 = 5, under the context's 12% minimum.
    expect(reopenSize({ context: 40 }, "context", { context: 0, document: 30, chat: 70 })).toBe(12);
  });

  test("the pref round-trips", () => {
    const sizes = { context: 30, chat: 25.5 };
    expect(decodeOpenSizes(encodeOpenSizes(sizes))).toEqual(sizes);
  });

  test("a pref that is missing, garbage or hand-edited decodes to nothing rather than throwing", () => {
    expect(decodeOpenSizes(undefined)).toEqual({});
    expect(decodeOpenSizes("not json")).toEqual({});
    expect(decodeOpenSizes('{"context":"wide","chat":null,"other":5}')).toEqual({});
    // JSON that parses to something other than an object must not reach the
    // property reads (reviewer: `null` would throw there).
    for (const raw of ["null", "5", '"wide"', "true", "[]", "[30, 25]"])
      expect(decodeOpenSizes(raw)).toEqual({});
  });

  test("a stored zero is not a width to reopen to — it would reopen collapsed", () => {
    expect(decodeOpenSizes('{"context":0,"chat":25}')).toEqual({ chat: 25 });
  });
});

describe("splitRoom — split against the width the pane actually gets", () => {
  test("the floor is Cole's 720 px (two 76ch columns)", () => {
    expect(SPLIT_MIN_PX).toBe(720);
  });

  test("a pane under the floor has no room now; at the floor it does", () => {
    expect(splitRoom(719, 100).now).toBe(false);
    expect(splitRoom(720, 100).now).toBe(true);
  });

  test("not measured yet (0) is not 'too narrow' — a saved split must not flicker", () => {
    expect(splitRoom(0, 50).now).toBe(true);
  });

  test("a 600 px pane holding half a 1200 px window WOULD have room with the columns collapsed", () => {
    expect(splitRoom(600, 50)).toEqual({ now: false, ifCollapsed: true });
  });

  test("a 400 px pane holding 60% of a ~667 px window would not, even then", () => {
    expect(splitRoom(400, 60)).toEqual({ now: false, ifCollapsed: false });
  });

  test("the estimate is not defeated by sub-pixel noise at the boundary", () => {
    // Verifier: a 722 px window said "no room" although collapsing gave the
    // document exactly 720 px. Measured widths are fractional and the layout
    // is rounded to three decimals, so half of 720 can come back a hair short.
    expect(splitRoom(359.99, 50).ifCollapsed).toBe(true);
  });

  test("rounded to the NEAREST pixel, not up: 719.3 px is not 720", () => {
    expect(splitRoom(359.65, 50).ifCollapsed).toBe(false);
  });

  test("a document already within 1% of the whole window has nothing to reclaim", () => {
    // 716 / 0.995 ≈ 719.6, which would round to 720 — but the columns beside a
    // 99.5% document are already shut, so collapsing them buys nothing.
    expect(splitRoom(716, 99.5).ifCollapsed).toBe(false);
  });

  test("with both columns already collapsed there is nothing more to reclaim", () => {
    expect(splitRoom(700, 100)).toEqual({ now: false, ifCollapsed: false });
  });
});

describe("reader mode — a preset, not a fifth view mode (Cole)", () => {
  const both = { context: true, chat: true };
  const neither = { context: false, chat: false };

  test("reader IS rendered with both columns collapsed — nothing else to store", () => {
    expect(isReader("rendered", both)).toBe(true);
    expect(isReader("rendered", { context: true, chat: false })).toBe(false);
    expect(isReader("split", both)).toBe(false);
    expect(isReader("raw", both)).toBe(false);
  });

  test("entering from anywhere: rendered, and collapse whatever is still open", () => {
    expect(readerAct("split", neither)).toEqual({
      mode: "rendered",
      collapse: ["context", "chat"],
      expand: [],
    });
    expect(readerAct("raw", { context: true, chat: false })).toEqual({
      mode: "rendered",
      collapse: ["chat"],
      expand: [],
    });
  });

  test("leaving: both columns come back, and the view stays rendered", () => {
    expect(readerAct("rendered", both)).toEqual({ expand: ["context", "chat"], collapse: [] });
  });
});

describe("what reader mode's fade leaves at full strength (Cole, 2026-09-22)", () => {
  // Cole: anything asking for attention stays at full strength — unsaved edits
  // AND warnings such as "Changed on disk"; only idle chrome fades.
  const clean = { dirty: false, outsideChanged: false };
  const unsaved = { dirty: true, outsideChanged: false };
  const changedOnDisk = { dirty: false, outsideChanged: true };

  test("with unsaved edits, Save and the save-state marker stay loud and the rest fades", () => {
    expect(readerStaysLoud("save", unsaved)).toBe(true);
    expect(readerStaysLoud("status", unsaved)).toBe(true);
    expect(readerStaysLoud("other", unsaved)).toBe(false);
  });

  test("a file changed on disk keeps its marker loud — a warning is not idle chrome", () => {
    expect(readerStaysLoud("status", changedOnDisk)).toBe(true);
    // Save is disabled with nothing unsaved; the banner carries the acts.
    expect(readerStaysLoud("save", changedOnDisk)).toBe(false);
    expect(readerStaysLoud("other", changedOnDisk)).toBe(false);
  });

  test("with nothing asking for attention, everything fades", () => {
    expect(readerStaysLoud("save", clean)).toBe(false);
    expect(readerStaysLoud("status", clean)).toBe(false);
    expect(readerStaysLoud("other", clean)).toBe(false);
  });
});
