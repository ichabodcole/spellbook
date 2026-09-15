// Markdown highlighting for the raw view — a HAND-WRITTEN stream tokenizer.
//
// ⛔ THIS IS E20's OPEN QUESTION, ANSWERED, AND THE THIRD OPTION WON.
//
//   1. `@codemirror/lang-markdown` is what a spell would normally reach for. It
//      imports `@codemirror/lang-html` at module scope (inline HTML is part of
//      the grammar), which drags the HTML, CSS and JavaScript languages into the
//      bundle — and the JavaScript language's snippet strings (`import … from
//      "${module}"`) read as imports to the import-boundary ward's text scan of
//      the shipped bundle (ward 1b). That false positive is what removed
//      highlighting in the first place.
//   2. `@codemirror/legacy-modes` has 310 stream modes and markdown is NOT one
//      of them — markdown moved to the Lezer package, which is option 1.
//   3. So: ~50 lines, no dependency, and the one shape the other two do not
//      have — a tokenizer that can be UNIT TESTED directly, over the real
//      `StringStream`, rather than trusted because it is somebody's package.
//
// What it deliberately does not do, said rather than discovered later: no
// highlighting INSIDE a fenced block (colouring the code's own language is the
// import that costs the bundle), and no structural parse, so no folding.
import {
  HighlightStyle,
  StreamLanguage,
  type StringStream,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

/** Our token names, mapped to highlight tags — no reliance on a default table. */
export const TOKEN_TAGS = {
  heading: tags.heading,
  strong: tags.strong,
  emph: tags.emphasis,
  strike: tags.strikethrough,
  code: tags.monospace,
  link: tags.link,
  url: tags.url,
  quote: tags.quote,
  bullet: tags.list,
  rule: tags.meta,
} as const;

export type Token = keyof typeof TOKEN_TAGS | null;
export type MdState = { fence: string | null };

/** A fence opens and closes with the same marker: ``` or ~~~. */
const FENCE = /^(```|~~~)/;

/**
 * One step of the tokenizer. Line-level shapes are decided at the start of a
 * line; inline shapes are matched where the stream stands. Returns the token
 * name, or null for ordinary text.
 */
export function mdToken(stream: StringStream, state: MdState): Token {
  if (state.fence !== null) {
    // Only the SAME marker closes the fence: inside a ~~~ block, a ``` line is
    // code, not the end of it (a document quoting one fence inside another).
    const closing = stream.sol() && stream.match(state.fence) !== null;
    stream.skipToEnd();
    if (closing) state.fence = null;
    return "code";
  }
  if (stream.sol()) {
    const fence = stream.match(FENCE) as RegExpMatchArray | null;
    if (fence) {
      state.fence = String(fence[1]);
      stream.skipToEnd();
      return "code";
    }
    if (stream.match(/^ {0,3}#{1,6}\s/)) {
      stream.skipToEnd();
      return "heading";
    }
    if (stream.match(/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/)) return "rule";
    if (stream.match(/^ *>+\s?/)) {
      stream.skipToEnd();
      return "quote";
    }
    if (stream.match(/^ *([-*+]|\d+[.)])\s+/)) return "bullet";
    // An indented line inside a list is ordinary text; fall through.
  }
  if (stream.match(/^(\*\*|__)(?=\S)[\s\S]*?\S\1/)) return "strong";
  if (stream.match(/^(\*|_)(?=\S)[^*_\n]*?\S\1/)) return "emph";
  if (stream.match(/^~~(?=\S)[\s\S]*?\S~~/)) return "strike";
  if (stream.match(/^`+[^`\n]*`+/)) return "code";
  if (stream.match(/^!?\[[^\]\n]*\]\([^)\n]*\)/)) return "link";
  if (stream.match(/^<?https?:\/\/[^\s>)]+>?/)) return "url";
  stream.next();
  return null;
}

const markdownMode = StreamLanguage.define<MdState>({
  name: "markdown",
  startState: () => ({ fence: null }),
  token: mdToken,
  copyState: (state) => ({ ...state }),
  tokenTable: TOKEN_TAGS,
});

/** The spell's own tokens, as a highlight style — so both themes follow one palette. */
const scriptoriumHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--color-ink)", fontWeight: "700" },
  { tag: tags.strong, color: "var(--color-ink)", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--color-ink-dim)" },
  { tag: tags.monospace, color: "var(--color-attention)" },
  { tag: tags.link, color: "var(--color-rubric)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--color-rubric)" },
  { tag: tags.quote, color: "var(--color-ink-dim)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--color-rubric)" },
  { tag: tags.meta, color: "var(--color-ink-faint)" },
]);

/** Markdown highlighting for a CodeMirror state. */
export const markdownHighlighting = [markdownMode, syntaxHighlighting(scriptoriumHighlight)];
