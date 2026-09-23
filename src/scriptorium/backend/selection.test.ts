// E66: a selection belongs to the document text it was made in — the open
// document at its active version — and does not outlive that text leaving the
// screen.
import { describe, expect, test } from "bun:test";
import { selectionOnScreen } from "./selection";

const onAlpha = {
  doc: "alpha",
  version: 1,
  path: "/docs/alpha.md",
  fromLine: 3,
  toLine: 3,
  text: "about apples",
};

describe("selectionOnScreen — whether a held selection is still about what is shown", () => {
  test("the document and version it was made in, still open: kept, as the same value", () => {
    expect(selectionOnScreen(onAlpha, { doc: "alpha", version: 1 })).toBe(onAlpha);
  });

  test("⛔ another document opened: dropped, never re-labelled with the new one", () => {
    expect(selectionOnScreen(onAlpha, { doc: "beta", version: 1 })).toBeNull();
  });

  test("another version of the same document made active: dropped", () => {
    expect(selectionOnScreen(onAlpha, { doc: "alpha", version: 2 })).toBeNull();
  });

  test("no document open: dropped", () => {
    expect(selectionOnScreen(onAlpha, null)).toBeNull();
  });

  test("nothing held stays nothing", () => {
    expect(selectionOnScreen(null, { doc: "alpha", version: 1 })).toBeNull();
  });
});
