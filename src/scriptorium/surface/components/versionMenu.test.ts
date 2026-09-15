// The version menu's two pieces of logic (E37): what a version is CALLED, and
// what order the rows come in. Both are places the UI can quietly lie —
// showing the wrong name, or burying the version you are editing.
import { describe, expect, test } from "bun:test";
import type { Version } from "../../backend/protocol";
import { ordered, versionLabel, versionSummary } from "./VersionMenu";

const v = (n: number, extra: Partial<Version> = {}): Version => ({
  n,
  author: "human",
  createdAt: n * 1000,
  path: `/docs/note/v${n}.md`,
  ...extra,
});

describe("versionLabel", () => {
  test("the label is the identity when there is one", () => {
    expect(versionLabel(v(2, { label: "before the agent's pass" }))).toBe(
      "before the agent's pass",
    );
  });

  test("an unnamed version is called by its number", () => {
    expect(versionLabel(v(3))).toBe("v3");
  });

  test("a blank or whitespace label is not a name", () => {
    expect(versionLabel(v(4, { label: "   " }))).toBe("v4");
    expect(versionLabel(v(5, { label: "" }))).toBe("v5");
  });

  test("a label is trimmed rather than shown with its padding", () => {
    expect(versionLabel(v(6, { label: "  draft two  " }))).toBe("draft two");
  });
});

describe("ordered", () => {
  test("the ACTIVE version comes first whatever its age", () => {
    const rows = ordered([v(1), v(2), v(3)], 1);
    expect(rows[0]?.n).toBe(1);
  });

  test("the rest are newest first", () => {
    const rows = ordered([v(1), v(2), v(3)], 1);
    expect(rows.map((r) => r.n)).toEqual([1, 3, 2]);
  });

  test("every version is present exactly once", () => {
    const rows = ordered([v(1), v(2), v(3), v(4)], 3);
    expect(rows.map((r) => r.n).sort()).toEqual([1, 2, 3, 4]);
  });

  test("the caller's array is not reordered underneath it", () => {
    // The menu re-sorts on every render; mutating the state it was handed
    // would make the document's own version list drift into display order.
    const input = [v(1), v(2), v(3)];
    ordered(input, 2);
    expect(input.map((x) => x.n)).toEqual([1, 2, 3]);
  });

  test("a single version is simply itself", () => {
    expect(ordered([v(1)], 1).map((r) => r.n)).toEqual([1]);
  });
});

describe("versionSummary", () => {
  test("the number alone when the version has no name", () => {
    expect(versionSummary(v(2), 2)).toBe("v2");
  });

  test("the number and the name when it has one", () => {
    expect(versionSummary(v(2, { label: "tighter prose" }), 2)).toBe("v2 · tighter prose");
  });

  test("a long name is CUT, so it cannot push the counts off the strip", () => {
    const long = "a name far longer than the strip can reasonably carry";
    const out = versionSummary(v(3, { label: long }), 3, 12);
    expect(out).toBe("v3 · a name far…");
    expect(out.length).toBeLessThan(long.length);
  });

  test("a cut landing on a space does not leave a gap before the ellipsis", () => {
    // max 5 cuts at index 4, which is the space after "one".
    expect(versionSummary(v(5, { label: "one two three" }), 5, 5)).toBe("v5 · one…");
  });

  test("a name exactly at the limit is not cut", () => {
    expect(versionSummary(v(4, { label: "123456789012" }), 4, 12)).toBe("v4 · 123456789012");
  });

  test("a missing version still names the number it was asked about", () => {
    expect(versionSummary(undefined, 7)).toBe("v7");
  });
});
