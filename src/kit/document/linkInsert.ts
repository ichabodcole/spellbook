// Writing a link: what the picker ranks, and the text a choice puts into the
// editor. Pure, so the browser and the tests share it. The daemon computes each
// target's relative path (`workspace/links.ts`, `relativeHref`), because it is
// the one that knows where both documents are; this only puts that path into
// markdown.
//
// Three ways in, one picker:
//
// - `wrap`: Add link on a selection (the right-click menu, or Mod-Shift-K). The
//   selection becomes the link's text; with no selection the target's name is.
// - `complete`: `](` typed in the raw editor. The choice finishes the link:
//   the path and the closing paren.
// - `wiki`: `[[` typed in the raw editor. The choice replaces the two brackets
//   with a whole standard link, `[Name](path)`, never a wiki link: a world's
//   files are read by tools that do not know `[[…]]`.
//
// An IMAGE chosen (kit-image-embeds) is embedded, `![name](path)`, unless words
// are being linked: Add link over a selection makes those words a link to it,
// `[words](path)`, which opens the viewer. Choosing an image with nothing
// selected (or from `[[`) means "put the image here"; selecting words first
// means "these words point at it". `](` finishes whatever was typed before it,
// `[text](` or `![alt](` alike.

import { fold, scoreName } from "../lib/fuzzy.ts";
import { normaliseRelation } from "../lib/relationUse.ts";
import type {
  HeadingOffer,
  KindRelationUse,
  LinkTarget,
  RelationOffer,
} from "../workspace/protocol";

export type LinkKind = "wrap" | "complete" | "wiki";

/**
 * The editor range a link will replace, kept current while the picker is open:
 * mapped through every change (the agent's, the disk's, a key typed before the
 * picker took focus), so an edit elsewhere does not refuse a good link. A
 * range whose text is deleted collapses to where it was, and the insertion
 * guard then refuses it. Null only once the editor view it was taken in is
 * gone (the rendered view's tracker never is).
 */
export type LinkTracker = {
  range: () => { from: number; to: number } | null;
  release: () => void;
};

/**
 * What asked for a link. `from`..`to` is what the choice replaces when asked:
 * the selection for `wrap`, the caret just after `](` for `complete`, the `[[`
 * itself for `wiki`. `quote` is the selection's text, read from the EDITOR at
 * those offsets (the daemon's copy trails the editor while typing). `track`
 * follows the range from then on.
 */
export type LinkRequest = {
  kind: LinkKind;
  from: number;
  to: number;
  x: number;
  y: number;
  quote: string;
  track: LinkTracker;
};

/** How many rows the picker draws: enough to scroll, few enough to stay quick. */
export const PICKER_ROWS = 50;

/** A file name without its extension. */
export function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Whether every word of `query` is in an image's description (its title and
 * one-line description), anywhere and in any order: "fox arch" finds "The fox
 * before the archway". Literal, not fuzzy: a sentence holds nearly every
 * scattering of letters, so a fuzzy match on one would match everything.
 */
export function matchesDescription(description: string | undefined, query: string): boolean {
  if (!description) return false;
  const hay = fold(description);
  const words = fold(query).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

/**
 * The targets matching `query`, best first. Names are scored with the header
 * search's scorer, so a space matches a word boundary ("old mill" finds
 * `the-old-mill.md`). An image can match on its description, ranked below
 * every name match; a target can still match on its path (a folder name),
 * ranked below those. An empty query lists them all, by path.
 */
export function rankTargets(
  targets: readonly LinkTarget[],
  query: string,
  limit: number = PICKER_ROWS,
): LinkTarget[] {
  if (query.trim() === "")
    return [...targets].sort((a, b) => a.shown.localeCompare(b.shown)).slice(0, limit);
  const scored: { t: LinkTarget; s: number }[] = [];
  for (const t of targets) {
    const byName = scoreName(stem(t.name), query);
    if (byName !== null) {
      scored.push({ t, s: byName + 2000 });
      continue;
    }
    if (matchesDescription(t.description, query)) {
      scored.push({ t, s: 1000 });
      continue;
    }
    const byPath = scoreName(t.shown, query);
    if (byPath !== null) scored.push({ t, s: byPath });
  }
  return scored
    .sort((a, b) => b.s - a.s || a.t.shown.localeCompare(b.t.shown))
    .slice(0, limit)
    .map(({ t }) => t);
}

/**
 * A relation offered for the link being written, with what it is ranked by:
 * `here`, the links from a document of the open one's kind into a document of
 * the target's kind that carry it; `into`, the links from any kind into the
 * target's kind that do.
 */
export type RankedRelation = RelationOffer & { here: number; into: number };

/**
 * The relations to offer for a link to a target of kind `targetKind` (none
 * when it has none, or no target is in view), best first: most used between the
 * open document's kind and the target's (`byKind`'s `fromKind`), then most
 * used into the target's kind from any kind, then most used overall, then a
 * declared one before one that is not, then by name. In Dreamwood, a link from
 * the Ruin to the Cave puts `contrasts-with` first, and a link into the
 * touchstones puts `sourced-from` first. Nothing is chosen: this is only order.
 */
export function rankRelations(
  offers: readonly RelationOffer[],
  byKind: readonly KindRelationUse[],
  targetKind: string | undefined,
): RankedRelation[] {
  const use = new Map<string, KindRelationUse>();
  if (targetKind !== undefined)
    for (const u of byKind) if (u.kind === targetKind) use.set(u.rel.toLowerCase(), u);
  // A relation's name is case-folded on read (`parseRel`), and the daemon sends
  // folded names. Folded here too, so two offers that differ only in case are
  // never offered twice: one stands, with both counts. The declared one's
  // words (label, means and the rest) stand even when an undeclared one came
  // first; between two alike, the first.
  const folded = new Map<string, RelationOffer>();
  for (const o of offers) {
    const rel = o.rel.toLowerCase();
    const seen = folded.get(rel);
    if (!seen) folded.set(rel, { ...o, rel });
    else {
      const words = o.declared && !seen.declared ? o : seen;
      folded.set(rel, { ...words, rel, count: seen.count + o.count, declared: words.declared });
    }
  }
  return [...folded.values()]
    .map((o) => ({ ...o, here: use.get(o.rel)?.fromKind ?? 0, into: use.get(o.rel)?.links ?? 0 }))
    .sort(
      (a, b) =>
        b.here - a.here ||
        b.into - a.into ||
        b.count - a.count ||
        Number(b.declared) - Number(a.declared) ||
        a.rel.localeCompare(b.rel),
    );
}

/**
 * The ranked relations to suggest while `typed` is in the relation field, at
 * most `limit`: those not already `chosen`, whose name or label holds what is
 * typed, in any case (`Ext` and `ext` both offer `extends`). A chosen relation
 * is left out in any case too: choosing `Extends` leaves `extends` unoffered.
 */
export function suggestRelations(
  ranked: readonly RankedRelation[],
  chosen: readonly string[],
  typed: string,
  limit: number,
): RankedRelation[] {
  const q = fold(typed.trim());
  const taken = new Set(chosen.map((c) => c.toLowerCase()));
  return ranked
    .filter(
      (r) =>
        !taken.has(r.rel.toLowerCase()) &&
        (q === "" || fold(r.rel).includes(q) || fold(r.label ?? "").includes(q)),
    )
    .slice(0, limit);
}

/** Whether `rel` is among `chosen` in any case: relations are read case-folded. */
export function hasRelation(chosen: readonly string[], rel: string): boolean {
  const r = rel.toLowerCase();
  return chosen.some((c) => c.toLowerCase() === r);
}

export { normaliseRelation };

/**
 * The target to write: the path, then `?rel=a,b` when there are relations. No
 * relation, no query: a bare link stays bare, and nothing is ever defaulted.
 * Each relation is written as given, its case kept; a repeat in another case
 * is dropped, the first kept, since the reader folds them into one.
 */
export function hrefWithRelations(href: string, relations: readonly string[]): string {
  const rels: string[] = [];
  for (const r of relations.map(normaliseRelation))
    if (r !== "" && !hasRelation(rels, r)) rels.push(r);
  if (rels.length === 0) return href;
  return `${href}?rel=${rels.join(",")}`;
}

/** A name made safe as link text: brackets and backslashes escaped. */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (ch) => `\\${ch}`);
}

/**
 * The selection made safe as link text: only its UNBALANCED brackets are
 * escaped (with `escapeLinkText`), because a balanced pair is fine inside link
 * text and is the human's own writing. An already escaped bracket is left alone.
 */
export function escapeUnbalanced(text: string): string {
  const open: number[] = [];
  const lone = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") open.push(i);
    else if (ch === "]") {
      if (open.length > 0) open.pop();
      else lone.add(i);
    }
  }
  for (const i of open) lone.add(i);
  if (lone.size === 0) return text;
  let out = "";
  for (let i = 0; i < text.length; i++)
    out += lone.has(i) ? escapeLinkText(text[i] as string) : text[i];
  return out;
}

/** A markdown link or image already in the text: `[text](target)`. */
const HAS_LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/;

/**
 * A line that starts a block of its own: a list item, a heading, a quote, a
 * fence or a table row. A selection whose later line starts one has crossed
 * out of its paragraph, even with no blank line between.
 */
const STARTS_BLOCK = /^ {0,3}([-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}([ \t]|$)|>|`{3,}|~{3,}|\|)/;

/**
 * Inline markers that must open and close inside the link text: strong and
 * strikethrough pairs, single-star emphasis and code spans. Underscores are
 * left out, because inside a word (`snake_case`) they are only letters.
 */
function splitsInlineMarkup(text: string): boolean {
  const plain = text.replace(/\\./g, "");
  // Code spans first: what is inside one is not markup.
  if ((plain.match(/`/g) ?? []).length % 2 === 1) return true;
  const outside = plain.replace(/`[^`]*`/g, "");
  for (const pair of [/\*\*/g, /__/g, /~~/g])
    if ((outside.match(pair) ?? []).length % 2 === 1) return true;
  // A star with space on both sides (a list marker, `2 * 3`) is not emphasis.
  const singles = outside.replace(/\*\*/g, "").replace(/(^|\s)\*(?=\s)/g, "$1");
  return (singles.match(/\*/g) ?? []).length % 2 === 1;
}

/**
 * Why a selection cannot become one link, or null when it can.
 *
 * - A blank line ends a paragraph, and a later line that starts a list item,
 *   heading, quote, fence or table row is another block: either way the link
 *   would not render. A soft line break inside one paragraph is fine.
 * - A link inside it would nest one link in another, which markdown forbids.
 * - Emphasis or a code span cut by the selection's edge (starting inside
 *   `**…**` and ending outside it) would leave its markers as literal
 *   characters. Refused rather than widened: widening would link words the
 *   human did not select, and selecting the whole span is one drag away.
 */
export function linkTextProblem(selected: string): string | null {
  if (/\n[ \t]*\n/.test(selected))
    return "The selection crosses a blank line, and a link cannot span paragraphs.";
  if (
    selected
      .split("\n")
      .slice(1)
      .some((line) => STARTS_BLOCK.test(line))
  )
    return "The selection runs into another block (a list item, heading, quote or table), and a link cannot span blocks.";
  if (HAS_LINK.test(selected))
    return "The selection already holds a link, and a link cannot contain another.";
  if (splitsInlineMarkup(selected))
    return "The selection starts or ends inside emphasis or code. Select the whole marked span, or only text inside it.";
  return null;
}

/**
 * What a choice writes. `selected` is the text the request covers (the
 * selection, for `wrap`), with its unbalanced brackets escaped; a name the
 * picker supplies is escaped in full. With a `heading` (the picker's second
 * step), its anchor follows the path and any `?rel=`, and its text, not the
 * document's name, is the label the picker supplies.
 */
export function linkInsertion(
  kind: LinkKind,
  selected: string,
  target: Pick<LinkTarget, "name" | "href" | "image">,
  relations: readonly string[],
  heading?: Pick<HeadingOffer, "text" | "anchor">,
): string {
  const href = `${hrefWithRelations(target.href, relations)}${heading ? `#${heading.anchor}` : ""}`;
  if (kind === "complete") return `${href})`;
  const words = kind === "wrap" && selected !== "";
  const text = words
    ? escapeUnbalanced(selected)
    : escapeLinkText(heading ? heading.text : stem(target.name));
  return `${target.image && !words ? "!" : ""}[${text}](${href})`;
}

/**
 * The text that must still stand at the tracked `range` for an insertion there
 * to be the right one: the selection for `wrap`, the `](` before it for
 * `complete`, the `[[` that starts it for `wiki`.
 */
export function insertionGuard(
  kind: LinkKind,
  range: { from: number; to: number },
  quote: string,
): { at: number; text: string } {
  if (kind === "complete") return { at: range.from - 2, text: "](" };
  if (kind === "wiki") return { at: range.from, text: "[[" };
  return { at: range.from, text: quote };
}

/**
 * Where, in a tracked range, what was typed after the trigger starts: right at
 * the caret for `complete`, after the two brackets for `wiki`. Keys typed before
 * the picker took focus land there, and become the picker's first query.
 */
export function typedFrom(kind: LinkKind, range: { from: number; to: number }): number {
  return kind === "wiki" ? range.from + 2 : range.from;
}

/**
 * Did this keystroke start a link? `before` is the text of the line up to and
 * including the character just typed. `](` counts only after a `[` on the same
 * line, an embed's (`![alt](`) included; `[[` counts only as a pair, not as the
 * third bracket of `[[[`, and not after `!`. Code is the caller's to rule out.
 */
export function linkTrigger(before: string): Exclude<LinkKind, "wrap"> | null {
  if (before.endsWith("](")) {
    const open = before.lastIndexOf("[", before.length - 3);
    if (open === -1) return null;
    return "complete";
  }
  if (before.endsWith("[[") && !before.endsWith("[[[") && !before.endsWith("![[")) return "wiki";
  return null;
}

/**
 * A document's headings for the picker's second step, best first for `query`
 * (the header search's scorer, on the heading's text); with no query, all of
 * them in the document's order, so the outline reads as it is written.
 */
export function rankHeadings(headings: readonly HeadingOffer[], query: string): HeadingOffer[] {
  if (query.trim() === "") return [...headings];
  const scored: { h: HeadingOffer; s: number }[] = [];
  for (const h of headings) {
    const s = scoreName(h.text, query);
    if (s !== null) scored.push({ h, s });
  }
  return scored.sort((a, b) => b.s - a.s || a.h.line - b.h.line).map(({ h }) => h);
}
