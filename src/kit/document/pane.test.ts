// The document pane's small decisions (pane.ts), as pure rules.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LINE_NUMBERS_KEY,
  hasEditor,
  isSplitLayout,
  pointedRange,
  readLineNumbers,
  readViewMode,
  SPLIT_MIN_PX,
  saveState,
  shownViewMode,
  splitFits,
  storedLineNumbers,
} from "./pane";

describe("the line-number choice", () => {
  test("on only when stored on; anything else, nothing stored included, is off", () => {
    expect(DEFAULT_LINE_NUMBERS_KEY).toBe("spellbook:line-numbers");
    expect(readLineNumbers("on")).toBe(true);
    expect(readLineNumbers("off")).toBe(false);
    expect(readLineNumbers(null)).toBe(false);
    expect(readLineNumbers("true")).toBe(false);
  });

  test("stored as it is read back", () => {
    expect(readLineNumbers(storedLineNumbers(true))).toBe(true);
    expect(readLineNumbers(storedLineNumbers(false))).toBe(false);
  });
});

describe("the save marker", () => {
  test("a file gone from disk says so before anything else", () => {
    expect(saveState({ dirty: false, outsideChanged: false })).toBe("Saved");
    expect(saveState({ dirty: true, outsideChanged: false })).toBe("Unsaved");
    expect(saveState({ dirty: false, outsideChanged: true })).toBe("Changed on disk");
    expect(saveState({ dirty: false, outsideChanged: true, missing: "folder" })).toBe("File gone");
  });
});

describe("the view mode with split", () => {
  test("a stored split is restored only where split is offered", () => {
    expect(readViewMode("split", { split: true })).toBe("split");
    expect(readViewMode("split")).toBe("raw");
    expect(readViewMode("rendered")).toBe("rendered");
    expect(readViewMode("compare", { split: true })).toBe("raw");
    expect(readViewMode(null, { split: true })).toBe("raw");
  });

  test("split fits from its minimum up, and an unmeasured pane counts as fitting", () => {
    expect(SPLIT_MIN_PX).toBe(720);
    expect(splitFits(0)).toBe(true);
    expect(splitFits(719.5)).toBe(false);
    expect(splitFits(720)).toBe(true);
  });

  test("a split that is off or does not fit is drawn as raw; other modes as chosen", () => {
    expect(shownViewMode("split", { split: true, width: 900 })).toBe("split");
    expect(shownViewMode("split", { split: true, width: 0 })).toBe("split");
    expect(shownViewMode("split", { split: true, width: 600 })).toBe("raw");
    expect(shownViewMode("split", { split: false, width: 900 })).toBe("raw");
    expect(shownViewMode("rendered", { split: false, width: 600 })).toBe("rendered");
  });

  test("raw and split have an editor to insert at; rendered and compare do not", () => {
    expect(hasEditor("raw")).toBe(true);
    expect(hasEditor("split")).toBe(true);
    expect(hasEditor("rendered")).toBe(false);
    expect(hasEditor("compare")).toBe(false);
  });
});

describe("pointedRange: a passage the agent pointed at, in the text on screen now", () => {
  const p = { version: 1, from: 4, to: 11, quote: "lantern" };

  test("the daemon's offsets, while that version is still the one on screen", () => {
    expect(pointedRange(p, 1, "the lantern is lit")).toEqual({ from: 4, to: 11 });
  });

  test("found again when another version became active first", () => {
    expect(pointedRange(p, 2, "a lantern, again")).toEqual({ from: 2, to: 9 });
  });

  test("found again when the text moved under the offsets", () => {
    expect(pointedRange(p, 1, "now the lantern is lit")).toEqual({ from: 8, to: 15 });
  });

  test("nothing when the quote is gone, so the pane can say so", () => {
    expect(pointedRange(p, 2, "the lamp is out")).toBeNull();
  });
});

describe("the split's kept width", () => {
  test("only a layout with both halves is the split's", () => {
    expect(isSplitLayout({ "doc-raw": 30, "doc-rendered": 70 })).toBe(true);
    // Raw or rendered alone: the group one panel wide.
    expect(isSplitLayout({ "doc-raw": 100 })).toBe(false);
    expect(isSplitLayout({ "doc-rendered": 100 })).toBe(false);
    expect(isSplitLayout({})).toBe(false);
  });
});
