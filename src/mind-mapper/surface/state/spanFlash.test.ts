import { describe, expect, test } from "bun:test";
import { mapRangeToNodes } from "./spanFlash";

// Nodes as a rendered bubble would yield them: textContent is the exact
// concatenation, so global offsets index into the joined string.
const nodes = (...texts: string[]) => texts.map((text) => ({ text }));

describe("mapRangeToNodes", () => {
  test("range inside a single node → one local instruction", () => {
    // "hello world" — mark "world".
    expect(mapRangeToNodes(nodes("hello world"), 6, 11)).toEqual([{ index: 0, start: 6, end: 11 }]);
  });

  test("range spanning two nodes splits at the boundary", () => {
    // "bold " + "claim" (e.g. text + <strong> child) — mark "ld cla".
    expect(mapRangeToNodes(nodes("bold ", "claim"), 2, 8)).toEqual([
      { index: 0, start: 2, end: 5 },
      { index: 1, start: 0, end: 3 },
    ]);
  });

  test("range spanning three nodes marks the middle one whole", () => {
    expect(mapRangeToNodes(nodes("one ", "two", " three"), 2, 9)).toEqual([
      { index: 0, start: 2, end: 4 },
      { index: 1, start: 0, end: 3 },
      { index: 2, start: 0, end: 2 },
    ]);
  });

  test("partial overlap at a node edge yields no zero-length instruction", () => {
    // Range ends exactly where node 1 begins — node 1 contributes nothing.
    expect(mapRangeToNodes(nodes("abc", "def"), 1, 3)).toEqual([{ index: 0, start: 1, end: 3 }]);
    // Range starts exactly where node 0 ends — node 0 contributes nothing.
    expect(mapRangeToNodes(nodes("abc", "def"), 3, 5)).toEqual([{ index: 1, start: 0, end: 2 }]);
  });

  test("empty text nodes in the walk are skipped, offsets stay aligned", () => {
    expect(mapRangeToNodes(nodes("ab", "", "cd"), 1, 3)).toEqual([
      { index: 0, start: 1, end: 2 },
      { index: 2, start: 0, end: 1 },
    ]);
  });

  test("range past the end clamps to what exists", () => {
    expect(mapRangeToNodes(nodes("abc"), 1, 99)).toEqual([{ index: 0, start: 1, end: 3 }]);
  });

  test("degenerate ranges produce nothing", () => {
    expect(mapRangeToNodes(nodes("abc"), 2, 2)).toEqual([]);
    expect(mapRangeToNodes(nodes("abc"), 3, 1)).toEqual([]);
    expect(mapRangeToNodes([], 0, 5)).toEqual([]);
  });
});
