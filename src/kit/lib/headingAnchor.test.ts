// The heading-anchor convention (kit-heading-links): which heading an anchor
// finds, and which anchor a link to a heading is written with. The headings are
// the shapes the Dreamwood bible's own take: emphasis, an em dash, parentheses,
// a slash, a colon, and `Stacking lenses` twice under different sections.
import { describe, expect, test } from "bun:test";
import {
  anchorFor,
  anchorHref,
  anchorSubpath,
  findHeading,
  githubSlug,
  githubSlugs,
  headingPlainText,
  lineRange,
  nearestHeading,
} from "./headingAnchor.ts";
import { headingsOf } from "./headings.ts";
import { decodePath, splitTarget } from "./linkTarget.ts";

const DOC = [
  "# Touchstones", // 1
  "## Voice and language", // 2
  "### *The Once and Future King* — T. H. White", // 3
  "## Ritual, ceremony, and the technology of repetition", // 4
  "### The chakra tradition (structural inheritance)", // 5
  "### *A Voyage to Arcturus* — David Lindsay", // 6
  "## How lenses work", // 7
  "### Direction 1: experience → lens", // 8
  "### Stacking lenses", // 9
  "## The lenses", // 10
  "### The chakra / body-passage lens", // 11
  "## Methodology: how to actually use lenses", // 12
  "### Stacking lenses", // 13
  "### `code` and __strong__ and snake_case and \\*star\\*", // 14
  "",
].join("\n");
const H = headingsOf(DOC);
const at = (line: number) => H.findIndex((h) => h.line === line);
const found = (anchor: string) => findHeading(H, anchor);

describe("a heading's text without its markup", () => {
  test("emphasis, code and escapes go; a word's own underscore and an escaped star stay", () => {
    expect(headingPlainText("*A Voyage to Arcturus* — David Lindsay")).toBe(
      "A Voyage to Arcturus — David Lindsay",
    );
    expect(headingPlainText("`code` and __strong__ and snake_case and \\*star\\*")).toBe(
      "code and strong and snake_case and *star*",
    );
    expect(headingPlainText("See [the Glade](./the-glade.md) and [[the-ruin|the Ruin]]")).toBe(
      "See the Glade and the Ruin",
    );
    expect(headingPlainText("  two   spaces  ")).toBe("two spaces");
  });
});

describe("GitHub slugs", () => {
  test("punctuation goes, spaces become hyphens, an em dash leaves a double hyphen", () => {
    expect(githubSlug("A Voyage to Arcturus — David Lindsay")).toBe(
      "a-voyage-to-arcturus--david-lindsay",
    );
    expect(githubSlug("The chakra / body-passage lens")).toBe("the-chakra--body-passage-lens");
    expect(githubSlug("Direction 1: experience → lens")).toBe("direction-1-experience--lens");
  });

  test("a repeat is numbered from 1, and a number taken by a real heading moves on", () => {
    expect(githubSlugs(H)[at(9)]).toBe("stacking-lenses");
    expect(githubSlugs(H)[at(13)]).toBe("stacking-lenses-1");
    const clash = headingsOf("# a\n# a-1\n# a\n");
    expect(githubSlugs(clash)).toEqual(["a", "a-1", "a-2"]);
  });
});

describe("finding a heading", () => {
  test("rule 1: the exact text, emphasis aside", () => {
    expect(found("A Voyage to Arcturus — David Lindsay")).toEqual({
      heading: H[at(6)] as (typeof H)[number],
      index: at(6),
      rule: "text",
    });
    expect(found("The chakra tradition (structural inheritance)")?.heading.line).toBe(5);
    expect(found("The chakra / body-passage lens")?.heading.line).toBe(11);
    expect(found("Direction 1: experience → lens")?.heading.line).toBe(8);
    expect(found("The Once and Future King — T. H. White")?.heading.line).toBe(3);
  });

  test("rule 2: case and whitespace aside", () => {
    const m = found("a voyage to  ARCTURUS — david lindsay");
    expect(m?.heading.line).toBe(6);
    expect(m?.rule).toBe("folded");
  });

  test("rule 3: the GitHub slug, numbered", () => {
    expect(found("a-voyage-to-arcturus--david-lindsay")?.heading.line).toBe(6);
    expect(found("the-chakra--body-passage-lens")).toMatchObject({ rule: "slug" });
    expect(found("stacking-lenses-1")?.heading.line).toBe(13);
    expect(found("stacking-lenses")?.heading.line).toBe(9);
  });

  test("rule 4: a path of headings, each inside the one before", () => {
    const m = found("Methodology: how to actually use lenses#Stacking lenses");
    expect(m).toMatchObject({ rule: "path" });
    expect(m?.heading.line).toBe(13);
    expect(found("How lenses work#Stacking lenses")?.heading.line).toBe(9);
    expect(found("Touchstones#How lenses work#stacking lenses")?.heading.line).toBe(9);
    // A part outside the section before it is not found there.
    expect(found("The lenses#Direction 1: experience → lens")).toBeNull();
  });

  test("a bare duplicate lands on the first and says it is ambiguous", () => {
    const m = found("Stacking lenses");
    expect(m?.heading.line).toBe(9);
    expect(m?.ambiguous).toBe(true);
  });

  test("a written link's anchor, decoded, finds its heading; a board's subpath too", () => {
    const raw =
      "./00-touchstones.md?rel=grounded-in#A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay";
    const { anchor } = splitTarget(raw);
    expect(found(decodePath(anchor ?? ""))?.heading.line).toBe(6);
    expect(found("#A Voyage to Arcturus — David Lindsay")?.heading.line).toBe(6);
  });

  test("nothing, an empty anchor, or a heading that is not there", () => {
    expect(found("")).toBeNull();
    expect(found("#")).toBeNull();
    expect(found("A Voyage to Arcturus")).toBeNull();
  });
});

describe("the anchor to write", () => {
  test("a unique heading is its text, encoded only where a link needs it", () => {
    const parts = anchorFor(H, at(6));
    expect(parts).toEqual(["A Voyage to Arcturus — David Lindsay"]);
    expect(anchorHref(parts)).toBe("A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay");
    expect(anchorSubpath(parts)).toBe("#A Voyage to Arcturus — David Lindsay");
    expect(anchorHref(anchorFor(H, at(5)))).toBe(
      "The%20chakra%20tradition%20%28structural%20inheritance%29",
    );
    expect(anchorHref(anchorFor(H, at(11)))).toBe("The%20chakra%20/%20body-passage%20lens");
    expect(anchorHref(anchorFor(H, at(8)))).toBe("Direction%201:%20experience%20→%20lens");
  });

  test("a repeated heading is written as the path that names it alone", () => {
    expect(anchorFor(H, at(9))).toEqual(["How lenses work", "Stacking lenses"]);
    expect(anchorFor(H, at(13))).toEqual([
      "Methodology: how to actually use lenses",
      "Stacking lenses",
    ]);
    expect(anchorHref(anchorFor(H, at(9)))).toBe("How%20lenses%20work#Stacking%20lenses");
    expect(anchorSubpath(anchorFor(H, at(13)))).toBe(
      "#Methodology: how to actually use lenses#Stacking lenses",
    );
  });

  test("every anchor written reads back to its own heading, unambiguously", () => {
    H.forEach((_h, i) => {
      const href = anchorHref(anchorFor(H, i));
      const m = findHeading(H, decodePath(href));
      expect(m?.index).toBe(i);
      expect(m?.ambiguous).toBeUndefined();
    });
  });

  test("twins under twins fall back to the numbered slug", () => {
    const twins = headingsOf("# A\n## B\n# A\n## B\n");
    expect(anchorFor(twins, 3)).toEqual(["b-1"]);
    expect(findHeading(twins, "b-1")?.index).toBe(3);
  });
});

describe("a repeated one-word heading", () => {
  // Its slug is unique per heading (`notes`, `notes-1`), which must not make the
  // bare text read as unique.
  const N = headingsOf("# Places\n## Notes\n# People\n## Notes\n");
  test("the bare text is ambiguous", () => {
    expect(findHeading(N, "Notes")).toMatchObject({ index: 1, ambiguous: true });
    // Lower-cased, it is the first one's slug, which names it alone.
    expect(findHeading(N, "notes")).toMatchObject({ index: 1, rule: "slug" });
    expect(findHeading(N, "notes")?.ambiguous).toBeUndefined();
  });
  test("each is written as its parent's path, which reads back to it alone", () => {
    expect(anchorFor(N, 1)).toEqual(["Places", "Notes"]);
    expect(anchorFor(N, 3)).toEqual(["People", "Notes"]);
    expect(findHeading(N, "People#Notes")).toMatchObject({ index: 3, rule: "path" });
    expect(findHeading(N, "People#Notes")?.ambiguous).toBeUndefined();
  });
  test("the numbered slug still names the second", () => {
    expect(findHeading(N, "notes-1")?.index).toBe(3);
  });
});

describe("repeats with no parent to tell them apart", () => {
  // The anchor written for each is its numbered slug; reading it back must not
  // call it a duplicate just because its case-folded text names both.
  const SAME_PARENT = headingsOf("# Dups\n## Summary\n## Summary\n");
  const TOP_LEVEL = headingsOf("## Notes\n## Other\n## Notes\n");
  test("each is written as its slug, which reads back to it alone", () => {
    expect(anchorFor(SAME_PARENT, 1)).toEqual(["summary"]);
    expect(anchorFor(SAME_PARENT, 2)).toEqual(["summary-1"]);
    expect(anchorFor(TOP_LEVEL, 0)).toEqual(["notes"]);
    expect(anchorFor(TOP_LEVEL, 2)).toEqual(["notes-1"]);
    expect(findHeading(SAME_PARENT, "summary")).toEqual({
      heading: SAME_PARENT[1] as (typeof SAME_PARENT)[number],
      index: 1,
      rule: "slug",
    });
    expect(findHeading(TOP_LEVEL, "notes-1")).toMatchObject({ index: 2 });
    expect(findHeading(TOP_LEVEL, "notes-1")?.ambiguous).toBeUndefined();
  });
  test("the bare text is still a duplicate", () => {
    expect(findHeading(SAME_PARENT, "Summary")).toMatchObject({ index: 1, ambiguous: true });
    expect(findHeading(TOP_LEVEL, "Notes")).toMatchObject({ index: 0, ambiguous: true });
  });
});

test("every anchor written in these fixtures reads back to its own heading, unambiguously", () => {
  const fixtures = [
    H,
    headingsOf("# Places\n## Notes\n# People\n## Notes\n"),
    headingsOf("# A\n## B\n# A\n## B\n"),
    headingsOf("# Dups\n## Summary\n## Summary\n"),
    headingsOf("## Notes\n## Other\n## Notes\n"),
  ];
  for (const hs of fixtures)
    hs.forEach((_h, i) => {
      const m = findHeading(hs, decodePath(anchorHref(anchorFor(hs, i))));
      expect(m?.index).toBe(i);
      expect(m?.ambiguous).toBeUndefined();
    });
});

test("a repeated heading whose text is already its slug lands on its own, though flagged", () => {
  // `# a` twice: the first's slug is `a`, which is also both texts, so the
  // anchor for it reads as the repeated text; it still lands on the first.
  const hs = headingsOf("# a\n# a-1\n# a\n");
  hs.forEach((_h, i) => {
    expect(findHeading(hs, decodePath(anchorHref(anchorFor(hs, i))))?.index).toBe(i);
  });
});

describe("the nearest heading to one that is not there", () => {
  test("a shortened or reworded heading finds the one it likely became", () => {
    expect(nearestHeading(H, "A Voyage to Arcturus")?.line).toBe(6);
    expect(nearestHeading(H, "The chakra/body passage lens")?.line).toBe(11);
    expect(nearestHeading(H, "a-voyage-to-arcturus")?.line).toBe(6);
  });

  test("nothing close enough is nothing", () => {
    expect(nearestHeading(H, "Zebra crossings")).toBeNull();
    expect(nearestHeading(H, "")).toBeNull();
  });
});

test("a line's range, its break left out", () => {
  const text = "# A\r\nbody\n## B";
  expect(lineRange(text, 1)).toEqual({ from: 0, to: 3 });
  expect(lineRange(text, 3)).toEqual({ from: 10, to: 14 });
  expect(lineRange(text, 9)).toEqual({ from: 14, to: 14 });
});
