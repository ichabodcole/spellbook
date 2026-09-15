import { describe, expect, test } from "bun:test";
import { friendlyListError, splitForCompletion } from "./context/AddPath";
import { minimalChange } from "./DocumentView";

const apply = (a: string, c: ReturnType<typeof minimalChange>) =>
  c ? a.slice(0, c.from) + c.insert + a.slice(c.to) : a;

describe("minimalChange — the viewer keeps the reader's place", () => {
  test("identical texts need no change", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
  });
  test("an edit deep in a long text touches only that span", () => {
    const a = `${"x".repeat(10_000)}OLD${"y".repeat(10_000)}`;
    const b = `${"x".repeat(10_000)}NEW TEXT${"y".repeat(10_000)}`;
    const c = minimalChange(a, b);
    expect(c).toEqual({ from: 10_000, to: 10_003, insert: "NEW TEXT" });
    expect(apply(a, c)).toBe(b);
  });
  test("insertions, deletions and whole rewrites all round-trip", () => {
    for (const [a, b] of [
      ["abc", "abXc"],
      ["abXc", "abc"],
      ["", "new"],
      ["old", ""],
      ["aaa", "aaaa"],
      ["hello", "world"],
    ] as const) {
      expect(apply(a, minimalChange(a, b))).toBe(b);
    }
  });
});

describe("the path box", () => {
  test("splitForCompletion reads the directory to list and the prefix", () => {
    expect(splitForCompletion("/Us")).toEqual({ dir: "/", prefix: "Us" });
    expect(splitForCompletion("~/Pro")).toEqual({ dir: "~", prefix: "Pro" });
    expect(splitForCompletion("~")).toEqual({ dir: "~", prefix: "" });
    expect(splitForCompletion("relative/path")).toBeNull();
  });
  test("listing errors read as words, not errno", () => {
    expect(friendlyListError("ENOENT: no such file or directory, scandir '/x'", "/x")).toBe(
      "No folder at /x",
    );
    expect(friendlyListError("EACCES: permission denied", "/root")).toBe(
      "Not allowed to read /root",
    );
    expect(friendlyListError("something else", "/a")).toBe("something else");
  });
});
