import { describe, expect, test } from "bun:test";
import { contentStats, relativeTime } from "./stats";

describe("contentStats (Operator's useContentStats rules)", () => {
  test("empty and whitespace-only text is zero words", () => {
    expect(contentStats("")).toEqual({ words: 0, characters: 0 });
    expect(contentStats("  \n\t ")).toEqual({ words: 0, characters: 5 });
  });
  test("words are whitespace-separated runs; a contraction is one word", () => {
    expect(contentStats("don't  stop\nbelieving").words).toBe(3);
    expect(contentStats("# Heading\n\n- item one").words).toBe(5);
  });
  test("characters include whitespace and newlines", () => {
    expect(contentStats("a b\n").characters).toBe(4);
  });
});

describe("relativeTime", () => {
  const now = 1_800_000_000_000;
  test("recent is 'just now', then minutes, then hours", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
  test("a future timestamp does not go negative", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});
