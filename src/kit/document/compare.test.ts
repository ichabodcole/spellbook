// The rule for when comparing has nothing to show.
import { describe, expect, test } from "bun:test";
import type { DocView } from "../workspace/protocol";
import { defaultSide, NOTHING_TO_COMPARE, nothingToCompare } from "./CompareView.tsx";

const v = (n: number) => ({ n }) as DocView["versions"][number];
const doc = (versions: number, dirty: boolean, outsideChanged: boolean) => ({
  versions: Array.from({ length: versions }, (_, i) => v(i + 1)),
  dirty,
  outsideChanged,
});

describe("nothingToCompare", () => {
  test("one version that matches the file has nothing to compare", () => {
    expect(nothingToCompare(doc(1, false, false))).toBe(true);
  });

  test("two versions always have something to compare", () => {
    expect(nothingToCompare(doc(2, false, false))).toBe(false);
  });

  test("one version with unsaved edits still compares against the file", () => {
    expect(nothingToCompare(doc(1, true, false))).toBe(false);
  });

  test("one version whose file changed on disk still compares against the file", () => {
    expect(nothingToCompare(doc(1, false, true))).toBe(false);
  });

  test("the message says there is nothing to compare, never that they are identical", () => {
    expect(NOTHING_TO_COMPARE).toBe("Only one version — nothing to compare");
    expect(NOTHING_TO_COMPARE.toLowerCase()).not.toContain("identical");
  });
});

describe("defaultSide: what a comparison opens against", () => {
  const at = (n: number[], active: number, dirty = false, missing?: "file") => ({
    versions: n.map(v),
    active,
    dirty,
    ...(missing ? { missing } : {}),
  });

  test("the active version is the file, and others exist: the newest other version", () => {
    expect(defaultSide(at([1, 2, 3, 4], 1))).toBe(4);
    expect(defaultSide(at([1, 2, 3, 4], 4))).toBe(3);
  });

  test("the active version differs from the file: the file", () => {
    expect(defaultSide(at([1, 2, 3], 1, true))).toBe("original");
  });

  test("the file is gone: the file, which the view says is missing", () => {
    expect(defaultSide(at([1, 2], 1, false, "file"))).toBe("original");
  });

  test("no other version: the file", () => {
    expect(defaultSide(at([1], 1))).toBe("original");
  });
});
