// A document's headings and the sections they head: where each ATX heading is,
// and the lines its section runs to. Shared by anything that asks "which part
// of this document is about X" (an app finding a world's open-questions
// sections, say). Pure string work, line-based like `markdownCode.ts`: no parse
// tree, so a backend or a surface can import it.
//
// A line counts as a heading only outside the frontmatter block and outside
// code, so a YAML `# comment` or a `# shell comment` in a fenced block is never
// one. Line numbers are the FILE's, 1-based, frontmatter counted, as a link's
// `line` and a search hit's are.

import { splitFrontmatter } from "./frontmatter.ts";
import { codeBlockLines } from "./markdownCode.ts";

/** One heading, and the section under it. */
export type Heading = {
  /** 1 for `#`, up to 6. */
  level: number;
  /** The heading's text, without its marks or a closing `#` run. */
  text: string;
  /** The 1-based line of the file it is on. */
  line: number;
  /**
   * The last line of its section: the line before the next heading at its
   * level or above, or the file's last line. Sub-headings sit inside it.
   */
  end: number;
};

/** An ATX heading: up to three spaces, one to six `#`, then a space or the end. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/** A setext underline: up to three spaces, then a run of `=` or of `-`, nothing after. */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** A thematic break (`***`, `- - -`, `___`). */
const BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** Lines that start a block other than a paragraph: a list item, a quote, an HTML block, a table row. */
const OTHER_BLOCK = /^ {0,3}(?:[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|<|\|)/;

/** Can this line start a paragraph? */
const opensParagraph = (line: string) =>
  line.trim() !== "" && !/^(?: {4}|\t)/.test(line) && !BREAK.test(line) && !OTHER_BLOCK.test(line);

/** Does this line carry on the paragraph above it, rather than start a block that ends it? */
const continuesParagraph = (line: string) =>
  line.trim() !== "" && !BREAK.test(line) && !OTHER_BLOCK.test(line);

/**
 * Every heading in `text`, in order, each with where its section ends: ATX
 * headings (`## Title`) and setext ones (a paragraph underlined with `===` or
 * `---`). A setext heading's `line` is its text's first line.
 */
export function headingsOf(text: string): Heading[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const { bodyStart } = splitFrontmatter(text);
  // The frontmatter's own lines: everything before the body's first line.
  const skip = bodyStart === 0 ? 0 : text.slice(0, bodyStart).split("\n").length - 1;
  const code = codeBlockLines(lines.slice(skip));
  const found: Omit<Heading, "end">[] = [];
  /** The first line of the paragraph running up to line `i`, or -1 when `i` is not paragraph text. */
  let paraStart = -1;
  for (let i = skip; i < lines.length; i++) {
    const line = lines[i] as string;
    if (code.has(i - skip)) {
      paraStart = -1;
      continue;
    }
    const m = ATX.exec(line);
    if (m) {
      found.push({ level: (m[1] as string).length, text: (m[2] ?? "").trim(), line: i + 1 });
      paraStart = -1;
      continue;
    }
    // A setext heading: paragraph text underlined with `=` (level 1) or `-`
    // (level 2). The paragraph is the heading, all its lines; a `---` after a
    // paragraph is this, not a thematic break, as CommonMark has it. The
    // frontmatter's own `---` lines were skipped above.
    const under = SETEXT.exec(line);
    if (under && paraStart !== -1) {
      const text = lines
        .slice(paraStart, i)
        .map((l) => l.trim())
        .join(" ")
        .trim();
      found.push({ level: (under[1] as string)[0] === "=" ? 1 : 2, text, line: paraStart + 1 });
      paraStart = -1;
      continue;
    }
    if (paraStart === -1 && opensParagraph(line)) paraStart = i;
    else if (paraStart !== -1 && line.trim() === "") paraStart = -1;
    else if (paraStart !== -1 && !continuesParagraph(line)) paraStart = -1;
  }
  found.sort((a, b) => a.line - b.line);
  // A file that ends in a line break has an empty last "line" after it.
  const last = lines.length > 1 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
  return found.map((h, k) => {
    const next = found.slice(k + 1).find((n) => n.level <= h.level);
    return { ...h, end: next ? next.line - 1 : last };
  });
}

/** The headings whose text `pattern` matches, each with its section's extent. */
export function sectionsMatching(text: string, pattern: RegExp): Heading[] {
  return headingsOf(text).filter((h) => {
    pattern.lastIndex = 0;
    return pattern.test(h.text);
  });
}

/** The heading whose section holds `line` most closely (the deepest one), or null above the first. */
export function headingAt(headings: readonly Heading[], line: number): Heading | null {
  let best: Heading | null = null;
  for (const h of headings)
    if (h.line <= line && line <= h.end && (best === null || h.level >= best.level)) best = h;
  return best;
}
