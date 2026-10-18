// The rule for when comparing has nothing to show.
import { describe, expect, test } from "bun:test";
import type { DocView } from "../workspace/protocol";
import { NOTHING_TO_COMPARE, nothingToCompare } from "./CompareView.tsx";

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
