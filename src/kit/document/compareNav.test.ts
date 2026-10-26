// The rules for finding your way between a comparison's changes.
import { describe, expect, test } from "bun:test";
import type { DiffLine } from "../workspace/protocol";
import { rowsOf } from "./CompareView.tsx";
import { hunkLine, hunkSpans, hunkSummary, markPlace, rowOfLine } from "./compareNav.ts";

const same = (a: number, b: number, text = `line ${a}`): DiffLine => ({ op: "same", a, b, text });
const del = (a: number, text = `old ${a}`): DiffLine => ({ op: "del", a, text });
const add = (b: number, text = `new ${b}`): DiffLine => ({ op: "add", b, text });

// Ten lines; line 3 replaced by two, line 7 deleted.
const LINES: DiffLine[] = [
  same(0, 0),
  same(1, 1),
  same(2, 2),
  del(3),
  add(3),
  add(4),
  same(4, 5),
  same(5, 6),
  same(6, 7),
  del(7),
  same(8, 8),
  same(9, 9),
];
const rows = rowsOf(LINES, [1, 2]);

describe("hunkSpans", () => {
  test("each change's rows, a replacement padded to its longer side", () => {
    expect(Object.fromEntries(hunkSpans(rows))).toEqual({
      1: { start: 3, end: 5 },
      2: { start: 8, end: 9 },
    });
  });

  test("no changes, no spans", () => {
    expect(hunkSpans(rowsOf([same(0, 0)], [])).size).toBe(0);
  });
});

describe("rowOfLine", () => {
  test("a line of the active version on a same row, or as a deleted line", () => {
    expect(rowOfLine(rows, 0)).toBe(0);
    expect(rowOfLine(rows, 3)).toBe(3);
    expect(rowOfLine(rows, 7)).toBe(8);
    expect(rowOfLine(rows, 9)).toBe(10);
  });

  test("a line past the end stands at the last row that has one", () => {
    expect(rowOfLine(rows, 40)).toBe(10);
  });
});

describe("hunkSummary", () => {
  test("the first line with words in it, from the active side first", () => {
    expect(hunkSummary({ del: ["", "  the  lantern  "], add: ["other"] })).toBe("the lantern");
    expect(hunkSummary({ del: [], add: ["", "an added line"] })).toBe("an added line");
  });

  test("long lines are cut with an ellipsis; blank ones say so", () => {
    const s = hunkSummary({ del: ["a".repeat(80)], add: [] }, 10);
    expect(s).toBe(`${"a".repeat(9)}…`);
    expect(hunkSummary({ del: ["", " "], add: [] })).toBe("blank lines");
  });
});

test("hunkLine is the 1-based line the gutter shows on the active side", () => {
  expect(hunkLine({ aFrom: 0 })).toBe(1);
  expect(hunkLine({ aFrom: 41 })).toBe(42);
});

describe("markPlace", () => {
  test("by row count before the view is laid out", () => {
    expect(markPlace({ start: 50, end: 60 }, 100)).toEqual({ top: 50, height: 10 });
  });

  test("by measured tops once it is, so wrapped lines move the marks", () => {
    const tops = [0, 10, 20, 80, 90];
    const at = markPlace({ start: 3, end: 4 }, 5, { tops, height: 100 });
    expect(at.top).toBe(80);
    expect(at.height).toBeCloseTo(10);
  });

  test("a one-line change in a long document is never thinner than the minimum", () => {
    const at = markPlace({ start: 999, end: 1000 }, 1000, null, 0.6);
    expect(at.height).toBe(0.6);
    expect(at.top + at.height).toBeLessThanOrEqual(100);
  });

  test("a measurement that does not match the rows is not trusted", () => {
    expect(markPlace({ start: 1, end: 2 }, 4, { tops: [0, 5], height: 100 })).toEqual({
      top: 25,
      height: 25,
    });
  });
});
