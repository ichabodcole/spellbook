/**
 * Split the rendered document into the segments the page composes: runs of
 * sanitised HTML with question cards between them.
 *
 * ⛔ WHY THIS IS A PURE STRING FUNCTION AND NOT A DOM WALK. The old page did
 * `docEl.innerHTML = renderMd(markdown)` and then `querySelectorAll`'d the
 * `[data-qblock]` markers and replaced each node with an imperatively built
 * card. React cannot own a subtree it did not render, so the split happens
 * BEFORE the HTML reaches the DOM — which has the side benefit that the one
 * piece of this page that can be wrong-by-one is testable with no browser.
 *
 * ⛔ DEPTH-AWARE, NOT A BARE REGEX, AND THE DIFFERENCE IS BEHAVIOUR. Only a
 * marker at the TOP LEVEL of the document becomes a card. A marker nested
 * inside another element stays inside its HTML segment, untouched — splitting
 * there would tear the enclosing element in half and `dangerouslySetInnerHTML`
 * would silently re-close it somewhere else.
 *
 * That restriction costs nothing against any reachable input: `review.ts`
 * surrounds every marker it emits with blank lines precisely so `marked` treats
 * it as a self-contained CommonMark type-6 HTML block (review.ts 62–65), so
 * every marker with a KNOWN id is top level by construction. The only way to
 * get a nested one is a document that literally contains such a div — and its
 * id cannot be known, so the old page left it in place too (template.html
 * 1160–1161). Same observable, both ways.
 */

export type Segment =
  | { kind: "html"; html: string }
  | { kind: "question"; id: string; marker: string };

/** HTML elements with no closing tag. DOMPurify emits them unclosed. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const MARKER_RE = /^<div\s+data-qblock="([^"]*)"\s*>\s*<\/div>/;
const TAG_RE = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;

export function splitDocument(html: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = "";
  let depth = 0;
  let i = 0;

  const flush = () => {
    if (buffer !== "") segments.push({ kind: "html", html: buffer });
    buffer = "";
  };

  while (i < html.length) {
    if (html[i] !== "<") {
      buffer += html[i];
      i++;
      continue;
    }

    if (depth === 0) {
      const marker = MARKER_RE.exec(html.slice(i));
      if (marker?.[1] !== undefined) {
        flush();
        segments.push({ kind: "question", id: marker[1], marker: marker[0] });
        i += marker[0].length;
        continue;
      }
    }

    // Not a marker — copy the tag through and track the depth so a nested
    // marker is never mistaken for a top-level one.
    const end = html.indexOf(">", i);
    if (end === -1) {
      buffer += html.slice(i);
      break;
    }
    const tag = html.slice(i, end + 1);
    const name = TAG_RE.exec(tag);
    if (name?.[1] !== undefined) {
      const lower = name[1].toLowerCase();
      if (tag.startsWith("</")) depth = Math.max(0, depth - 1);
      else if (!VOID_TAGS.has(lower) && !tag.endsWith("/>")) depth++;
    }
    buffer += tag;
    i = end + 1;
  }
  flush();
  return segments;
}
