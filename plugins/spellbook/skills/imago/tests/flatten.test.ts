import { expect, test } from "bun:test";
import { wrapLine } from "../surface/components/annotations/flatten";

test("wrapLine: short line passes through untouched", () => {
  expect(wrapLine("hello world", 20)).toEqual(["hello world"]);
});

test("wrapLine: wraps on word boundaries", () => {
  expect(wrapLine("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
});

// Regression for the long-word chop bug: the already-flushed `cur` must not be
// re-prepended to the hard-chopped word (it corrupted pin labels on the
// flattened handoff).
test("wrapLine: a long unbroken word is hard-chopped without leaking prior text", () => {
  const out = wrapLine("hi supercalifragilistic", 8);
  // "hi" flushes first, then the long word chops into ≤8-char pieces — no "hi"
  // glued onto the front of the first chop.
  expect(out[0]).toBe("hi");
  expect(out[1]).toBe("supercal");
  expect(out.join("")).toBe("hisupercalifragilistic");
  for (const piece of out) expect(piece.length).toBeLessThanOrEqual(8);
});

test("wrapLine: a single over-budget word with no prefix chops cleanly", () => {
  expect(wrapLine("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
});
