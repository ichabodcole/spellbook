// The rendered view's HTML: the kit's markdown renderer, with an app's inline
// widgets given a span each. It is the only thing feeding the rendered view's HTML
// sink (a test holds that), and it is the markdown renderer's own output that makes
// the sink safe: micromark encodes raw HTML in the source, every link target has
// been checked, and the spans are the only markup added after, each wrapping text
// the renderer already encoded and carrying a class checked against a strict shape.
import type { ReactNode } from "react";
import { splitFrontmatter } from "../lib/frontmatter.ts";
import { parseRel, splitTarget } from "../lib/linkTarget.ts";
import { renderMarkdown } from "../lib/markdown.ts";

/** Where a widget's spans fall in a run of rendered text. */
export type InlineSpans = {
  /** The class each span carries, and the one the rendered view finds it by. */
  className: string;
  /**
   * The spans in one run of rendered text, as offsets into it. The text is HTML
   * text (`&amp;` and the like still encoded), so a span must not cut through a
   * character reference; matches that overlap an earlier one are dropped.
   */
  find: (text: string) => readonly { start: number; end: number }[];
};

/**
 * A span of source that the rendered view draws as a React node. The span keeps its
 * own text (so a selection across it, or a copy of it, is still the source); the app's
 * stylesheet decides whether that text shows, and `render` is mounted inside it.
 */
export type InlineWidget = InlineSpans & {
  /** What to draw into a span, from its text; null leaves the span as it is. */
  render: (text: string) => ReactNode | null;
};

/** A class name that is safe to write into the HTML as it is. */
const SAFE_CLASS = /^[A-Za-z][\w-]*$/;

/**
 * Throw on two widgets sharing a class: the rendered view finds a widget's spans by
 * its class, so both would draw into the same spans.
 */
export function checkWidgets(widgets: readonly InlineSpans[]): void {
  const seen = new Set<string>();
  for (const w of widgets) {
    if (seen.has(w.className))
      throw new Error(`inline widget class "${w.className}" is used twice`);
    seen.add(w.className);
  }
}

/**
 * Wrap every widget's spans in the text of already-rendered HTML. Only text is
 * touched: tags (and so attributes) are skipped, and so is code, where such a span
 * is something the author is showing, not placing. Every tag in the input was
 * minted by the markdown renderer, so splitting on `<...>` is exact. A widget whose
 * class is not a plain name is ignored.
 */
export function wrapInline(html: string, widgets: readonly InlineSpans[]): string {
  checkWidgets(widgets);
  const safe = widgets.filter((w) => SAFE_CLASS.test(w.className));
  if (safe.length === 0) return html;
  let depth = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(code|pre)[\s>]/i.test(part)) depth++;
        else if (/^<\/(code|pre)>/i.test(part)) depth = Math.max(0, depth - 1);
        return part;
      }
      if (depth > 0 || part.length === 0) return part;
      const spans = safe
        .flatMap((w) => w.find(part).map(({ start, end }) => ({ start, end, cls: w.className })))
        .sort((a, b) => a.start - b.start);
      let out = "";
      let at = 0;
      for (const { start, end, cls } of spans) {
        if (start < at || end <= start) continue;
        out += `${part.slice(at, start)}<span class="${cls}">${part.slice(start, end)}</span>`;
        at = end;
      }
      return out + part.slice(at);
    })
    .join("");
}

/** `<a href="…"` in micromark's own output, the only thing that writes one. */
const ANCHOR_HREF = /<a href="([^"]*)"/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Mark each link to a document that carries `?rel=` with its relations, as a
 * `data-rel` attribute the stylesheet draws after the link (`.md-prose a[data-rel]`).
 *
 * ⛔ AN ATTRIBUTE, NEVER TEXT. The rendered view's selection and note paint align
 * the DOM's text nodes against the source (`projection.ts`); a chip written as text
 * would be words the source does not have, and every offset after it would drift.
 * A pseudo-element's content is not in the DOM's text, so it cannot. The values are
 * safe to write as they are: `parseRel` admits only letters, combining marks, digits,
 * `_`, `.` and `-`, folded to lower case, so `?rel=Extends` shows as `extends`.
 * A bare link gets nothing: it asserts no relation.
 */
export function markRelations(html: string): string {
  return html.replace(ANCHOR_HREF, (whole, href: string) => {
    const target = href.replace(/&amp;/g, "&");
    if (HAS_SCHEME.test(target)) return whole;
    const rel = parseRel(splitTarget(target).query);
    return rel.length === 0 ? whole : `${whole} data-rel="${rel.join(" · ")}"`;
  });
}

/**
 * A document's body as the HTML the rendered view shows. A leading frontmatter block
 * is not part of it: the header draws that, outside this HTML, and a document without
 * one renders exactly as its whole text.
 */
export function renderDocument(text: string, widgets: readonly InlineSpans[] = []): string {
  return wrapInline(markRelations(renderMarkdown(splitFrontmatter(text).body)), widgets);
}
