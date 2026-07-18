// Pure-logic test for whitespace-tolerant span matching (Contract 6, the
// message-text half).

import { expect, test } from "bun:test";
import { spanSegments } from "./spanMatch";

test("a verbatim span marks its exact segment", () => {
  const segs = spanSegments("Maren returns to the hollow at dusk.", "returns to the hollow");
  expect(segs).toEqual([
    { text: "Maren ", mark: false },
    { text: "returns to the hollow", mark: true },
    { text: " at dusk.", mark: false },
  ]);
});

test("the match is whitespace-tolerant across reflow (newlines vs spaces)", () => {
  const segs = spanSegments("Maren returns\nto the   hollow at dusk.", "returns to the hollow");
  expect(segs.find((s) => s.mark)?.text).toBe("returns\nto the   hollow");
});

test("a span that misses returns the text unmarked", () => {
  expect(spanSegments("some text", "not present")).toEqual([{ text: "some text", mark: false }]);
});

test("no span (or a blank one) returns the text unmarked", () => {
  expect(spanSegments("some text")).toEqual([{ text: "some text", mark: false }]);
  expect(spanSegments("some text", "   ")).toEqual([{ text: "some text", mark: false }]);
});

test("a span at the very start produces no empty leading segment", () => {
  expect(spanSegments("hello world", "hello")).toEqual([
    { text: "hello", mark: true },
    { text: " world", mark: false },
  ]);
});
