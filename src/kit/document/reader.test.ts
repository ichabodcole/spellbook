// Reader mode's rules: a preset derived from the view and the columns, what the
// toggle does, and what its fade leaves at full strength.

import { describe, expect, test } from "bun:test";
import { isReader, readerAct, readerStaysLoud } from "./reader.ts";

const both = { context: true, chat: true };
const neither = { context: false, chat: false };

describe("reader mode is a preset, not a fifth view mode", () => {
  test("it IS rendered with both columns collapsed, and nothing else", () => {
    expect(isReader("rendered", both)).toBe(true);
    expect(isReader("rendered", { context: true, chat: false })).toBe(false);
    expect(isReader("rendered", { context: false, chat: true })).toBe(false);
    expect(isReader("rendered", neither)).toBe(false);
    expect(isReader("split", both)).toBe(false);
    expect(isReader("raw", both)).toBe(false);
    expect(isReader("compare", both)).toBe(false);
  });

  test("entering sets rendered and collapses only what is open", () => {
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
    // Already shut, only the view changes.
    expect(readerAct("compare", both)).toEqual({ mode: "rendered", collapse: [], expand: [] });
    // Rendered with one column open is not reader mode yet: entering shuts the other.
    expect(readerAct("rendered", { context: false, chat: true })).toEqual({
      mode: "rendered",
      collapse: ["context"],
      expand: [],
    });
  });

  test("leaving reopens both columns and leaves the view as it is", () => {
    expect(readerAct("rendered", both)).toEqual({ expand: ["context", "chat"], collapse: [] });
  });
});

describe("what reader mode's fade leaves at full strength", () => {
  test("unsaved edits keep Save and the save marker loud", () => {
    const unsaved = { dirty: true, outsideChanged: false };
    expect(readerStaysLoud("save", unsaved)).toBe(true);
    expect(readerStaysLoud("status", unsaved)).toBe(true);
    expect(readerStaysLoud("other", unsaved)).toBe(false);
  });

  test("a change on disk keeps the marker loud, and Save fades when there is nothing to save", () => {
    const changedOnDisk = { dirty: false, outsideChanged: true };
    expect(readerStaysLoud("status", changedOnDisk)).toBe(true);
    expect(readerStaysLoud("save", changedOnDisk)).toBe(false);
    expect(readerStaysLoud("other", changedOnDisk)).toBe(false);
  });

  test("a file gone from disk keeps the marker loud", () => {
    const gone = { dirty: false, outsideChanged: false, missing: "file" as const };
    expect(readerStaysLoud("status", gone)).toBe(true);
    expect(readerStaysLoud("save", gone)).toBe(false);
  });

  test("with nothing asking for attention everything fades", () => {
    const clean = { dirty: false, outsideChanged: false };
    expect(readerStaysLoud("save", clean)).toBe(false);
    expect(readerStaysLoud("status", clean)).toBe(false);
    expect(readerStaysLoud("other", clean)).toBe(false);
  });
});
