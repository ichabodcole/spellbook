// The guard every `useDefaultLayout` the kit calls reads through: a stored layout
// that is not one for exactly the group's panels reads as absent.
import { describe, expect, test } from "bun:test";
import { guardedLayoutStorage, isStoredLayout, layoutKey } from "./layoutStorage.ts";
import { BAD_LAYOUTS } from "./testLayout.ts";

const IDS = ["a", "b"];

describe("a stored pane layout", () => {
  test("its key is the layout library's", () => {
    expect(layoutKey("panes", ["context", "centre", "chat"])).toBe(
      "react-resizable-panels:panes:context:centre:chat",
    );
  });

  test("one size per panel, each from 0 to 100, is a layout", () => {
    expect(isStoredLayout('{"a": 30, "b": 70}', IDS)).toBe(true);
    expect(isStoredLayout('{"a": 0, "b": 100}', IDS)).toBe(true);
  });

  test("anything else is not: corrupt, wrongly shaped, out of range, or for other panels", () => {
    for (const bad of BAD_LAYOUTS)
      expect([bad.what, isStoredLayout(bad.value, IDS)]).toEqual([bad.what, false]);
    expect(isStoredLayout('{"a": 30}', IDS)).toBe(false);
    expect(isStoredLayout('{"a": 30, "b": 70, "c": 0}', IDS)).toBe(false);
    expect(isStoredLayout('{"a": -1, "b": 101}', IDS)).toBe(false);
  });

  test("the sizes must sum to 100, within half a point, and not all be zero", () => {
    expect(isStoredLayout('{"a": 100, "b": 100}', IDS)).toBe(false);
    expect(isStoredLayout('{"a": 30, "b": 30}', IDS)).toBe(false);
    expect(isStoredLayout('{"a": 0, "b": 0}', IDS)).toBe(false);
    expect(isStoredLayout('{"a": 30, "b": 69.4}', IDS)).toBe(false);
    // What the library writes, rounding and all.
    expect(isStoredLayout('{"a": 33.3333, "b": 66.6666}', IDS)).toBe(true);
    expect(isStoredLayout('{"a": 30, "b": 70.5}', IDS)).toBe(true);
  });

  test("the guard reads a bad layout as absent, and leaves writes and other keys alone", () => {
    const kept = new Map<string, string>([
      [layoutKey("g", IDS), "{not json"],
      ["theme", "{not json either"],
    ]);
    const storage = guardedLayoutStorage(
      { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) },
      "g",
      IDS,
    );
    expect(storage.getItem(layoutKey("g", IDS))).toBeNull();
    expect(storage.getItem("theme")).toBe("{not json either");
    expect(storage.getItem("absent")).toBeNull();
    storage.setItem(layoutKey("g", IDS), '{"a": 40, "b": 60}');
    expect(storage.getItem(layoutKey("g", IDS))).toBe('{"a": 40, "b": 60}');
  });
});
