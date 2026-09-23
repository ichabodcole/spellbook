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
  rememberOpen,
  reopenSize,
  SPLIT_MIN_PX,
  splitRoom,
} from "./columns";

/** A layout `useDefaultLayout` wrote to a real home's prefs, verbatim. */
const REAL = { context: 21.722, document: 52.742, chat: 25.536 };

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
    expect(rememberOpen({}, REAL)).toEqual({ context: 21.722, chat: 25.536 });
  });

  test("collapsing does NOT overwrite the width it will reopen to", () => {
    const before = { context: 30, chat: 25 };
    expect(rememberOpen(before, { context: 0, document: 75, chat: 25 })).toEqual({
      context: 30,
      chat: 25,
    });
  });

  test("nothing changed is the SAME object, so no pref is written", () => {
    const before = { context: 21.722, chat: 25.536 };
    expect(rememberOpen(before, REAL)).toBe(before);
  });

  test("reopening uses the remembered width, else the column's default", () => {
    expect(reopenSize({ context: 30 }, "context")).toBe(30);
    // The defaults are the ones `App.tsx` gives the panels: 22 and 28.
    expect(reopenSize({}, "context")).toBe(22);
    expect(reopenSize({}, "chat")).toBe(28);
  });

  test("the pref round-trips", () => {
    const sizes = { context: 30, chat: 25.5 };
    expect(decodeOpenSizes(encodeOpenSizes(sizes))).toEqual(sizes);
  });

  test("a pref that is missing, garbage or hand-edited decodes to nothing rather than throwing", () => {
    expect(decodeOpenSizes(undefined)).toEqual({});
    expect(decodeOpenSizes("not json")).toEqual({});
    expect(decodeOpenSizes('{"context":"wide","chat":null,"other":5}')).toEqual({});
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
