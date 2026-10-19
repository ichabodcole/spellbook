// The shipped surface's frontmatter splitter against the daemon's. The reader
// itself moved to the kit path with its tests (`kit/frontmatter.test.ts`,
// scriptorium-kit-keepers); this cell stays with the shipped surface, whose
// renderer it guards, and goes with it at the cutover.
import { describe, expect, test } from "bun:test";
import { splitFrontmatter as splitInSurface } from "../surface/state/markdown";
import { splitFrontmatter } from "./frontmatter";

const doc = (fm: string, body = "# Title\n\nProse.\n") => `---\n${fm}\n---\n${body}`;

describe("splitting", () => {
  test("⛔ the SURFACE's splitter agrees with this one — it strips the block before rendering", () => {
    for (const text of [
      doc("type: research\ntags: [a]"),
      "# No frontmatter\n",
      "---\n\n---\nempty block\n",
      "Prose first\n---\nnot: frontmatter\n---\n",
      "---\r\ntype: x\r\n---\r\ncrlf body\r\n",
      "---\ntype: unterminated\n",
    ]) {
      const mine = splitFrontmatter(text);
      const theirs = splitInSurface(text);
      expect([theirs.raw, theirs.body]).toEqual([mine.raw, mine.body]);
    }
  });
});
