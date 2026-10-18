// The find bar's rules: matching in segments, mapping offsets to text nodes,
// stepping, the count, and which focus Cmd-F belongs to.
import { describe, expect, test } from "bun:test";
import {
  countLabel,
  findKeyAct,
  findMatches,
  isFindKey,
  type KeyLike,
  locate,
  MAX_PAINTED,
  paintWindow,
  stepIndex,
} from "./find.ts";

describe("findMatches", () => {
  test("every match in every segment, in order, case-folded by default", () => {
    expect(findMatches(["The lantern, the LANTERN", "no", "a lantern"], "lantern")).toEqual([
      { seg: 0, from: 4, to: 11 },
      { seg: 0, from: 17, to: 24 },
      { seg: 2, from: 2, to: 9 },
    ]);
  });

  test("match case keeps only the exact spelling", () => {
    expect(findMatches(["The lantern, the LANTERN"], "LANTERN", { matchCase: true })).toEqual([
      { seg: 0, from: 17, to: 24 },
    ]);
  });

  test("a match never spans two segments", () => {
    expect(findMatches(["end of one", "start of two"], "one start")).toEqual([]);
  });

  test("matches do not overlap, and an empty query matches nothing", () => {
    expect(findMatches(["aaaa"], "aa").map((m) => m.from)).toEqual([0, 2]);
    expect(findMatches(["anything"], "")).toEqual([]);
  });

  test("text whose lower case changes length is searched as written, so offsets hold", () => {
    // "İ" lower-cases to two code units; folding would shift every offset after it.
    expect(findMatches(["İstanbul lantern"], "lantern")).toEqual([{ seg: 0, from: 9, to: 16 }]);
  });
});

describe("locate", () => {
  // "the " | "lantern" | " is lit"
  const lengths = [4, 7, 7];

  test("an offset inside a node", () => {
    expect(locate(lengths, 6, "start")).toEqual({ node: 1, offset: 2 });
  });

  test("a start at a boundary belongs to the node that begins there", () => {
    expect(locate(lengths, 4, "start")).toEqual({ node: 1, offset: 0 });
  });

  test("an end at a boundary belongs to the node that ends there", () => {
    expect(locate(lengths, 11, "end")).toEqual({ node: 1, offset: 7 });
  });

  test("past the end is the end of the last node", () => {
    expect(locate(lengths, 40, "end")).toEqual({ node: 2, offset: 7 });
  });

  test("an empty node is never where a match begins", () => {
    expect(locate([3, 0, 4], 3, "start")).toEqual({ node: 2, offset: 0 });
  });
});

describe("stepping and counting", () => {
  test("Enter goes forward and wraps; Shift-Enter goes back and wraps", () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });

  test("the count says where you are, or that there is nothing", () => {
    expect(countLabel(2, 12, "x")).toBe("3 of 12");
    expect(countLabel(-1, 0, "x")).toBe("No results");
    expect(countLabel(-1, 0, "")).toBe("");
  });
});

describe("the shortcut", () => {
  const key = (k: Partial<KeyLike>): KeyLike => ({
    key: "f",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...k,
  });

  test("Cmd-F on a Mac, Ctrl-F elsewhere, and not with another modifier", () => {
    expect(isFindKey(key({ metaKey: true }), true)).toBe(true);
    expect(isFindKey(key({ ctrlKey: true }), true)).toBe(false);
    expect(isFindKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isFindKey(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isFindKey(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isFindKey(key({ key: "F", metaKey: true }), true)).toBe(true);
    expect(isFindKey(key({ key: "g", metaKey: true }), true)).toBe(false);
  });

  const at = (f: Partial<Parameters<typeof findKeyAct>[0]>) =>
    findKeyAct({
      inBar: false,
      textField: false,
      inEditor: false,
      inPane: false,
      nowhere: false,
      ...f,
    });

  test("it opens the bar from the view, the pane around it, or with focus nowhere in particular", () => {
    expect(at({ inPane: true })).toBe("open");
    expect(at({ nowhere: true })).toBe("open");
  });

  test("it is left alone in a text field (the chat's composer) and in the raw editor", () => {
    expect(at({ textField: true })).toBe("pass");
    expect(at({ inEditor: true, inPane: true })).toBe("pass");
    expect(at({ textField: true, inPane: true })).toBe("pass");
  });

  test("it is left alone elsewhere on the page", () => {
    expect(at({})).toBe("pass");
  });

  test("in the bar's own field it selects the query", () => {
    expect(at({ inBar: true, textField: true })).toBe("own");
  });
});

describe("paintWindow", () => {
  test("everything, when there are few", () => {
    expect(paintWindow(3, 40)).toEqual([0, 40]);
  });

  test("a window around the current match, never past either end", () => {
    expect(paintWindow(50_000, 120_000)).toEqual([49_500, 50_500]);
    expect(paintWindow(10, 120_000)).toEqual([0, MAX_PAINTED]);
    expect(paintWindow(119_999, 120_000)).toEqual([119_000, 120_000]);
    expect(paintWindow(-1, 120_000)).toEqual([0, MAX_PAINTED]);
  });
});
