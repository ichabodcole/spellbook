// A document's headings and their sections: what an app reads to find the part
// of a document about something (a world's "Open questions", say).
import { describe, expect, test } from "bun:test";
import { headingAt, headingsOf, sectionsMatching } from "./headings.ts";

const DOC = [
  "---", // 1
  "title: A", // 2
  "# not a heading: a YAML comment", // 3
  "---", // 4
  "# A", // 5
  "", // 6
  "## Part one", // 7
  "text", // 8
  "### Deeper", // 9
  "```sh", // 10
  "# a shell comment", // 11
  "```", // 12
  "## Open questions ##", // 13
  "- one?", // 14
  "#hashtag is not a heading", // 15
  "## Open questions for the rest", // 16
  "- two?", // 17
  "", // 18
].join("\n");

describe("headings", () => {
  test("every ATX heading outside the frontmatter and code, with the file's line and where its section ends", () => {
    expect(headingsOf(DOC)).toEqual([
      { level: 1, text: "A", line: 5, end: 17 },
      { level: 2, text: "Part one", line: 7, end: 12 },
      { level: 3, text: "Deeper", line: 9, end: 12 },
      { level: 2, text: "Open questions", line: 13, end: 15 },
      { level: 2, text: "Open questions for the rest", line: 16, end: 17 },
    ]);
  });

  test("a document with no frontmatter counts from its first line, and an empty heading is one", () => {
    expect(headingsOf("#\ntext\n## B")).toEqual([
      { level: 1, text: "", line: 1, end: 3 },
      { level: 2, text: "B", line: 3, end: 3 },
    ]);
  });

  test("sections matching a pattern, a global pattern read from its start each time", () => {
    const re = /^open questions/gi;
    expect(sectionsMatching(DOC, re).map((h) => h.line)).toEqual([13, 16]);
    expect(sectionsMatching(DOC, re).map((h) => h.line)).toEqual([13, 16]);
    expect(sectionsMatching(DOC, /^nothing/)).toEqual([]);
  });

  test("the deepest heading holding a line, or none above the first", () => {
    const hs = headingsOf(DOC);
    expect(headingAt(hs, 11)?.text).toBe("Deeper");
    expect(headingAt(hs, 8)?.text).toBe("Part one");
    expect(headingAt(hs, 14)?.text).toBe("Open questions");
    expect(headingAt(hs, 2)).toBeNull();
  });
});

describe("setext headings", () => {
  const SETEXT_DOC = [
    "---", // 1
    "title: S", // 2
    "---", // 3
    "The Title", // 4
    "=========", // 5
    "", // 6
    "A paragraph that", // 7
    "runs on", // 8
    "---", // 9
    "", // 10
    "---", // 11: a thematic break, no paragraph above it
    "", // 12
    "- a list item", // 13
    "---", // 14: after a list, not a heading
    "", // 15
    "```", // 16
    "In code", // 17
    "---", // 18
    "```", // 19
    "", // 20
    "> quoted", // 21
    "===", // 22: a lazy line of the quote, not a heading
    "", // 23
    "## ATX after", // 24
    "",
  ].join("\n");

  test("a paragraph underlined with = or - is a heading, all its lines; frontmatter, breaks, lists, quotes and code are not", () => {
    expect(headingsOf(SETEXT_DOC).map((h) => [h.level, h.text, h.line])).toEqual([
      [1, "The Title", 4],
      [2, "A paragraph that runs on", 7],
      [2, "ATX after", 24],
    ]);
  });

  test("its section runs to the next heading at its level or above", () => {
    const hs = headingsOf(SETEXT_DOC);
    expect(hs[0]?.end).toBe(24);
    expect(hs[1]?.end).toBe(23);
  });

  test("a document that is only frontmatter and a break has none", () => {
    expect(headingsOf("---\na: 1\n---\n\n---\n")).toEqual([]);
  });
});
