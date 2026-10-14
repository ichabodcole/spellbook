// The one rule for what counts as a document's frontmatter block, shared by
// everything that must agree on it: the rendered view (which draws the block as a
// header and skips it in the projection) and an app's backend (which, say, leaves
// it out of what is spoken). Two rules would disagree on exactly the documents
// where it matters: one would speak what the other hides.
//
// Pure string work, no YAML and no React, so a backend can import it.

/**
 * A frontmatter block: `---` on its own first line (trailing spaces allowed), to
 * the next `---` line. It counts only when its first non-empty line looks like a
 * YAML key (`key:`), so prose between two scene-break rules at the top of a story
 * stays prose. A block that opens with a key line and then breaks is still
 * frontmatter, just malformed; one that never closes is not frontmatter at all.
 */
export const FRONTMATTER_BLOCK =
  /^---[ \t]*\r?\n(?=(?:[ \t]*\r?\n)*[A-Za-z_][\w-]*[ \t]*:)([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split a document into its frontmatter block and the body beneath it. `raw` is
 * the block's content (between the delimiters), null when there is no block;
 * `bodyStart` is where the body begins in the whole text, so a body offset plus
 * `bodyStart` is a whole-text offset.
 */
export function splitFrontmatter(text: string): {
  raw: string | null;
  body: string;
  bodyStart: number;
} {
  const m = FRONTMATTER_BLOCK.exec(text);
  if (!m) return { raw: null, body: text, bodyStart: 0 };
  return { raw: m[1] ?? "", body: text.slice(m[0].length), bodyStart: m[0].length };
}
