// The smallest change between two texts (text.ts), checked by applying it.
import { describe, expect, test } from "bun:test";
import { invertChange, lineThrough, minimalChange, rangeThrough } from "./text";

const apply = (a: string, c: ReturnType<typeof minimalChange>) =>
  c ? a.slice(0, c.from) + c.insert + a.slice(c.to) : a;

describe("minimalChange: the editor keeps the reader's place", () => {
  test("identical texts need no change", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
  });

  test("an edit deep in a long text touches only that span", () => {
    const a = `${"x".repeat(10_000)}OLD${"y".repeat(10_000)}`;
    const b = `${"x".repeat(10_000)}NEW TEXT${"y".repeat(10_000)}`;
    const c = minimalChange(a, b);
    expect(c).toEqual({ from: 10_000, to: 10_003, insert: "NEW TEXT" });
    expect(apply(a, c)).toBe(b);
  });

  test("insertions, deletions and whole rewrites all round-trip", () => {
    for (const [a, b] of [
      ["abc", "abXc"],
      ["abXc", "abc"],
      ["", "new"],
      ["old", ""],
      ["aaa", "aaaa"],
      ["hello", "world"],
    ] as const) {
      expect(apply(a, minimalChange(a, b))).toBe(b);
    }
  });
});

describe("rangeThrough: a range in one text, in the text a change made of it", () => {
  const a = "one two three";
  const map = (b: string, r: { from: number; to: number }) => rangeThrough(r, minimalChange(a, b));

  test("before and after the change: kept, and shifted by what it added", () => {
    const b = "one TWO! three";
    expect(map(b, { from: 0, to: 3 })).toEqual({ from: 0, to: 3 });
    const at = a.indexOf("three");
    expect(map(b, { from: at, to: at + 5 })).toEqual({ from: b.indexOf("three"), to: b.length });
  });

  test("an insertion: a range starting at it moves past it; one ending at it stays", () => {
    expect(map("NEW one two three", { from: 0, to: 3 })).toEqual({ from: 4, to: 7 });
    expect(map("one NEW two three", { from: 0, to: 4 })).toEqual({ from: 0, to: 4 });
  });

  test("an end inside what was replaced, or at its edge, cannot be mapped", () => {
    const b = "one 2 three";
    expect(map(b, { from: 4, to: 7 })).toBeNull();
    expect(map(b, { from: 0, to: 6 })).toBeNull();
    expect(map(b, { from: 5, to: 13 })).toBeNull();
    // A range around the whole change maps, and holds what replaced it.
    const r = map(b, { from: 0, to: 13 });
    expect(r && b.slice(r.from, r.to)).toBe(b);
  });

  test("no change maps every range to itself, and the inverse maps back", () => {
    expect(rangeThrough({ from: 2, to: 5 }, null)).toEqual({ from: 2, to: 5 });
    const b = "NEW one two three";
    const c = minimalChange(a, b);
    if (!c) throw new Error("a change");
    const there = rangeThrough({ from: 4, to: 7 }, c);
    expect(there && b.slice(there.from, there.to)).toBe("two");
    expect(there && rangeThrough(there, invertChange(c, a))).toEqual({ from: 4, to: 7 });
  });
});

describe("lineThrough: a line of one text, in the text a change made of it", () => {
  test("lines added above move every line below them down", () => {
    const a = "l1\nl2\nl3\n";
    const b = "new\nmore\nl1\nl2\nl3\n";
    const c = minimalChange(a, b);
    expect(lineThrough(1, a, b, c)).toBe(3);
    expect(lineThrough(2, a, b, c)).toBe(4);
    // And back.
    expect(c && lineThrough(4, b, a, invertChange(c, a))).toBe(2);
  });

  test("a line inside what was replaced goes to the nearer edge of the change; one after it shifts", () => {
    const a = "l1\nl2\nl3\nl4\nl5\n";
    const b = "l1\nX\nl5\n";
    const c = minimalChange(a, b);
    expect(lineThrough(1, a, b, c)).toBe(1);
    expect(lineThrough(3, a, b, c)).toBe(2);
    expect(lineThrough(5, a, b, c)).toBe(3);
    // Nearer the end of a longer change: the line where the change ends.
    const d = "l1\nl2\nl3\nl4\nl5\nl6\n";
    const e = "l1\nX\nY\nl6\n";
    const ce = minimalChange(d, e);
    expect(lineThrough(2, d, e, ce)).toBe(2);
    expect(lineThrough(5, d, e, ce)).toBe(3);
  });

  test("no change, no move", () => {
    expect(lineThrough(7, "a\n", "a\n", null)).toBe(7);
  });
});
