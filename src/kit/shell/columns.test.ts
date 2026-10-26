// The side columns getting out of the way: what counts as collapsed, and the
// width a column reopens to.
//
// Every expectation below is a fact stated independently of the code: a layout
// the library actually wrote, widths chosen so the answer is obvious by eye, or
// the rule itself. None of them is re-derived with the arithmetic the module uses.
import { describe, expect, test } from "bun:test";
import {
  collapsedFrom,
  collapsedSides,
  decodeFloatClosed,
  decodeOpenSizes,
  encodeFloatClosed,
  encodeOpenSizes,
  floatOnRail,
  floatShown,
  readKept,
  rememberOpen,
  reopenSize,
} from "./columns";

/** A layout `useDefaultLayout` wrote, verbatim. */
const REAL = { context: 21.722, centre: 52.742, chat: 25.536 };
/** The same layout with the context collapsed: plenty of room to reopen it. */
const CONTEXT_SHUT = { context: 0, centre: 74.464, chat: 25.536 };

describe("collapsedSides — what counts as collapsed", () => {
  test("a layout the library saved with both columns open: nothing is collapsed", () => {
    expect(collapsedSides(REAL)).toEqual({ context: false, chat: false });
  });

  test("a column at zero width is collapsed, and only that one", () => {
    expect(collapsedSides({ context: 0, centre: 74.464, chat: 25.536 })).toEqual({
      context: true,
      chat: false,
    });
    expect(collapsedSides({ context: 21.722, centre: 78.278, chat: 0 })).toEqual({
      context: false,
      chat: true,
    });
  });

  test("both at zero is both", () => {
    expect(collapsedSides({ context: 0, centre: 100, chat: 0 })).toEqual({
      context: true,
      chat: true,
    });
  });

  test("a narrow but OPEN column is not collapsed — the smallest width a drag can leave is the minimum, 12%", () => {
    expect(collapsedSides({ context: 12, centre: 73, chat: 15 })).toEqual({
      context: false,
      chat: false,
    });
  });

  test("a column collapsed to its rail is collapsed, whatever the window makes of 40 px", () => {
    // 40 px of a 1400 px group is 2.857%; of a 640 px group, 6.25%; of 400 px, 10%.
    expect(collapsedSides({ context: 2.857, centre: 69.643, chat: 27.5 })).toEqual({
      context: true,
      chat: false,
    });
    expect(collapsedSides({ context: 6.25, centre: 87.5, chat: 6.25 })).toEqual({
      context: true,
      chat: true,
    });
    expect(collapsedSides({ context: 10, centre: 80, chat: 10 })).toEqual({
      context: true,
      chat: true,
    });
  });

  test("a column just under its minimum (12% and 15%) by more than the slack is collapsed", () => {
    expect(collapsedSides({ context: 11.4, centre: 74.1, chat: 14.5 })).toEqual({
      context: true,
      chat: false,
    });
    expect(collapsedSides({ context: 11.6, centre: 73.9, chat: 14.4 })).toEqual({
      context: false,
      chat: true,
    });
  });

  test("a fresh browser (no saved layout) opens with both columns showing", () => {
    expect(collapsedSides(undefined)).toEqual({ context: false, chat: false });
  });
});

describe("the width a column reopens to — kept beside the layout", () => {
  test("an open column's width is remembered", () => {
    expect(rememberOpen({}, REAL, true)).toEqual({ context: 21.722, chat: 25.536 });
  });

  test("collapsing does NOT overwrite the width it will reopen to", () => {
    const before = { context: 30, chat: 25 };
    expect(rememberOpen(before, { context: 0, centre: 75, chat: 25 }, true)).toEqual({
      context: 30,
      chat: 25,
    });
  });

  test("collapsing to a rail does not overwrite it either", () => {
    const before = { context: 30, chat: 25 };
    expect(rememberOpen(before, { context: 2.857, centre: 72.143, chat: 25 }, true)).toBe(before);
  });

  test("a reopen beside the other column's rail leaves the centre its minimum", () => {
    // The chat is a 4% rail: 100 - 4 - 25 leaves 71 for the context.
    expect(reopenSize({ context: 80 }, "context", { context: 3, centre: 93, chat: 4 })).toBe(71);
    expect(reopenSize({ context: 30 }, "context", { context: 3, centre: 93, chat: 4 })).toBe(30);
  });

  test("nothing changed is the SAME object, so nothing is written", () => {
    const before = { context: 21.722, chat: 25.536 };
    expect(rememberOpen(before, REAL, true)).toBe(before);
  });

  test("reopening uses the remembered width, else the column's default", () => {
    expect(reopenSize({ context: 30 }, "context", CONTEXT_SHUT)).toBe(30);
    // The defaults are the ones `App.tsx` gives the panels: 22 and 28.
    expect(reopenSize({}, "context", CONTEXT_SHUT)).toBe(22);
    expect(reopenSize({}, "chat", { context: 22, centre: 78, chat: 0 })).toBe(28);
  });

  test("a column at its MINIMUM is not a width to reopen to — it is what the library falls back to", () => {
    // Verifier, 2026-09-22: Enter on the handle after a reload reopened the
    // context at 12% (153 px of 1280), and that 12 was then saved, so every
    // later reopen came back at 153 px too.
    const before = { context: 40, chat: 25 };
    expect(rememberOpen(before, { context: 12, centre: 63, chat: 25 }, true)).toBe(before);
    expect(rememberOpen(before, { context: 40, centre: 45, chat: 15 }, true)).toBe(before);
  });

  test("the minimum has half a percent of slack, and no more", () => {
    // The layout is floating-point: a column the library left "at" 12% can
    // read 12.2. A width a whole percent above the minimum is a real choice.
    expect(rememberOpen({}, { context: 12.2, centre: 62.8, chat: 25 }, true)).toEqual({
      chat: 25,
    });
    expect(rememberOpen({}, { context: 13, centre: 62, chat: 25 }, true)).toEqual({
      context: 13,
      chat: 25,
    });
  });

  test("only the HUMAN's resize is remembered — a reopen the library squeezed is not a choice", () => {
    // Reviewer: a capped reopen the library squeezed to 60 became the new
    // reopen width. Imperative resizes (a reopen, a collapse, the initial
    // mount) report isUserInteraction false; a drag or a key on a handle true.
    const before = { context: 40, chat: 25 };
    expect(rememberOpen(before, { context: 60, centre: 25, chat: 15 }, false)).toBe(before);
    expect(rememberOpen(before, { context: 60, centre: 25, chat: 15 }, true)).toEqual({
      context: 60,
      chat: 25, // 15 is the conversation's minimum: not remembered either
    });
  });

  test("a stored minimum decodes to nothing, so a bad stored value heals itself", () => {
    expect(decodeOpenSizes('{"context":12,"chat":15}')).toEqual({});
  });

  test("reopening never pushes the OTHER column shut: the centre keeps its 25% minimum", () => {
    // Verifier: context remembered at ~75%, conversation dragged out to ~55%;
    // reopening the context at 75% squeezed the conversation shut.
    // 100 − 55 (conversation) − 25 (the centre's minimum) leaves 20.
    expect(reopenSize({ context: 75 }, "context", { context: 0, centre: 45, chat: 55 })).toBe(20);
  });

  test("…and never below the column's own minimum, even when that means squeezing", () => {
    // 100 − 70 − 25 = 5, under the context's 12% minimum.
    expect(reopenSize({ context: 40 }, "context", { context: 0, centre: 30, chat: 70 })).toBe(12);
  });

  test("the stored value round-trips", () => {
    const sizes = { context: 30, chat: 25.5 };
    expect(decodeOpenSizes(encodeOpenSizes(sizes))).toEqual(sizes);
  });

  test("a value that is missing, garbage or hand-edited decodes to nothing rather than throwing", () => {
    expect(decodeOpenSizes(undefined)).toEqual({});
    expect(decodeOpenSizes("not json")).toEqual({});
    expect(decodeOpenSizes('{"context":"wide","chat":null,"other":5}')).toEqual({});
    // JSON that parses to something other than an object must not reach the
    // property reads.
    for (const raw of ["null", "5", '"wide"', "true", "[]", "[30, 25]"])
      expect(decodeOpenSizes(raw)).toEqual({});
  });

  test("a stored zero is not a width to reopen to — it would reopen collapsed", () => {
    expect(decodeOpenSizes('{"context":0,"chat":25}')).toEqual({ chat: 25 });
  });
});

describe("collapsedFrom — the panels' own answer, in any window", () => {
  // A 340 px window: the context's 40 px rail is 11.76% of it, ABOVE the guess's
  // threshold (12% less half a percent), so the layout alone reads it as open.
  const NARROW = { context: 11.76, centre: 76.48, chat: 11.76 };
  const panel = (shut: boolean) => ({ isCollapsed: () => shut });

  test("the layout alone misreads a rail in a narrow window, which is why it is only a first guess", () => {
    expect(collapsedSides(NARROW)).toEqual({ context: false, chat: true });
  });

  test("a panel that says it is collapsed is collapsed, whatever its percentage", () => {
    expect(collapsedFrom(NARROW, { context: panel(true), chat: panel(true) })).toEqual({
      context: true,
      chat: true,
    });
    expect(collapsedFrom(NARROW, { context: panel(false), chat: panel(false) })).toEqual({
      context: false,
      chat: false,
    });
  });

  test("where there is no panel yet, the layout's guess stands", () => {
    expect(collapsedFrom({ context: 0, centre: 72, chat: 28 }, {})).toEqual({
      context: true,
      chat: false,
    });
    expect(collapsedFrom(NARROW, { context: null, chat: panel(false) })).toEqual({
      context: false,
      chat: false,
    });
  });

  test("a rail wider than the minimum in a narrow window is not remembered as a width", () => {
    const before = { context: 30, chat: 25 };
    // 13.3% is a 40 px rail in a 300 px window: past the minimum, still a rail.
    const layout = { context: 13.3, centre: 61.7, chat: 25 };
    expect(rememberOpen(before, layout, true, { context: true, chat: false })).toBe(before);
    // Without being told, it would have been taken for a choice.
    expect(rememberOpen(before, layout, true)).toEqual({ context: 13.3, chat: 25 });
  });
});

describe("the floating composer — where the composer is drawn with the chat shut", () => {
  const OPEN = { chat: false };
  const SHUT = { chat: true };

  test("it floats exactly while the chat is collapsed and the float is not closed", () => {
    expect(floatShown(SHUT, false)).toBe(true);
    expect(floatShown(SHUT, true)).toBe(false);
    expect(floatShown(OPEN, false)).toBe(false);
    expect(floatShown(OPEN, true)).toBe(false);
  });

  test("the rail's chat icon shows exactly while the chat is collapsed and the float closed", () => {
    expect(floatOnRail(SHUT, true)).toBe(true);
    expect(floatOnRail(SHUT, false)).toBe(false);
    expect(floatOnRail(OPEN, true)).toBe(false);
    expect(floatOnRail(OPEN, false)).toBe(false);
  });

  test("never both: the float and the rail's icon are the two states of a collapsed chat", () => {
    for (const closed of [true, false])
      expect(floatShown(SHUT, closed)).toBe(!floatOnRail(SHUT, closed));
  });

  test("closed and open both round-trip, and nothing stored is open", () => {
    expect(decodeFloatClosed(encodeFloatClosed(true))).toBe(true);
    expect(decodeFloatClosed(encodeFloatClosed(false))).toBe(false);
    expect(decodeFloatClosed(null)).toBe(false);
  });

  test("a value that is missing or garbage shows the float rather than hiding it", () => {
    for (const raw of [undefined, null, "", "Closed", "true", "{}"])
      expect(decodeFloatClosed(raw)).toBe(false);
  });
});

describe("readKept — the shell's keys are bare, and an older stored value still reads", () => {
  const store = (entries: Record<string, string>) => (key: string) => entries[key] ?? null;

  test("the bare key is read first", () => {
    const get = store({ "panes:float": "open", "story-studio:panes:float": "closed" });
    expect(readKept(get, "panes:float")).toBe("open");
  });

  test("a value stored under the older, doubly prefixed key is read when the bare one is absent", () => {
    // The storage adds "story-studio:" itself, so this is what sat in localStorage
    // as "story-studio:story-studio:panes:open".
    const get = store({ "story-studio:panes:open": '{"chat":30}' });
    expect(decodeOpenSizes(readKept(get, "panes:open") ?? undefined)).toEqual({ chat: 30 });
  });

  test("neither stored is nothing", () => {
    expect(readKept(store({}), "panes:float")).toBeNull();
  });
});
