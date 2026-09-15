import { describe, expect, test } from "bun:test";
import {
  anchorNeedle,
  BLOCK_SELECTOR,
  CHIP_ANCHOR_CHARS,
  commentId,
  EDITOR_ANCHOR_CHARS,
  removeComment,
  stripIds,
  truncate,
  updateCommentText,
} from "./comments";

describe("truncate (inventory A11, A16, A23)", () => {
  test("the ellipsis appears only PAST the limit", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcde", 5)).toBe("abcde");
    expect(truncate("abcdef", 5)).toBe("abcde…");
  });

  test("the chip truncates at 60, the editor label at 80", () => {
    expect(CHIP_ANCHOR_CHARS).toBe(60);
    expect(EDITOR_ANCHOR_CHARS).toBe(80);
    const long = "x".repeat(200);
    expect(truncate(long, CHIP_ANCHOR_CHARS)).toHaveLength(61);
    expect(truncate(long, EDITOR_ANCHOR_CHARS)).toHaveLength(81);
  });
});

describe("stripIds (inventory A22)", () => {
  test("the id never crosses the wire and is never persisted", () => {
    expect(stripIds([{ id: "c1", anchor: "a", text: "t" }])).toEqual([{ anchor: "a", text: "t" }]);
    for (const c of stripIds([{ id: "c1", anchor: "a", text: "t" }])) {
      expect(Object.keys(c).sort()).toEqual(["anchor", "text"]);
    }
  });

  test("an empty list stays an empty list, not undefined", () => {
    expect(stripIds([])).toEqual([]);
  });
});

describe("commentId", () => {
  test("c + the sequence number", () => {
    expect(commentId(1)).toBe("c1");
    expect(commentId(12)).toBe("c12");
  });
});

describe("updateCommentText (inventory A18)", () => {
  const list = [
    { id: "c1", anchor: "a", text: "one" },
    { id: "c2", anchor: "b", text: "two" },
  ];

  test("updates only the named comment and keeps its anchor and position", () => {
    const next = updateCommentText(list, "c2", "TWO");
    expect(next.map((c) => c.text)).toEqual(["one", "TWO"]);
    expect(next[1]?.anchor).toBe("b");
  });

  test("an unknown id changes nothing", () => {
    expect(updateCommentText(list, "nope", "x")).toEqual(list);
  });

  test("does not mutate the input", () => {
    updateCommentText(list, "c1", "changed");
    expect(list[0]?.text).toBe("one");
  });
});

describe("removeComment (inventory A21)", () => {
  test("removes by id, preserving order", () => {
    const list = [
      { id: "c1", anchor: "a", text: "one" },
      { id: "c2", anchor: "b", text: "two" },
      { id: "c3", anchor: "c", text: "three" },
    ];
    expect(removeComment(list, "c2").map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(removeComment(list, "nope")).toHaveLength(3);
  });
});

describe("anchoring (inventory A10, L15)", () => {
  test("the block set is the old page's, exactly", () => {
    expect(BLOCK_SELECTOR.split(",")).toEqual([
      "p",
      "li",
      "blockquote",
      "pre",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
    ]);
  });

  test("the restore needle is the anchor's first 60 characters, NOT truncated with an ellipsis", () => {
    // The needle is matched against a block's textContent, so an ellipsis would
    // make every long anchor unfindable and every chip an orphan.
    const long = "y".repeat(100);
    expect(anchorNeedle(long)).toBe("y".repeat(60));
    expect(anchorNeedle(long)).not.toContain("…");
    expect(anchorNeedle("short")).toBe("short");
  });
});
