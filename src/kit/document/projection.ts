// The rendered document's text, and where every character of it came from.
// This is what lets a selection made in the rendered view mean the same thing as
// one made in the raw view: source offsets, which the chat attaches and a note
// anchors to.
//
// WHY A PROJECTION AND NOT A SEARCH. A selection in the rendered view is a run of
// RENDERED text: `**Maren's Bakery**` reaches the reader as `Maren's Bakery`, and
// `[a](x.md)` as `a`. Searching the source for what was selected fails on exactly
// the text this app edits (bold inside a link, on every line of a list), so the
// projection is the plain text the reader sees, carrying a source span per
// segment, and the answer is a mapping rather than a guess.
//
// IT IS BUILT BY THE RENDERER'S OWN PARSER. `mdast-util-from-markdown` wraps the
// same micromark the kit renders with, configured with the same GFM extension, so
// the projection cannot disagree with the rendered output about what is text and
// what is markup. A hand-rolled inline stripper would be a second, partial
// markdown reader with nothing holding it level with the first.
//
// OFFSETS ARE WHOLE-TEXT OFFSETS. The rendered view drops a frontmatter block (it
// becomes the header, outside the projected text) and the source does not, so a
// projection of the body alone would be off by the block's length for every
// document that has one. `project` takes the whole text and adds that base back
// itself, because a call site that has to remember is a call site that will forget.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { splitFrontmatter } from "../lib/frontmatter.ts";
import { lineAt as lineNumberAt } from "../lib/lineBreaks.ts";

/**
 * One run of rendered text and the source it came from. `exact` says whether the
 * mapping inside the run is character for character: it is for ordinary prose, and
 * it is not for a construct whose rendered form is shorter than its source (an
 * inline code span, an escape). An offset inside a non-exact run resolves to the
 * whole run, which is the honest answer: there is no character to point at.
 */
export type ProjSegment = {
  plainFrom: number;
  plainTo: number;
  srcFrom: number;
  srcTo: number;
  exact: boolean;
};

/** The rendered text of a document, plus where each part of it came from. */
export type Projection = {
  plain: string;
  /** In `plain` order, non-overlapping. */
  segments: ProjSegment[];
  /**
   * Text the page draws that `plain` does not carry, as bare runs (no spaces): a
   * footnote reference's number, its back-link and the "Footnotes" heading. A
   * selection on the page may hold them; `showsSelection` lets it.
   */
  pageOnly: string[];
};

/**
 * Block boundaries the projection inserts so the last word of one block and the
 * first of the next do not read as one word. They are in `plain` and not in the
 * source, so a separator's segment is zero-width in source and never `exact`: a
 * selection that starts or ends inside one lands on the block edge beside it.
 */
const TIGHT = new Set(["listItem", "tableCell", "tableRow"]);
const BLOCKS = new Set([
  "paragraph",
  "heading",
  "code",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "thematicBreak",
  "definition",
  "footnoteDefinition",
]);

type Node = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
};

/**
 * The rendered text of a document, with a WHOLE-TEXT source span for every part of
 * it. A leading frontmatter block is not rendered text (the header draws it), so
 * nothing in it is projected and every offset after it carries its length.
 */
export function project(text: string): Projection {
  const { body, bodyStart } = splitFrontmatter(text);
  const p = projectBody(body);
  if (bodyStart === 0) return p;
  return {
    plain: p.plain,
    pageOnly: p.pageOnly,
    segments: p.segments.map((s) => ({
      ...s,
      srcFrom: s.srcFrom + bodyStart,
      srcTo: s.srcTo + bodyStart,
    })),
  };
}

/**
 * The rendered text of `text`, with a source span for every part of it. Only nodes
 * that put characters on the screen contribute: prose, code (inline and block), a
 * hard break, and raw HTML, which micromark encodes rather than emits. An image
 * contributes nothing, because its alt text is an attribute and cannot be selected.
 */
function projectBody(text: string): Projection {
  const tree = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Node;

  const segments: ProjSegment[] = [];
  let plain = "";
  let pendingBoundary: { sep: string; at: number } | null = null;

  const flushBoundary = () => {
    if (!pendingBoundary || plain === "") {
      pendingBoundary = null;
      return;
    }
    const { sep, at } = pendingBoundary;
    pendingBoundary = null;
    segments.push({
      plainFrom: plain.length,
      plainTo: plain.length + sep.length,
      srcFrom: at,
      srcTo: at,
      exact: false,
    });
    plain += sep;
  };

  const emit = (raw: string, node: Node) => {
    if (raw === "") return;
    // The page holds `\n` for each `\r\n` and each lone `\r` (HTML parsing
    // makes both `\n`), so the plain text does too, or the runs stop aligning.
    // Shorter than its source, a run with a `\r\n` is then not exact; a lone
    // `\r` is one character either way.
    const value = lf(raw);
    flushBoundary();
    const s = node.position?.start.offset;
    const e = node.position?.end.offset;
    const srcFrom = s ?? 0;
    const srcTo = e ?? s ?? 0;
    segments.push({
      plainFrom: plain.length,
      plainTo: plain.length + value.length,
      srcFrom,
      srcTo,
      // 1:1 only when the source span is exactly as long as what it renders to.
      exact: srcTo - srcFrom === value.length,
    });
    plain += value;
  };

  /**
   * Prose, split at its line breaks when the source carries markup on each line. A
   * wrapped list item or quote is not one run: its source repeats the indent or the
   * `> ` on every line and its rendered text does not, so the text node is longer
   * in source than on screen. Each line of the value is found in the source in
   * turn and emitted exactly, the line break with it; if any line cannot be found
   * (an escape, an entity), the node falls back to one non-exact run.
   */
  const emitText = (raw: string, node: Node) => {
    // A CRLF or lone-CR file's prose: each break is one `\n` on the page, and
    // the lines between are found and emitted exactly, as a wrapped list item's are.
    const value = lf(raw);
    const s = node.position?.start.offset;
    const e = node.position?.end.offset;
    if (s === undefined || e === undefined || e - s === value.length || !value.includes("\n")) {
      emit(value, node);
      return;
    }
    const pieces: { value: string; at: number }[] = [];
    let cursor = s;
    const lines = value.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const at = line === "" ? cursor : text.indexOf(line, cursor);
      if (at === -1 || at + line.length > e || (i === 0 && at !== s)) {
        emit(value, node);
        return;
      }
      if (line !== "") pieces.push({ value: line, at });
      cursor = at + line.length;
      if (i < lines.length - 1) {
        const nl = nextBreak(text, cursor);
        if (nl === -1 || nl >= e) {
          emit(value, node);
          return;
        }
        pieces.push({ value: "\n", at: nl });
        cursor = nl + 1;
      }
    }
    for (const piece of pieces)
      emit(piece.value, {
        type: "text",
        position: { start: { offset: piece.at }, end: { offset: piece.at + piece.value.length } },
      });
  };

  let footnoteRefs = 0;
  const walk = (node: Node) => {
    if (node.type === "footnoteReference") footnoteRefs++;
    // The outermost boundary wins, so a boundary is only set when none is pending:
    // a list item holds a paragraph, and the inner node must not turn a tight list
    // into a loose one.
    if (BLOCKS.has(node.type) && plain !== "" && pendingBoundary === null) {
      pendingBoundary = {
        sep: TIGHT.has(node.type) ? "\n" : "\n\n",
        at: node.position?.start.offset ?? 0,
      };
    }
    switch (node.type) {
      case "text":
        emitText(node.value ?? "", node);
        return;
      case "inlineCode":
      case "code":
      case "html":
        emit(node.value ?? "", node);
        return;
      case "break":
        emit("\n", node);
        return;
      case "image":
      case "imageReference":
      case "thematicBreak":
        return;
      default:
        break;
    }
    for (const child of node.children ?? []) walk(child);
  };

  for (const child of tree.children ?? []) walk(child);
  // GFM numbers each reference (1, 2, ...), and a repeated one's back-link carries
  // its count; the section the definitions move to has a heading and back-links.
  const pageOnly =
    footnoteRefs === 0
      ? []
      : ["Footnotes", "\u21a9", ...Array.from({ length: footnoteRefs }, (_, i) => String(i + 1))];
  return { plain, segments, pageOnly };
}

/** The segment a `plain` offset falls in, or null when there is none. */
function segmentAt(p: Projection, at: number): ProjSegment | null {
  for (const seg of p.segments) if (at >= seg.plainFrom && at < seg.plainTo) return seg;
  return null;
}

/**
 * Where a run of rendered text is in the source. The start resolves forwards and
 * the end backwards: the end is taken from the segment holding the last selected
 * character, not the one after it, so a selection ending at a block edge does not
 * swallow the next block's opening markup.
 */
export function toSource(
  p: Projection,
  plainFrom: number,
  plainTo: number,
): { from: number; to: number } {
  const lo = Math.max(0, Math.min(plainFrom, p.plain.length));
  const hi = Math.max(lo, Math.min(plainTo, p.plain.length));
  const first = segmentAt(p, lo) ?? p.segments[0];
  const last = hi > lo ? (segmentAt(p, hi - 1) ?? first) : first;
  if (!first || !last) return { from: 0, to: 0 };
  const from = first.exact ? first.srcFrom + (lo - first.plainFrom) : first.srcFrom;
  const to = last.exact ? last.srcFrom + (hi - last.plainFrom) : last.srcTo;
  return { from, to: Math.max(from, to) };
}

/**
 * Where a run of source is in the rendered text: the direction a note highlight
 * needs, since a note's anchor is resolved against the source. Null when the range
 * is entirely markup (a fence), which a caller must be able to tell apart from "the
 * start of the document".
 */
export function toPlain(
  p: Projection,
  srcFrom: number,
  srcTo: number,
): { from: number; to: number } | null {
  let first: ProjSegment | null = null;
  let last: ProjSegment | null = null;
  for (const seg of p.segments) {
    if (seg.srcTo <= srcFrom || seg.srcFrom >= srcTo) continue;
    if (seg.plainTo === seg.plainFrom) continue;
    if (!first) first = seg;
    last = seg;
  }
  if (!first || !last) return null;
  const from = first.exact
    ? first.plainFrom + Math.max(0, srcFrom - first.srcFrom)
    : first.plainFrom;
  const to = last.exact
    ? last.plainFrom + Math.min(last.plainTo - last.plainFrom, Math.max(0, srcTo - last.srcFrom))
    : last.plainTo;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

/**
 * Where a rendered text node begins in `plain`, as a pair: `at` is where the run's
 * first projected character is, and `lead` is how many of its leading characters
 * have no place in `plain` (whitespace the DOM has and the projection never wrote;
 * every one of them resolves to where the run's text starts).
 */
export type RunPlacement = { at: number; lead: number };

/** Where character `within` of a placed run is in `plain`. */
export function runOffset(placement: RunPlacement, within: number): number {
  return placement.at + Math.max(0, within - placement.lead);
}

/**
 * Where each rendered text node begins in `plain`: the bridge between a DOM
 * selection and the projection. A progressive search, not an assumed alignment:
 * micromark puts a newline between block tags where the projection writes two, so
 * concatenating the text nodes drifts. Matching each run forward from a cursor
 * keeps the runs in document order, and two rules keep one bad match from
 * stranding every run after it.
 *
 * 1. Inter-tag whitespace is placed only where the cursor already is. A
 *    whitespace-only run that is not sitting at the cursor is null and moves
 *    nothing: it has no text a selection could be about anyway.
 * 2. A match that skips text must be confirmed by the next run. Normally the gap
 *    between the cursor and the match is whitespace; when it is not, either an
 *    earlier run failed to place or this run is text the projection never wrote
 *    that happens to occur later. The next run tells them apart.
 *
 * A run is matched on its trimmed text. A run that cannot be placed gets null
 * rather than a guess: a wrong offset would silently anchor a note onto unrelated
 * words.
 */
export function alignRuns(plain: string, runs: readonly string[]): (RunPlacement | null)[] {
  const cores = runs.map((r) => r.trim());
  const out: (RunPlacement | null)[] = [];
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] as string;
    const core = cores[i] as string;
    if (core === "") {
      if (run !== "" && plain.startsWith(run, cursor)) {
        out.push({ at: cursor, lead: 0 });
        cursor += run.length;
      } else out.push(null);
      continue;
    }
    const found = plain.indexOf(core, cursor);
    if (
      found === -1 ||
      (/\S/.test(plain.slice(cursor, found)) && !confirmed(plain, found + core.length, cores, i))
    ) {
      out.push(null);
      continue;
    }
    // Back off over the leading whitespace `plain` actually has; the rest is the
    // DOM's alone and resolves to where the text begins.
    const wanted = run.length - run.trimStart().length;
    let back = 0;
    while (back < wanted && plain[found - back - 1] === run[wanted - back - 1]) back++;
    out.push({ at: found - back, lead: wanted - back });
    cursor = found + core.length;
  }
  return out;
}

/** Rule 2: does the next run with text in it begin right after `end`? */
function confirmed(plain: string, end: number, cores: readonly string[], i: number): boolean {
  let j = i + 1;
  while (j < cores.length && cores[j] === "") j++;
  const next = cores[j];
  // The last run has nothing to be confirmed by; take the match.
  if (next === undefined) return true;
  let k = end;
  while (k < plain.length && /\s/.test(plain[k] as string)) k++;
  return plain.startsWith(next, k);
}

/**
 * The 1-based line a source offset is on: what the wire's selection carries. It
 * counts lines as the raw editor does (a lone `\r` is a break), so the rendered
 * and raw views agree on a line.
 */
export const lineAt = lineNumberAt;

/** `raw` with each `\r\n` and each lone `\r` written `\n`, as the page holds it. */
function lf(raw: string): string {
  return raw.includes("\r") ? raw.replace(/\r\n?/g, "\n") : raw;
}

/**
 * Where the next line break at or after `from` is, as one character: the `\n` of
 * a `\r\n`, or a lone `\r` or `\n`. -1 when there is none.
 */
function nextBreak(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  const cr = text.indexOf("\r", from);
  if (cr === -1 || (nl !== -1 && nl <= cr + 1)) return nl;
  return cr;
}

/** `s` with every space and line break taken out: what two readings of a passage share. */
function bare(s: string): string {
  return s.replace(/\s+/gu, "");
}

// The refusal's words live apart, so the daemon can say them without loading this.
export { NOT_PLACED } from "./notPlaced.ts";

/**
 * Does source range `from`..`to` hold what the human selected, `seen`, as the
 * view they selected in showed it? The daemon asks before it stores a note over
 * a range, so a range the page placed wrongly is refused rather than stored over
 * text nobody chose (kit-lone-cr-line-endings: "alpha" became a note over the
 * whole body). The page asks the same question first, so a refusal is said
 * before anything is typed.
 *
 * Spaces and line breaks are not compared: the browser and the projection write
 * the gap between blocks differently. A range passes when it shows `seen`:
 *
 * - **as source**: a selection in the raw editor;
 * - **as rendered text**: a selection in the rendered view. Two allowances, which
 *   may come together:
 *   - **text the page draws and the projection does not carry** (a footnote's
 *     number, its back-link, the "Footnotes" heading) may sit inside `seen`;
 *   - **a run the projection cannot cut** (an inline code span, a line with an
 *     entity or an escape) at either edge is stored whole, so the rest of that
 *     run may sit beside what was seen. Not the whole run: a selection that
 *     starts in a run has at least one of its characters, unless it starts on
 *     a space (and then `seen` starts with one).
 *
 * ⚠ IT JUDGES TEXT, NOT PLACE. A range elsewhere that shows the same text passes:
 * the same words in another paragraph, or a run that cannot be cut and holds the
 * selected words anywhere in it. What it refuses is a range that shows MORE or
 * OTHER text than was selected, which is how a misplaced selection looks.
 */
export function showsSelection(
  text: string,
  from: number,
  to: number,
  seen: string,
  projection?: Projection,
  /** How much the walk may do; a test sets it low to make the fallback answer. */
  walkBudget = WALK_BUDGET,
): boolean {
  const want = bare(seen);
  if (bare(text.slice(from, to)) === want) return true;
  if (want === "") return false;
  const p = projection ?? projectedOnce(text);
  // The runs the range covers, in order; separators and blank runs carry nothing.
  const runs = p.segments.filter(
    (seg) =>
      !(seg.srcTo <= from || seg.srcFrom >= to) &&
      bare(p.plain.slice(seg.plainFrom, seg.plainTo)) !== "",
  );
  const first = runs[0];
  const last = runs[runs.length - 1];
  const r = toPlain(p, from, to);
  // A range that shows nothing (a space beside a footnote's number) holds no
  // text nobody chose: it passes when all that was seen is the page's own.
  if (!first || !last || !r)
    return matchesWithin(want, "", 0, 0, p.pageOnly, { budget: walkBudget, fallback: false });
  const shown = bare(p.plain.slice(r.from, r.to));
  const m = shown.length;
  const runLength = (seg: ProjSegment) => bare(p.plain.slice(seg.plainFrom, seg.plainTo)).length;
  // How much of the shown text may lie before and after what was selected.
  let lead: number;
  let trail: number;
  if (first === last) lead = trail = first.exact ? 0 : m;
  else {
    const edge = (seg: ProjSegment, onSpace: boolean) =>
      seg.exact ? 0 : Math.max(0, runLength(seg) - (onSpace ? 0 : 1));
    lead = edge(first, /^\s/u.test(seen));
    trail = edge(last, /\s$/u.test(seen));
  }
  // The fallback cannot see the runs between the edges: it may answer only when
  // there are none, or when none holds a character `seen` does not. (Today its
  // edge rule already implies this: a place that ends inside the last run spans
  // the middle, so `seen` holds the middle's characters. Kept so a looser
  // fallback cannot take whole unselected runs.)
  const seenChars = new Set(want);
  const middleOutside = runs
    .slice(1, -1)
    .some((seg) =>
      [...bare(p.plain.slice(seg.plainFrom, seg.plainTo))].some((c) => !seenChars.has(c)),
    );
  return matchesWithin(want, shown, lead, trail, p.pageOnly, {
    budget: walkBudget,
    fallback: first === last || !middleOutside,
  });
}

/**
 * `project(text)`, kept for the last text asked about. ⚠ PROJECTING IS LINEAR BUT
 * NOT CHEAP (close to a second for 200 KB), and the daemon checks every note
 * against the same text until the next edit, so it projects that text once. The
 * page passes the projection it already holds and never comes here.
 */
let lastProjected: { text: string; p: Projection } | null = null;
/** How many times `showsSelection` has had to project: a test holds the page to none. */
export const checkProjections = { made: 0 };
function projectedOnce(text: string): Projection {
  if (lastProjected?.text !== text) {
    lastProjected = { text, p: project(text) };
    checkProjections.made++;
  }
  return lastProjected.p;
}

/**
 * How much the walk may do before it stops. Ordinary text keeps few positions
 * alive and stays far under it; text that repeats itself (a fenced block of
 * `-----` lines) keeps every start alive, and following them all is quadratic:
 * 3 s for a 20 KB block.
 */
const WALK_BUDGET = 150_000;

/**
 * Is `want` the text `shown[a, m - b)` for some `a <= lead` and `b <= trail`,
 * with any of `extra` (bare text the page draws on its own) inserted, and with
 * at least one character of `shown` in it? Walked as the set of positions in
 * `shown` reachable at each position in `want`, so no choice has to be guessed.
 */
function matchesWithin(
  want: string,
  shown: string,
  lead: number,
  trail: number,
  extra: readonly string[],
  limits: { budget: number; fallback: boolean },
): boolean {
  const m = shown.length;
  const n = want.length;
  // Positions in `want` reached with nothing of `shown` matched yet: one flag
  // each, since every start up to `lead` is still open there.
  const fresh: boolean[] = new Array(n + 1).fill(false);
  // Positions in `shown` reached, once something of it matched, per position in `want`.
  const at: Set<number>[] = Array.from({ length: n + 1 }, () => new Set<number>());
  // A selection may begin inside text the page draws on its own, so `want` may
  // open with the end of one ("tes" of "Footnotes"), and close with the start of one.
  fresh[0] = true;
  for (const t of extra)
    for (let k = 1; k < t.length; k++) if (want.startsWith(t.slice(k))) fresh[t.length - k] = true;
  const closes = (i: number) =>
    i === n || extra.some((t) => t.length > n - i && t.startsWith(want.slice(i)));
  const firstAt = Math.min(lead, m - 1);
  let work = 0;
  for (let i = 0; i < n; i++) {
    const here = at[i] as Set<number>;
    if (!fresh[i] && here.size === 0) continue;
    const ends = extra.filter((t) => t !== "" && want.startsWith(t, i)).map((t) => i + t.length);
    if (fresh[i]) {
      for (const e of ends) fresh[e] = true;
      for (let j = 0; j <= firstAt; j++) if (shown[j] === want[i]) at[i + 1]?.add(j + 1);
      work += firstAt + 1;
    }
    for (const j of here) {
      if (j < m && shown[j] === want[i]) at[i + 1]?.add(j + 1);
      for (const e of ends) at[e]?.add(j);
    }
    work += here.size;
    // ⛔ BOUNDED. This much work means text that repeats itself, where the live
    // positions are as good as each other; settled the cheap way instead.
    if (work > limits.budget) return limits.fallback && foundWhole(want, shown, lead, trail, extra);
  }
  // Done where the rest of `want` is nothing, or the start of the page's own text;
  // with something of `shown` matched, or nothing of it there to match.
  for (let i = 0; i <= n; i++) {
    if (!closes(i)) continue;
    if (fresh[i] && m === 0) return true;
    for (const j of at[i] as Set<number>) if (m - j <= trail) return true;
  }
  return false;
}

/**
 * The walk's cheap stand-in, for text that repeats itself: `want`, with the
 * page's own text taken out of it or not, found whole in `shown` at a place
 * that starts within `lead` and leaves at most `trail` after it. The earliest
 * place that leaves at most `trail` is the one to try: a later one only starts
 * later. ⚠ It cannot see what lies between the edges, so the caller allows it
 * only for one run, or for middle runs made of characters `seen` holds.
 */
function foundWhole(
  want: string,
  shown: string,
  lead: number,
  trail: number,
  extra: readonly string[],
): boolean {
  let stripped = want;
  for (const t of extra) if (t !== "") stripped = stripped.split(t).join("");
  return [want, stripped].some((w) => {
    if (w === "") return false;
    const from = Math.max(0, shown.length - w.length - trail);
    if (from > lead) return false;
    const at = firstIndex(shown, w, from);
    return at !== -1 && at <= lead;
  });
}

/**
 * `hay.indexOf(needle, from)` in time linear in both (Knuth, Morris, Pratt).
 * ⚠ Not `indexOf`: on text that repeats itself with a mismatch near the end,
 * it compared the whole needle at each place, 360 ms for 30,000 dashes.
 */
function firstIndex(hay: string, needle: string, from: number): number {
  const fail = new Int32Array(needle.length);
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = fail[k - 1] as number;
    if (needle[i] === needle[k]) k++;
    fail[i] = k;
  }
  for (let i = from, k = 0; i < hay.length; i++) {
    while (k > 0 && hay[i] !== needle[k]) k = fail[k - 1] as number;
    if (hay[i] === needle[k]) k++;
    if (k === needle.length) return i - needle.length + 1;
  }
  return -1;
}
