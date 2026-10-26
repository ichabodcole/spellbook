// Where markdown text is code: fenced blocks, indented blocks and inline spans.
// Shared by the daemon (a `?rel=` in code is an example, not a use) and the
// raw editor (`](` typed in code is code, not a link). The editor's half is
// line-based and deliberately small: the raw view has a stream tokenizer, not a
// parse tree, and only the text up to the caret is known while typing.
// `maskCode`, for a whole text, asks micromark instead (see below).

import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^( {4}|\t)/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const BLANK = /^\s*$/;
/** A blockquote's markers at the start of a line, nested or not. */
const QUOTE = /^ {0,3}(?:> ?)+/;
/** A fence at any indentation, for a list item's content or a quote's. */
const FENCE_ANY = /^\s*(`{3,}|~{3,})/;

/**
 * The fence a line opens or closes, if any, and what follows it. Inside a
 * quote the `>` markers are read past, and inside a list item (or a quote) the
 * fence may be indented to the item's content, past the three spaces a
 * top-level fence allows.
 */
function fenceOf(line: string, nested: boolean): { marker: string; rest: string } | null {
  const q = QUOTE.exec(line);
  const body = q ? line.slice(q[0].length) : line;
  const m = (q || nested ? FENCE_ANY : FENCE).exec(body);
  return m ? { marker: m[1] as string, rest: body.slice(m[0].length) } : null;
}

/**
 * The indices of the lines inside a code block: a fenced block with its fence
 * lines, or an indented block (four spaces or a tab, opened after a blank line
 * and not continuing a list). A fence counts inside a list item (indented to
 * its content) and inside a blockquote. An unclosed fence runs to the end, as
 * markdown reads it.
 */
export function codeBlockLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  let fence: string | null = null;
  let inList = false;
  let indented = false;
  let prevBlank = true;
  lines.forEach((line, i) => {
    if (fence !== null) {
      out.add(i);
      const m = fenceOf(line, true);
      if (m && m.marker[0] === fence[0] && m.marker.length >= fence.length && BLANK.test(m.rest))
        fence = null;
      return;
    }
    const blank = BLANK.test(line);
    if (indented && (blank || INDENTED.test(line))) {
      out.add(i);
      prevBlank = blank;
      return;
    }
    indented = false;
    const f = fenceOf(line, inList);
    if (f) {
      fence = f.marker;
      out.add(i);
      prevBlank = false;
      return;
    }
    if (!blank && INDENTED.test(line) && prevBlank && !inList) {
      indented = true;
      out.add(i);
      prevBlank = false;
      return;
    }
    if (!blank && !INDENTED.test(line)) inList = LIST_ITEM.test(line) || (inList && !prevBlank);
    prevBlank = blank;
  });
  return out;
}

/** Inline code spans in a line, as `[from, to)` ranges; an unclosed run is not a span. */
function inlineSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const runs = [...line.matchAll(/(?<!\\)`+/g)].map((m) => ({
    at: m.index as number,
    len: m[0].length,
  }));
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i] as { at: number; len: number };
    const close = runs.slice(i + 1).findIndex((r) => r.len === open.len);
    if (close === -1) continue;
    const end = runs[i + 1 + close] as { at: number; len: number };
    spans.push([open.at, end.at + end.len]);
    i += 1 + close;
  }
  return spans;
}

/**
 * Is the text just before the end of `lineBefore` inside an inline code span?
 * Only what precedes the caret is known while typing, so an opening run with
 * no close yet counts: `` `a ]( `` is code being written.
 */
export function inInlineCode(lineBefore: string): boolean {
  const runs = [...lineBefore.matchAll(/(?<!\\)`+/g)].map((m) => m[0].length);
  let open: number | null = null;
  for (const len of runs) {
    if (open === null) open = len;
    else if (len === open) open = null;
  }
  return open !== null;
}

/** `text` with its code removed: code blocks become blank lines, inline spans become nothing. */
export function withoutCode(text: string): string {
  const lines = text.split("\n");
  const blocks = codeBlockLines(lines);
  return lines
    .map((line, i) => {
      if (blocks.has(i)) return "";
      let out = "";
      let at = 0;
      for (const [from, to] of inlineSpans(line)) {
        out += line.slice(at, from);
        at = to;
      }
      return out + line.slice(at);
    })
    .join("\n");
}

// ── where a whole text is code, asked of the renderer's parser ─────────────
//
// ⛔ ASKED OF THE PARSER THE VIEW RENDERS WITH, NOT GUESSED LINE BY LINE. The
// line scanner above disagreed with the rendered view in three places, found
// by the source editor's verifier on its copy of this file:
// indented code inside a list item, indented code inside a blockquote, and a
// code span that runs onto the next line. Each needs CommonMark's container
// rules, which is a parser's job. The view is micromark + GFM (`markdown.ts`),
// so the same parser with the same extension says where code is here. The
// line scanner stays for the editor, which knows only the text up to the caret.

/** micromark's names for code: a fenced block, an indented block, an inline span. */
const CODE_TOKENS: ReadonlySet<string> = new Set(["codeFenced", "codeIndented", "codeText"]);
/** micromark's names for raw HTML: a block, and a tag or comment inside a line. */
const HTML_TOKENS: ReadonlySet<string> = new Set(["htmlFlow", "htmlText"]);
/** Could anything in a text open code? */
const MAY_OPEN_CODE = /[`~]|( {4}|\t)/;
/** Built once: the same extension the rendered view parses with. */
const GFM = [gfm()];
/** How many texts `maskCode` has parsed: a parse is the cost, so a test can count them. */
let parses = 0;
export const codeParses = (): number => parses;

/**
 * The `[from, to)` offsets of every piece of code in `text`, as the rendered
 * view parses it, and with `html`, of every piece of raw HTML too.
 */
function codeRanges(text: string, html: boolean): Array<[number, number]> {
  parses++;
  const events = postprocess(
    parse({ extensions: GFM })
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  const out: Array<[number, number]> = [];
  for (const [kind, token] of events) {
    if (kind !== "enter") continue;
    const from = token.start.offset;
    if (CODE_TOKENS.has(token.type) || (html && HTML_TOKENS.has(token.type)))
      out.push([from, token.end.offset]);
  }
  return out;
}

/**
 * `text` with its code blanked IN PLACE: every character of a code block
 * (fenced or indented, at any depth of list or quote) or an inline span (on one
 * line or several), its ticks included, becomes a space, and line breaks stay.
 * The result is exactly as long as `text`, so an offset found in it is an
 * offset in `text`, which `withoutCode` cannot promise.
 *
 * With `{ html: true }`, raw HTML is blanked the same way, and only what the
 * rendered view treats as HTML: a comment, a tag inside a line, and an HTML
 * block (`<div>` … to its blank line, a line opening with `<b>`). The view
 * encodes raw HTML (`markdown.ts`), so it shows all of it as text, a link
 * written inside it included. (The source editor masks only comments and
 * leaves the other HTML's links counted; here the check agrees with the view.)
 *
 * ⛔ AN UNCLOSED `<!--` INSIDE A LINE IS TEXT. A pattern that ran a comment "to
 * its end, or to the end of the text" hid every link below `Use <!-- to open a
 * comment.`, while the view shows those four characters as text and every
 * later link as a link. So the parser says where a comment is: one inside a
 * line must close in its paragraph, and one that opens a line is an HTML
 * block, which runs to the line holding `-->` or to the end of its container
 * (a quote, a list item, the document). The view shows that whole block as
 * text, so a link after `-->` on the same line is text too.
 */
export function maskCode(text: string, opts: { html?: boolean } = {}): string {
  const html = opts.html === true && text.includes("<");
  if (!html && !MAY_OPEN_CODE.test(text)) return text; // nothing here can open code
  let out = "";
  let at = 0;
  for (const [from, to] of codeRanges(text, html)) {
    if (from < at) continue; // nested inside a range already blanked
    out += text.slice(at, from) + text.slice(from, to).replace(/[^\r\n]/g, " ");
    at = to;
  }
  return out + text.slice(at);
}

/**
 * Is the end of `before` (the document up to the caret) in code? The caret's
 * line is checked against the blocks found from the top, then for an open
 * inline span.
 */
export function caretInCode(before: string): boolean {
  const lines = before.split("\n");
  const last = lines.length - 1;
  if (codeBlockLines(lines).has(last)) return true;
  return inInlineCode(lines[last] ?? "");
}
