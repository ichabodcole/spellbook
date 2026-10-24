// The rendered document's text, and where every character of it came from.
// This is what lets a selection made in the rendered view mean the same thing as
// one made in the raw view: source offsets, which the chat attaches and a note
// anchors to.
//
// WHY A PROJECTION AND NOT A SEARCH. A selection in the rendered view is a run of
// RENDERED text: `**Maren's Bakery**` reaches the reader as `Maren's Bakery`, and
// `[a](x.md)` as `a`. Searching the source for what was selected fails on exactly
// the text this app edits (bold inside a link, on every line of a list), so the
// projection is the plain text the reader sees, carrying a source span per
// segment, and the answer is a mapping rather than a guess.
//
// IT IS BUILT BY THE RENDERER'S OWN PARSER. `mdast-util-from-markdown` wraps the
// same micromark the kit renders with, configured with the same GFM extension, so
// the projection cannot disagree with the rendered output about what is text and
// what is markup. A hand-rolled inline stripper would be a second, partial
// markdown reader with nothing holding it level with the first.
//
// OFFSETS ARE WHOLE-TEXT OFFSETS. The rendered view drops a frontmatter block (it
// becomes the header, outside the projected text) and the source does not, so a
// projection of the body alone would be off by the block's length for every
// document that has one. `project` takes the whole text and adds that base back
// itself, because a call site that has to remember is a call site that will forget.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { splitFrontmatter } from "../lib/frontmatter.ts";

/**
 * One run of rendered text and the source it came from. `exact` says whether the
 * mapping inside the run is character for character: it is for ordinary prose, and
 * it is not for a construct whose rendered form is shorter than its source (an
 * inline code span, an escape). An offset inside a non-exact run resolves to the
 * whole run, which is the honest answer: there is no character to point at.
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
  plain: string;
  /** In `plain` order, non-overlapping. */
  segments: ProjSegment[];
};

/**
 * Block boundaries the projection inserts so the last word of one block and the
 * first of the next do not read as one word. They are in `plain` and not in the
 * source, so a separator's segment is zero-width in source and never `exact`: a
 * selection that starts or ends inside one lands on the block edge beside it.
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
 * The rendered text of a document, with a WHOLE-TEXT source span for every part of
 * it. A leading frontmatter block is not rendered text (the header draws it), so
 * nothing in it is projected and every offset after it carries its length.
 */
export function project(text: string): Projection {
  const { body, bodyStart } = splitFrontmatter(text);
  const p = projectBody(body);
  if (bodyStart === 0) return p;
  return {
    plain: p.plain,
    segments: p.segments.map((s) => ({
      ...s,
      srcFrom: s.srcFrom + bodyStart,
      srcTo: s.srcTo + bodyStart,
    })),
  };
}

/**
 * The rendered text of `text`, with a source span for every part of it. Only nodes
 * that put characters on the screen contribute: prose, code (inline and block), a
 * hard break, and raw HTML, which micromark encodes rather than emits. An image
 * contributes nothing, because its alt text is an attribute and cannot be selected.
 */
function projectBody(text: string): Projection {
  const tree = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Node;

  const segments: ProjSegment[] = [];
  let plain = "";
  let pendingBoundary: { sep: string; at: number } | null = null;

  const flushBoundary = () => {
    if (!pendingBoundary || plain === "") {
      pendingBoundary = null;
      return;
    }
    const { sep, at } = pendingBoundary;
    pendingBoundary = null;
    segments.push({
      plainFrom: plain.length,
      plainTo: plain.length + sep.length,
      srcFrom: at,
      srcTo: at,
      exact: false,
    });
    plain += sep;
  };

  const emit = (raw: string, node: Node) => {
    if (raw === "") return;
    // The page holds one character for each `\r\n` (HTML parsing makes it `\n`),
    // so the plain text does too, or every character after one is misaligned.
    // Shorter than its source, the run is then not exact.
    const value = raw.includes("\r\n") ? raw.replaceAll("\r\n", "\n") : raw;
    flushBoundary();
    const s = node.position?.start.offset;
    const e = node.position?.end.offset;
    const srcFrom = s ?? 0;
    const srcTo = e ?? s ?? 0;
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

  /**
   * Prose, split at its line breaks when the source carries markup on each line. A
   * wrapped list item or quote is not one run: its source repeats the indent or the
   * `> ` on every line and its rendered text does not, so the text node is longer
   * in source than on screen. Each line of the value is found in the source in
   * turn and emitted exactly, the line break with it; if any line cannot be found
   * (an escape, an entity), the node falls back to one non-exact run.
   */
  const emitText = (raw: string, node: Node) => {
    // A CRLF file's prose: each `\r\n` is one `\n` on the page, and the lines
    // between are found and emitted exactly, as a wrapped list item's are.
    const value = raw.includes("\r\n") ? raw.replaceAll("\r\n", "\n") : raw;
    const s = node.position?.start.offset;
    const e = node.position?.end.offset;
    if (s === undefined || e === undefined || e - s === value.length || !value.includes("\n")) {
      emit(value, node);
      return;
    }
    const pieces: { value: string; at: number }[] = [];
    let cursor = s;
    const lines = value.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const at = line === "" ? cursor : text.indexOf(line, cursor);
      if (at === -1 || at + line.length > e || (i === 0 && at !== s)) {
        emit(value, node);
        return;
      }
      if (line !== "") pieces.push({ value: line, at });
      cursor = at + line.length;
      if (i < lines.length - 1) {
        const nl = text.indexOf("\n", cursor);
        if (nl === -1 || nl >= e) {
          emit(value, node);
          return;
        }
        pieces.push({ value: "\n", at: nl });
        cursor = nl + 1;
      }
    }
    for (const piece of pieces)
      emit(piece.value, {
        type: "text",
        position: { start: { offset: piece.at }, end: { offset: piece.at + piece.value.length } },
      });
  };

  const walk = (node: Node) => {
    // The outermost boundary wins, so a boundary is only set when none is pending:
    // a list item holds a paragraph, and the inner node must not turn a tight list
    // into a loose one.
    if (BLOCKS.has(node.type) && plain !== "" && pendingBoundary === null) {
      pendingBoundary = {
        sep: TIGHT.has(node.type) ? "\n" : "\n\n",
        at: node.position?.start.offset ?? 0,
      };
    }
    switch (node.type) {
      case "text":
        emitText(node.value ?? "", node);
        return;
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
 * Where a run of rendered text is in the source. The start resolves forwards and
 * the end backwards: the end is taken from the segment holding the last selected
 * character, not the one after it, so a selection ending at a block edge does not
 * swallow the next block's opening markup.
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
 * Where a run of source is in the rendered text: the direction a note highlight
 * needs, since a note's anchor is resolved against the source. Null when the range
 * is entirely markup (a fence), which a caller must be able to tell apart from "the
 * start of the document".
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
 * Where a rendered text node begins in `plain`, as a pair: `at` is where the run's
 * first projected character is, and `lead` is how many of its leading characters
 * have no place in `plain` (whitespace the DOM has and the projection never wrote;
 * every one of them resolves to where the run's text starts).
 */
export type RunPlacement = { at: number; lead: number };

/** Where character `within` of a placed run is in `plain`. */
export function runOffset(placement: RunPlacement, within: number): number {
  return placement.at + Math.max(0, within - placement.lead);
}

/**
 * Where each rendered text node begins in `plain`: the bridge between a DOM
 * selection and the projection. A progressive search, not an assumed alignment:
 * micromark puts a newline between block tags where the projection writes two, so
 * concatenating the text nodes drifts. Matching each run forward from a cursor
 * keeps the runs in document order, and two rules keep one bad match from
 * stranding every run after it.
 *
 * 1. Inter-tag whitespace is placed only where the cursor already is. A
 *    whitespace-only run that is not sitting at the cursor is null and moves
 *    nothing: it has no text a selection could be about anyway.
 * 2. A match that skips text must be confirmed by the next run. Normally the gap
 *    between the cursor and the match is whitespace; when it is not, either an
 *    earlier run failed to place or this run is text the projection never wrote
 *    that happens to occur later. The next run tells them apart.
 *
 * A run is matched on its trimmed text. A run that cannot be placed gets null
 * rather than a guess: a wrong offset would silently anchor a note onto unrelated
 * words.
 */
export function alignRuns(plain: string, runs: readonly string[]): (RunPlacement | null)[] {
  const cores = runs.map((r) => r.trim());
  const out: (RunPlacement | null)[] = [];
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] as string;
    const core = cores[i] as string;
    if (core === "") {
      if (run !== "" && plain.startsWith(run, cursor)) {
        out.push({ at: cursor, lead: 0 });
        cursor += run.length;
      } else out.push(null);
      continue;
    }
    const found = plain.indexOf(core, cursor);
    if (
      found === -1 ||
      (/\S/.test(plain.slice(cursor, found)) && !confirmed(plain, found + core.length, cores, i))
    ) {
      out.push(null);
      continue;
    }
    // Back off over the leading whitespace `plain` actually has; the rest is the
    // DOM's alone and resolves to where the text begins.
    const wanted = run.length - run.trimStart().length;
    let back = 0;
    while (back < wanted && plain[found - back - 1] === run[wanted - back - 1]) back++;
    out.push({ at: found - back, lead: wanted - back });
    cursor = found + core.length;
  }
  return out;
}

/** Rule 2: does the next run with text in it begin right after `end`? */
function confirmed(plain: string, end: number, cores: readonly string[], i: number): boolean {
  let j = i + 1;
  while (j < cores.length && cores[j] === "") j++;
  const next = cores[j];
  // The last run has nothing to be confirmed by; take the match.
  if (next === undefined) return true;
  let k = end;
  while (k < plain.length && /\s/.test(plain[k] as string)) k++;
  return plain.startsWith(next, k);
}

/** The 1-based line a source offset is on: what the wire's selection carries. */
export function lineAt(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
