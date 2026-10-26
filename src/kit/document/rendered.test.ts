// The rendered view's HTML with an app's inline widgets: spans in text only, never in
// code, never overlapping, and a class written into the HTML only when it is a plain
// name.

import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../lib/markdown.ts";
import { type InlineSpans, markRelations, renderDocument, wrapInline } from "./rendered.ts";

/** Every match of `re` in a run of text, as spans. */
const spans =
  (re: RegExp) =>
  (text: string): { start: number; end: number }[] =>
    [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

const brace: InlineSpans = { className: "brace", find: spans(/\{[a-z]+\}/g) };
const caret: InlineSpans = { className: "caret", find: spans(/\^[a-z]+/g) };

describe("wrapInline and renderDocument", () => {
  test("no widgets leaves the renderer's output as it is", () => {
    const src = "Say {wave} and ^nod.\n";
    expect(renderDocument(src)).toBe(renderMarkdown(src));
  });

  test("each widget's matches get a span with its class, keeping their text", () => {
    expect(renderDocument("Say {wave} and ^nod.\n", [brace, caret])).toBe(
      '<p>Say <span class="brace">{wave}</span> and <span class="caret">^nod</span>.</p>\n',
    );
  });

  test("a match overlapping an earlier one is dropped", () => {
    const wide: InlineSpans = { className: "wide", find: spans(/\{wa/g) };
    const html = wrapInline("<p>{wave} x</p>", [wide, brace]);
    expect(html).toBe('<p><span class="wide">{wa</span>ve} x</p>');
    expect(html.match(/<span/g)).toHaveLength(1);
  });

  test("code spans and fenced blocks are skipped", () => {
    const html = renderDocument("`{wave}` and {wave}\n\n```\n{wave}\n```\n", [brace]);
    expect(html.match(/class="brace"/g)).toHaveLength(1);
    expect(html).toContain("<code>{wave}</code>");
  });

  test("a class that is not a plain name never reaches the output", () => {
    const evil: InlineSpans = { className: 'x" onclick="alert(1)', find: spans(/\{[a-z]+\}/g) };
    const odd: InlineSpans = { className: "has space", find: spans(/\{[a-z]+\}/g) };
    const src = "Say {wave}.\n";
    expect(renderDocument(src, [evil, odd])).toBe(renderMarkdown(src));
    const mixed = renderDocument(src, [evil, caret, brace]);
    expect(mixed).not.toContain("onclick");
    expect(mixed).toContain('<span class="brace">{wave}</span>');
  });

  test("two widgets with the same class are refused by name", () => {
    const again: InlineSpans = { className: "brace", find: spans(/x/g) };
    expect(() => renderDocument("x {wave}\n", [brace, again])).toThrow('"brace"');
  });
});

describe("a typed link's relations", () => {
  test("ride the anchor as data-rel, several joined, and add no text", () => {
    const html = renderDocument("[the glade](./the-glade.md?rel=sister-of,extends#top)\n");
    expect(html).toBe(
      '<p><a href="./the-glade.md?rel=sister-of,extends#top" data-rel="sister-of · extends">the glade</a></p>\n',
    );
  });

  test("a bare link, an external one and a placeholder relation get none", () => {
    for (const src of [
      "[b](./b.md)",
      "[w](https://example.com/?rel=sister-of)",
      "[p](./p.md?rel=<relationship>)",
    ])
      expect(markRelations(renderMarkdown(src))).toBe(renderMarkdown(src));
  });

  test("relations written in mixed case show folded, while the link as written is untouched", () => {
    const src = "[The Glade](./the-glade.md?rel=Extends&rel=Governs)\n";
    const html = renderDocument(src);
    expect(html).toBe(
      '<p><a href="./the-glade.md?rel=Extends&amp;rel=Governs" data-rel="extends · governs">The Glade</a></p>\n',
    );
    // Only the attribute is added: the href and the text keep the author's case.
    expect(html.replace(' data-rel="extends · governs"', "")).toBe(renderMarkdown(src));
  });

  test("the relation is read past other parameters and decoded", () => {
    expect(renderDocument("[x](./a.md?a=1&rel=%C3%A9t%C3%A9)")).toContain('data-rel="été"');
  });

  test("a refused link stays refused and unmarked", () => {
    const html = renderDocument("[x](javascript:alert(1)?rel=extends)");
    expect(html).not.toContain("data-rel");
  });
});
