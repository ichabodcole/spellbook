// A link's `#anchor` and the heading it names: which heading an anchor finds,
// and which anchor a link to a heading is written with. One rule for every
// reader of an anchor: following a link (the daemon and the rendered view), the
// link check, the link picker, the agent's `show`, and a board card's JSON
// Canvas `subpath`. Pure string work over `headingsOf`, with no `node:path` and
// nothing of the surface or the daemon, so any of them can import it.
//
// The convention (the kit-heading-links write-up, accepted 2026-10-06):
//
// - **Written:** the heading's text as it reads, inline markup dropped,
//   encoded only where a markdown destination needs it (`encodeLinkSegment`),
//   after the path and any `?rel=`. A heading whose text repeats in its
//   document is written as a path of headings, `#Parent#Child`, as Obsidian
//   writes a nested one. A board's `subpath` is the same text, decoded, after
//   a `#`.
// - **Read:** by the first of four rules that finds a heading:
//   1. the anchor equals the heading's text without markup;
//   2. the same, ignoring case and runs of whitespace;
//   3. the anchor is the heading's GitHub slug, repeats numbered as GitHub
//      numbers them (`stacking-lenses-1` is the second);
//   4. the anchor is a path of headings, each part found inside the section of
//      the one before.
//   A bare anchor whose exact text names several headings (a repeated
//   heading) lands on the first of them, as GitHub and Obsidian both do, and
//   says it was ambiguous; a path of headings names one alone. When only the
//   case-folded rule finds several, the anchor's slug decides if it names one.
//
// Explicit `{#id}` anchors are not read (decision 6): every renderer the user
// uses shows them as text.

import { fold } from "./fuzzy.ts";
import type { Heading } from "./headings.ts";
import { encodeLinkSegment } from "./linkTarget.ts";

/** Which of the four rules found a heading. */
export type HeadingRule = "text" | "folded" | "slug" | "path";

/** A heading an anchor found, and how. */
export type HeadingMatch = {
  heading: Heading;
  /** Its place in the list it was found in. */
  index: number;
  rule: HeadingRule;
  /** The anchor names more than one heading; this is the first of them. */
  ambiguous?: true;
};

/** A backslash escape: markdown's, of any ASCII punctuation. */
const ESCAPE = /\\([!-/:-@[-`{-~])/g;
/** Stand-ins for escaped characters while markup is stripped: a private-use run. */
const HOLD = "";

/**
 * A heading's text as it reads, without its inline markup: emphasis (`*`, `_`,
 * `~~`), code backticks, a link or an image reduced to its label, a wiki link
 * to its label or name, a backslash escape to the character. Whitespace runs
 * become one space. An underscore inside a word (`snake_case`) is kept, as
 * markdown keeps it.
 */
export function headingPlainText(text: string): string {
  const held: string[] = [];
  let s = text.replace(ESCAPE, (_m, ch: string) => {
    held.push(ch);
    return `${HOLD}${held.length - 1}${HOLD}`;
  });
  s = s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name: string, label?: string) =>
      (label ?? name).trim(),
    )
    .replace(/`+/g, "")
    .replace(/\*+|~~/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+/gu, "$1")
    .replace(/_+(?=[^\p{L}\p{N}]|$)/gu, "");
  s = s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"), (_m, i: string) => held[Number(i)] ?? "");
  return s.replace(/\s+/gu, " ").trim().normalize("NFC");
}

/** Rule 2's form of a text: lower-cased, whitespace runs collapsed, trimmed, NFC. */
const foldKey = (text: string) => fold(text.normalize("NFC")).replace(/\s+/gu, " ").trim();

/**
 * GitHub's slug for one heading's text (as `github-slugger` makes it, before
 * repeats are numbered): lower-cased, every character that is not a letter, a
 * mark, a digit, a connector (`_`), a space or `-` removed, and each space made
 * `-`. So `*A Voyage to Arcturus* — David Lindsay` is
 * `a-voyage-to-arcturus--david-lindsay`.
 */
export function githubSlug(plain: string): string {
  return plain
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Every heading's slug in order, repeats numbered as GitHub numbers them: the
 * second `stacking-lenses` is `stacking-lenses-1`, and a number that collides
 * with a real heading's slug moves on to the next.
 */
export function githubSlugs(headings: readonly Heading[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((h) => {
    const base = githubSlug(headingPlainText(h.text));
    let slug = base;
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  });
}

/** What each heading is compared by, worked out once per list. */
type Keyed = { heading: Heading; index: number; plain: string; folded: string; slug: string };

/**
 * Each list's keys, kept while the list is: the session caches a document's
 * `Heading[]` per file stamp, so the link check, which asks of one list once
 * per link to it, works them out once per document, not once per link.
 */
const keyCache = new WeakMap<readonly Heading[], Keyed[]>();

function keyed(headings: readonly Heading[]): Keyed[] {
  const hit = keyCache.get(headings);
  if (hit) return hit;
  const slugs = githubSlugs(headings);
  const keys = headings.map((heading, index) => {
    const plain = headingPlainText(heading.text);
    return { heading, index, plain, folded: foldKey(plain), slug: slugs[index] as string };
  });
  keyCache.set(headings, keys);
  return keys;
}

/**
 * Rules 1 to 3 over `among`: the first rule that finds anything decides. One
 * heading found is the answer; several are the first of them, `many`.
 *
 * ⛔ SEVERAL BY TEXT IS A DUPLICATE, NOT A MISS. Falling through to the slug
 * rule would find exactly one (`notes` is the first "Notes", `notes-1` the
 * second), so a repeated heading would read as unique and never be written
 * as its path.
 */
function pick(
  among: readonly Keyed[],
  anchor: string,
): { k: Keyed; rule: HeadingRule; many: boolean } | null {
  const text = anchor.normalize("NFC").trim();
  if (text === "") return null;
  const folded = foldKey(text);
  const lower = text.toLowerCase();
  const rules: [HeadingRule, (k: Keyed) => boolean][] = [
    ["text", (k) => k.plain === text],
    ["folded", (k) => k.folded === folded],
    ["slug", (k) => k.slug === lower],
  ];
  const bySlug = among.filter((k) => k.slug === lower);
  for (const [rule, test] of rules) {
    const found = among.filter(test);
    if (found.length === 0) continue;
    // Several by case-folded text, but the anchor is one of their slugs (the
    // numbered `summary-1` the anchor writer falls back to, or its unnumbered
    // first `summary`): the slug names one, so it is not a duplicate.
    if (rule === "folded" && found.length > 1 && bySlug.length === 1)
      return { k: bySlug[0] as Keyed, rule: "slug", many: false };
    return { k: found[0] as Keyed, rule, many: found.length > 1 };
  }
  return null;
}

/**
 * The heading `anchor` names in `headings` (one document's, from `headingsOf`),
 * or null. `anchor` is DECODED text: a link's anchor through `decodePath`, or a
 * board's `subpath` (a leading `#` is dropped). See the file's head for the
 * four rules and what a bare duplicate does.
 */
export function findHeading(headings: readonly Heading[], anchor: string): HeadingMatch | null {
  const a = anchor.replace(/^#+/, "");
  if (a.trim() === "") return null;
  const all = keyed(headings);
  const whole = pick(all, a);
  if (whole && !whole.many)
    return { heading: whole.k.heading, index: whole.k.index, rule: whole.rule };
  // Rule 4: a path of headings, each found inside the section of the one before.
  const parts = a.split("#").filter((p) => p.trim() !== "");
  if (parts.length > 1) {
    let among = all;
    let found: { k: Keyed; many: boolean } | null = null;
    for (const part of parts) {
      found = pick(among, part);
      if (!found) break;
      const { line, end } = found.k.heading;
      among = all.filter((k) => k.heading.line > line && k.heading.line <= end);
    }
    if (found)
      return {
        heading: found.k.heading,
        index: found.k.index,
        rule: "path",
        ...(found.many ? { ambiguous: true as const } : {}),
      };
  }
  return whole
    ? { heading: whole.k.heading, index: whole.k.index, rule: whole.rule, ambiguous: true }
    : null;
}

/**
 * The anchor a link to `headings[index]` is written with, as its parts,
 * decoded: the heading's text, or, when that text names more than one heading,
 * the path of headings above it that names it alone (nearest parent first
 * added). Join with `anchorHref` for a link, `anchorSubpath` for a board.
 *
 * Two headings with the same text under parents with the same text all the way
 * up have no path that tells them apart; the GitHub slug, numbered, does, and
 * rule 3 reads it.
 */
export function anchorFor(headings: readonly Heading[], index: number): string[] {
  const target = headings[index];
  if (!target) return [];
  const plain = headingPlainText(target.text);
  const names = (parts: string[]) => {
    const m = findHeading(headings, parts.join("#"));
    return m !== null && m.index === index && !m.ambiguous;
  };
  const parts = [plain];
  if (names(parts)) return parts;
  // The headings whose sections hold this one, nearest first.
  let level = target.level;
  for (let i = index - 1; i >= 0; i--) {
    const h = headings[i] as Heading;
    if (h.level >= level || h.end < target.line) continue;
    level = h.level;
    parts.unshift(headingPlainText(h.text));
    if (names(parts)) return parts;
  }
  return [githubSlugs(headings)[index] as string];
}

/** The anchor's parts as a link writes them after `#`: each encoded, joined by `#`. */
export function anchorHref(parts: readonly string[]): string {
  return parts.map(encodeLinkSegment).join("#");
}

/** The anchor's parts as a JSON Canvas `subpath`: decoded, `#` before each. */
export function anchorSubpath(parts: readonly string[]): string {
  return parts.map((p) => `#${p}`).join("");
}

/** A text's comparison form for `nearestHeading`: folded, punctuation and hyphens as spaces. */
const looseKey = (text: string) => foldKey(text.replace(/[^\p{L}\p{M}\p{N}]+/gu, " "));

/** Adjacent letter pairs, for a Dice similarity. */
function pairs(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const p = s.slice(i, i + 2);
    out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}

/** How alike two texts are, 0 to 1: Dice over letter pairs, and at least 0.75 when one holds the other. */
function likeness(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pa = pairs(a);
  const pb = pairs(b);
  let both = 0;
  for (const [p, n] of pa) both += Math.min(n, pb.get(p) ?? 0);
  const dice = (2 * both) / (a.length - 1 + (b.length - 1));
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 3 && long.includes(short) ? Math.max(dice, 0.75) : dice;
}

/** How alike a heading must be to an anchor to be offered as what it may now be called. */
const NEAREST_AT_LEAST = 0.5;

/**
 * The heading most like `anchor` (decoded), when one is close enough to be the
 * likely new name of a heading that was reworded; null otherwise. Compared
 * loosely (case, punctuation and hyphens aside), so a slug is compared too.
 */
export function nearestHeading(headings: readonly Heading[], anchor: string): Heading | null {
  const parts = anchor
    .replace(/^#+/, "")
    .split("#")
    .filter((p) => p.trim() !== "");
  const want = looseKey(parts.at(-1) ?? "");
  if (want === "") return null;
  let best: Heading | null = null;
  let score = NEAREST_AT_LEAST;
  for (const h of headings) {
    const s = likeness(want, looseKey(headingPlainText(h.text)));
    if (s > score || (s === score && best === null)) {
      best = h;
      score = s;
    }
  }
  return best;
}

/** Where line `line` (1-based) of `text` starts and ends, as offsets, its line break left out. */
export function lineRange(text: string, line: number): { from: number; to: number } {
  let from = 0;
  for (let n = 1; n < line; n++) {
    const br = text.indexOf("\n", from);
    if (br === -1) return { from: text.length, to: text.length };
    from = br + 1;
  }
  const br = text.indexOf("\n", from);
  let to = br === -1 ? text.length : br;
  if (to > from && text[to - 1] === "\r") to--;
  return { from, to };
}
