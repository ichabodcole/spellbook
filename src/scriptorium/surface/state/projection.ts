// The rendered document's TEXT, and where every character of it came from
// (E51). This is what lets a selection made in the rendered view mean the same
// thing as one made in the raw view.
//
// ⛔ WHY A PROJECTION AND NOT A SEARCH. A selection in the rendered half is a
// run of RENDERED text: `**Maren's Bakery**` reaches the human as
// `Maren's Bakery`, and `[a](x.md)` as `a`. Searching the SOURCE for what the
// human selected therefore fails on exactly the documents this spell is for —
// Hollowbrook's relationship rows are bold-inside-a-link on every line, so the
// selected string does not occur in the source at all. The projection is the
// plain text the human actually sees, carrying a source span per segment, so
// the answer is a mapping rather than a guess.
//
// ⛔ AND IT IS BUILT BY THE RENDERER'S OWN PARSER. `mdast-util-from-markdown`
// wraps the same micromark this spell renders with, configured with the same
// GFM extension, so the projection cannot disagree with the rendered output
// about what is text and what is markup. The alternative considered was a
// hand-rolled inline stripper with no dependency — rejected because it is a
// SECOND partial markdown reader with nothing holding it level with the first,
// which is the lockstep-mirror drift `diff.ts` refuses for the same reason.
// (Cole accepted the two dependencies on that argument, 2026-09-14.)
//
// ⛔ IT LIVES IN THE SURFACE, BESIDE THE RENDERER IT DESCRIBES. The daemon has
// no use for it: the agent's `note --quote` resolves against the SOURCE and
// always did, so nothing on the wire changes for this feature. Putting it here
// also means the right-click menu resolves a passage in the same frame the
// human right-clicked it, rather than after a round trip.
//
// ⛔ OFFSETS HERE ARE WHOLE-FILE OFFSETS. The rendered view drops the
// frontmatter (E32) and the source does not, so a projection built from the
// body alone would be off by the length of the block for every document that
// has one. `project` takes the WHOLE text and adds that base back itself,
// because a call site that has to remember is a call site that will forget.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { splitFrontmatter } from "./markdown";

/**
 * One run of rendered text and the source it came from.
 *
 * `exact` says whether the mapping INSIDE the run is character-for-character.
 * It is for ordinary prose, and it is not for a construct whose rendered form
 * is shorter than its source — an inline code span (`` `code` `` is six
 * characters of source and four of text) or an escape (`\*` is two and one).
 * An offset inside a non-exact run resolves to the whole run rather than to a
 * character, which is the honest answer: there is no character to point at.
 */
export type ProjSegment = {
  plainFrom: number;
  plainTo: number;
  srcFrom: number;
  srcTo: number;
  exact: boolean;
};

/** The rendered text of a document, plus where each part of it came from. */
export type Projection = {
  /** What the human sees, as one string. */
  plain: string;
  /** In `plain` order, non-overlapping. */
  segments: ProjSegment[];
};

/**
 * Block boundaries the projection inserts, so that the last word of one block
 * and the first of the next do not read as one word.
 *
 * ⚠ THESE ARE SYNTHETIC — they are in `plain` and not in the source, which is
 * why a separator's segment is zero-width in source (`srcFrom === srcTo`) and
 * never `exact`. A selection that starts or ends inside one lands on the block
 * edge beside it.
 */
const TIGHT = new Set(["listItem", "tableCell", "tableRow"]);
const BLOCKS = new Set([
  "paragraph",
  "heading",
  "code",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "thematicBreak",
  "definition",
  "footnoteDefinition",
]);

type Node = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
};

/**
 * The rendered text of `text`, with a source span for every part of it.
 *
 * Only nodes that put CHARACTERS on the screen contribute: prose, code (inline
 * and block), a hard break, and raw HTML — which micromark encodes rather than
 * emits, so it reaches the human as the text it is. An image contributes
 * nothing, because its alt text is an attribute and cannot be selected.
 */
export function project(text: string): Projection {
  const body = splitFrontmatter(text).body;
  // The body starts after the frontmatter block; `splitFrontmatter` returns the
  // block's CONTENT, so the base is what the whole text lost, not what it kept.
  const base = text.length - body.length;
  const tree = fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Node;

  const segments: ProjSegment[] = [];
  let plain = "";
  /** The last block we emitted anything for, so a boundary is added once. */
  let pendingBoundary: { sep: string; at: number } | null = null;

  const flushBoundary = () => {
    if (!pendingBoundary || plain === "") {
      pendingBoundary = null;
      return;
    }
    const { sep, at } = pendingBoundary;
    pendingBoundary = null;
    const src = base + at;
    segments.push({
      plainFrom: plain.length,
      plainTo: plain.length + sep.length,
      srcFrom: src,
      srcTo: src,
      exact: false,
    });
    plain += sep;
  };

  const emit = (value: string, node: Node) => {
    if (value === "") return;
    flushBoundary();
    const s = node.position?.start.offset;
    const e = node.position?.end.offset;
    const srcFrom = base + (s ?? 0);
    const srcTo = base + (e ?? s ?? 0);
    segments.push({
      plainFrom: plain.length,
      plainTo: plain.length + value.length,
      srcFrom,
      srcTo,
      // 1:1 only when the source span is exactly as long as what it renders to.
      exact: srcTo - srcFrom === value.length,
    });
    plain += value;
  };

  const walk = (node: Node) => {
    // ⛔ THE OUTERMOST BOUNDARY WINS, which is why this only sets when none is
    // pending. A list item holds a paragraph, so walking `- a` fires `listItem`
    // (tight) and then `paragraph` (loose); letting the inner node overwrite
    // put a blank line between every list row. The transition the human sees is
    // the one they crossed at the top, not the one nested inside it.
    if (BLOCKS.has(node.type) && plain !== "" && pendingBoundary === null) {
      pendingBoundary = {
        sep: TIGHT.has(node.type) ? "\n" : "\n\n",
        at: node.position?.start.offset ?? 0,
      };
    }
    switch (node.type) {
      case "text":
      case "inlineCode":
      case "code":
      case "html":
        emit(node.value ?? "", node);
        return;
      case "break":
        emit("\n", node);
        return;
      case "image":
      case "imageReference":
      case "thematicBreak":
        return;
      default:
        break;
    }
    for (const child of node.children ?? []) walk(child);
  };

  for (const child of tree.children ?? []) walk(child);
  return { plain, segments };
}

/** The segment a `plain` offset falls in, or null when there is none. */
function segmentAt(p: Projection, at: number): ProjSegment | null {
  for (const seg of p.segments) if (at >= seg.plainFrom && at < seg.plainTo) return seg;
  return null;
}

/**
 * Where a run of rendered text is in the SOURCE.
 *
 * The start resolves forwards and the end backwards — the end is taken from the
 * segment holding the last selected character, not the one after it, so a
 * selection ending at a block edge does not swallow the next block's opening
 * markup.
 */
export function toSource(
  p: Projection,
  plainFrom: number,
  plainTo: number,
): { from: number; to: number } {
  const lo = Math.max(0, Math.min(plainFrom, p.plain.length));
  const hi = Math.max(lo, Math.min(plainTo, p.plain.length));
  const first = segmentAt(p, lo) ?? p.segments[0];
  const last = hi > lo ? (segmentAt(p, hi - 1) ?? first) : first;
  if (!first || !last) return { from: 0, to: 0 };
  const from = first.exact ? first.srcFrom + (lo - first.plainFrom) : first.srcFrom;
  const to = last.exact ? last.srcFrom + (hi - last.plainFrom) : last.srcTo;
  return { from, to: Math.max(from, to) };
}

/**
 * Where a run of SOURCE is in the rendered text — the direction a note
 * highlight needs, since a note's anchor is resolved against the source.
 *
 * Null when the range is entirely markup (a fence, a frontmatter key): there is
 * no rendered text to point at, which a caller must be able to tell apart from
 * "the start of the document".
 */
export function toPlain(
  p: Projection,
  srcFrom: number,
  srcTo: number,
): { from: number; to: number } | null {
  let first: ProjSegment | null = null;
  let last: ProjSegment | null = null;
  for (const seg of p.segments) {
    if (seg.srcTo <= srcFrom || seg.srcFrom >= srcTo) continue;
    if (seg.plainTo === seg.plainFrom) continue;
    if (!first) first = seg;
    last = seg;
  }
  if (!first || !last) return null;
  const from = first.exact
    ? first.plainFrom + Math.max(0, srcFrom - first.srcFrom)
    : first.plainFrom;
  const to = last.exact
    ? last.plainFrom + Math.min(last.plainTo - last.plainFrom, Math.max(0, srcTo - last.srcFrom))
    : last.plainTo;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

/**
 * Where each rendered text node begins in `plain` — the bridge between a DOM
 * selection and the projection.
 *
 * ⛔ A PROGRESSIVE SEARCH, NOT AN ASSUMED ALIGNMENT. The obvious approach is to
 * concatenate the container's text nodes and treat the result as `plain`. It is
 * wrong: micromark puts a newline between block tags, so `<p>a</p>\n<p>b</p>`
 * contributes a `"\n"` text node the projection wrote as `"\n\n"`, and every
 * offset after the first block is then off by one and drifting. Matching each
 * run forwards from a cursor instead cannot drift — the runs appear in `plain`
 * in document order, so a run is always found at or after the last one, and
 * inter-tag whitespace simply fails to match and is skipped.
 *
 * A run that cannot be placed gets `null` rather than a guess: it is either
 * whitespace the projection did not write, or text from something the
 * projection deliberately skipped (an image's alt attribute is not a text node,
 * but a future construct might be), and a wrong offset there would silently
 * anchor a note onto unrelated words.
 */
export function alignRuns(plain: string, runs: readonly string[]): (number | null)[] {
  const out: (number | null)[] = [];
  let cursor = 0;
  for (const run of runs) {
    if (run === "") {
      out.push(null);
      continue;
    }
    const at = plain.indexOf(run, cursor);
    if (at === -1) {
      out.push(null);
      continue;
    }
    out.push(at);
    cursor = at + run.length;
  }
  return out;
}

/**
 * The 1-based line a source offset is on — what the wire's `Selection` carries.
 * The raw view gets these from CodeMirror; the rendered view has to count.
 */
export function lineAt(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
