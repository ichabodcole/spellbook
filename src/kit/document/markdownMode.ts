// Markdown highlighting for the raw view: a hand-written stream tokenizer.
//
// WHY NOT `@codemirror/lang-markdown`. It imports `@codemirror/lang-html` at module
// scope (inline HTML is part of the grammar), which drags the HTML, CSS and
// JavaScript languages into the bundle. And `@codemirror/legacy-modes` has no
// markdown mode: markdown moved to the Lezer package, which is the same import.
// So this is about fifty lines with no dependency beyond the language and highlight
// packages, and the one shape the others do not have: a tokenizer that can be
// unit tested directly, over the real `StringStream`.
//
// What it deliberately does not do, said rather than discovered later: no
// highlighting INSIDE a fenced block (colouring the code's own language is the
// import that costs the bundle), and no structural parse, so no folding. An app
// adds the non-markdown shapes its documents carry as inline tokens
// (`InlineToken`), matched before markdown's own inline shapes and drawn in the
// style the app gives them.
import {
  HighlightStyle,
  StreamLanguage,
  type StringStream,
  syntaxHighlighting,
  type TagStyle,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { Tag, tags } from "@lezer/highlight";

/** Our token names, mapped to highlight tags: no reliance on a default table. */
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

/**
 * A shape an app's documents carry that markdown does not: matched where the
 * stream stands, after the line-level shapes and before markdown's inline ones,
 * and drawn in `style`. The pattern is anchored (`^`) and consumes at least one
 * character; `name` is the token the tokenizer returns for it.
 */
export type InlineToken = {
  name: string;
  pattern: RegExp;
  style: Omit<TagStyle, "tag">;
};

/** A fence opens and closes with the same marker: ``` or ~~~. */
const FENCE = /^(```|~~~)/;

/**
 * The tokenizer, with an app's inline tokens. Line-level shapes are decided at the
 * start of a line; inline shapes are matched where the stream stands. Each step
 * returns the token name, or null for ordinary text.
 */
export function markdownTokenizer(
  inline: readonly InlineToken[] = [],
): (stream: StringStream, state: MdState) => string | null {
  checkTokens(inline);
  return (stream, state) => {
    const line = lineShape(stream, state);
    if (line !== undefined) return line;
    for (const t of inline) if (stream.match(t.pattern)) return t.name;
    return inlineShape(stream);
  };
}

/**
 * Throw on an app token whose name is one of markdown's own or another app token's:
 * the token table holds one tag per name, so a clash would silently draw one as the
 * other.
 */
export function checkTokens(inline: readonly InlineToken[]): void {
  const seen = new Set<string>(Object.keys(TOKEN_TAGS));
  for (const t of inline) {
    if (seen.has(t.name)) throw new Error(`inline token name "${t.name}" is already taken`);
    seen.add(t.name);
  }
}

/** One step of the tokenizer with no app tokens. */
export function mdToken(stream: StringStream, state: MdState): Token {
  return lineShape(stream, state) ?? inlineShape(stream);
}

/** A fenced line, or a shape decided at the start of a line; undefined when neither. */
function lineShape(stream: StringStream, state: MdState): Token | undefined {
  if (state.fence !== null) {
    // Only the SAME marker closes the fence: inside a ~~~ block, a ``` line is code.
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
  }
  return undefined;
}

/** The inline shape where the stream stands, or a single character of plain text. */
function inlineShape(stream: StringStream): Token {
  if (stream.match(/^(\*\*|__)(?=\S)[\s\S]*?\S\1/)) return "strong";
  if (stream.match(/^(\*|_)(?=\S)[^*_\n]*?\S\1/)) return "emph";
  if (stream.match(/^~~(?=\S)[\s\S]*?\S~~/)) return "strike";
  if (stream.match(/^`+[^`\n]*`+/)) return "code";
  if (stream.match(/^!?\[[^\]\n]*\]\([^)\n]*\)/)) return "link";
  if (stream.match(/^<?https?:\/\/[^\s>)]+>?/)) return "url";
  stream.next();
  return null;
}

/** The kit's tokens as highlight rules, so both themes follow one palette. */
const HIGHLIGHT = [
  { tag: tags.heading, color: "var(--color-ink)", fontWeight: "700" },
  { tag: tags.strong, color: "var(--color-ink)", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--color-ink-dim)" },
  { tag: tags.monospace, color: "var(--color-attention)" },
  { tag: tags.link, color: "var(--color-brand)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--color-brand)" },
  { tag: tags.quote, color: "var(--color-ink-dim)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--color-brand)" },
  { tag: tags.meta, color: "var(--color-ink-faint)" },
];

/** A tag per app token, kept so the same token is the same tag every time it is used. */
const tokenTags = new WeakMap<InlineToken, Tag>();
function tagOf(t: InlineToken): Tag {
  let tag = tokenTags.get(t);
  if (!tag) {
    tag = Tag.define();
    tokenTags.set(t, tag);
  }
  return tag;
}

/** The kit's highlight style, with an app's inline tokens drawn in their own styles. */
export function markdownHighlightStyle(inline: readonly InlineToken[] = []): HighlightStyle {
  checkTokens(inline);
  return HighlightStyle.define([
    ...HIGHLIGHT,
    ...inline.map((t) => ({ ...t.style, tag: tagOf(t) })),
  ]);
}

/** Markdown highlighting for a CodeMirror state, with an app's inline tokens. */
export function markdownHighlighting(inline: readonly InlineToken[] = []): Extension {
  checkTokens(inline);
  const language = StreamLanguage.define<MdState>({
    name: "markdown",
    startState: () => ({ fence: null }),
    token: markdownTokenizer(inline),
    copyState: (state) => ({ ...state }),
    tokenTable: {
      ...Object.fromEntries(inline.map((t) => [t.name, tagOf(t)])),
      ...TOKEN_TAGS,
    },
  });
  return [language, syntaxHighlighting(markdownHighlightStyle(inline))];
}
