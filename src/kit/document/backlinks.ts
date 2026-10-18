// How the "Linked from" list arranges a document's backlinks. DOM-free, so the
// rules are tests; `Backlinks.tsx` draws them. The data comes from the daemon
// (`link.backlinks`) and knows nothing of this: a graph view could draw the same
// answer differently.

import type { BacklinkView } from "../workspace/protocol";

/** One group: the links carrying relation `rel`, or (rel null) the bare ones. */
export type BacklinkGroup = { rel: string | null; links: BacklinkView[] };

/**
 * Backlinks grouped by relation: one group per relation, most links first, then
 * alphabetical, and the bare links last in their own group. A link carrying two
 * relations is in both groups, since it asserts both; a bare link is in no
 * relation's group, since it asserts none. Within a group, the order given.
 */
export function groupBacklinks(links: readonly BacklinkView[]): BacklinkGroup[] {
  const by = new Map<string, BacklinkView[]>();
  const bare: BacklinkView[] = [];
  for (const b of links) {
    if (b.rel.length === 0) bare.push(b);
    for (const r of b.rel) {
      const list = by.get(r);
      if (list) list.push(b);
      else by.set(r, [b]);
    }
  }
  const groups: BacklinkGroup[] = [...by]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([rel, list]) => ({ rel, links: list }));
  if (bare.length > 0) groups.push({ rel: null, links: bare });
  return groups;
}

/** A run of snippet text; `mark` is the link that makes this a backlink. */
export type SnippetPart = { text: string; mark?: true };

const MD_LINK = /!?\[([^\]\n]*)\]\(\s*(?:<[^>\n]*>|[^\s()]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const WIKI = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

/** A run's text without `**`, `__` or code ticks: markup a quoted line reads better without. */
const plain = (p: SnippetPart): SnippetPart => ({ ...p, text: p.text.replace(/\*\*|__|`/g, "") });

/**
 * The line a backlink sits on, as a reader would say it: each link reduced to its
 * words (a wiki link to its label, or its name), the backlink's own marked, a
 * leading heading or list marker dropped, and strong emphasis and code ticks
 * removed. A single `*` or `_` stays, since it is as often part of a name.
 */
export function snippetParts(b: Pick<BacklinkView, "context" | "raw" | "kind">): SnippetPart[] {
  const line = b.context.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s*)+/, "");
  const parts: SnippetPart[] = [];
  let at = 0;
  let marked = false;
  const links = [
    ...[...line.matchAll(MD_LINK)].map((m) => ({
      index: m.index ?? 0,
      whole: m[0],
      words: m[0].startsWith("!") ? "" : (m[1] ?? ""),
      own: b.kind === "markdown" && m[0].includes(`](${b.raw}`),
    })),
    ...[...line.matchAll(WIKI)].map((m) => ({
      index: m.index ?? 0,
      whole: m[0],
      words: (m[2] ?? m[1] ?? "").trim(),
      own: b.kind === "wiki" && (m[1] ?? "").trim() === b.raw,
    })),
  ].sort((x, y) => x.index - y.index);
  for (const l of links) {
    if (l.index < at) continue;
    if (l.index > at) parts.push({ text: line.slice(at, l.index) });
    if (l.own && !marked) {
      parts.push({ text: l.words || b.raw, mark: true });
      marked = true;
    } else if (l.words) parts.push({ text: l.words });
    at = l.index + l.whole.length;
  }
  if (at < line.length) parts.push({ text: line.slice(at) });
  // Adjacent plain runs read as one, without strong emphasis or code ticks.
  return parts.map(plain).reduce<SnippetPart[]>((out, p) => {
    const last = out[out.length - 1];
    if (last && !last.mark && !p.mark) last.text += p.text;
    else out.push({ ...p });
    return out;
  }, []);
}
