// JSON highlighting for the raw view: `@codemirror/lang-json`, which is small
// (the Lezer JSON grammar and nothing else, unlike lang-markdown), drawn in the
// kit's own tokens so both themes follow. A JSON document has no rendered view,
// so this is the whole of how one looks.
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const JSON_STYLE = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--color-brand)" },
  { tag: tags.string, color: "var(--color-ink)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--color-attention)" },
  { tag: [tags.separator, tags.brace, tags.squareBracket], color: "var(--color-ink-faint)" },
  { tag: tags.invalid, color: "var(--color-danger)" },
]);

/** The line-number gutter in the kit's tokens: a refusal names a line, so the lines are numbered. */
const GUTTER_THEME = EditorView.theme({
  ".cm-gutters": {
    backgroundColor: "var(--color-bg)",
    color: "var(--color-ink-faint)",
    borderRight: "1px solid var(--color-edge)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
});

/**
 * The numbered-line gutter, in the kit's tokens: always on for JSON, and the
 * human's choice for markdown (`DocumentView`'s `lineNumbers`).
 */
export function numberedLines(): Extension {
  return [lineNumbers(), GUTTER_THEME];
}

/**
 * How a JSON document is edited: the language (highlighting, with its own
 * bracket matching) and numbered lines.
 */
export function jsonHighlighting(): Extension {
  return [json(), syntaxHighlighting(JSON_STYLE), numberedLines()];
}
