// Finding things across everything in the context (E59).
//
// ⛔ TWO MATCHERS, ON PURPOSE, because they answer different questions. Note
// apps split these and it is not an accident: FUZZY on names is for jumping
// ("mabak" → Maren's Bakery), and EXACT on content is for finding ("where did I
// say 'asking-nicely'"). Fuzzy full-text would be the worst of both — searching
// `bridge` would surface documents that merely contain similar-looking letters,
// and you could no longer trust "this phrase is on line 29", which is the only
// thing a content search is for. (Cole raised Fuse for the name half and chose
// the hand-rolled scorer: there is no second engine this has to agree with, so
// fuzzy ranking is a self-contained taste judgment with no drift risk.)
//
// ⚠ AND IT SEARCHES WHAT THE HUMAN IS LOOKING AT, which is not always the file.
// A document open in the session is shown as its ACTIVE VERSION, which lives
// under the session home rather than at the original path — so an edit made two
// minutes ago must still be findable. That asymmetry is also the reason this
// exists for the AGENT at all: grep over the workspace finds the SAVED file and
// silently misses the version being read. The caller supplies the text per
// document for exactly this reason (see `Session.searchAll`).

/** One line that matched, with the offsets of the hit inside the document. */
export type Hit = {
  /** 1-based, so it can be shown and opened. */
  line: number;
  /** The line, for context in the result list. */
  text: string;
  /** Offsets of the match within the document, for reveal-and-select. */
  from: number;
  to: number;
};

/**
 * How much of a line is worth carrying back. A result list is a list, and a
 * document with a 4,000-character paragraph should not send all of it per hit.
 */
const LINE_CAP = 240;

/** Every match of `query` in `text`, at most `limit` of them. */
export function searchText(text: string, query: string, limit = 50): Hit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "" || limit <= 0) return [];
  const hay = text.toLowerCase();
  let at = hay.indexOf(needle);
  if (at === -1) return [];
  // Line starts, walked ONCE. A per-hit `lastIndexOf("\n")` is quadratic over a
  // document that matches on every line, which is exactly the document someone
  // searches for a common word.
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const hits: Hit[] = [];
  let cursor = 0;
  while (at !== -1 && hits.length < limit) {
    while (cursor + 1 < starts.length && (starts[cursor + 1] as number) <= at) cursor++;
    const lineStart = starts[cursor] as number;
    const lineEnd = cursor + 1 < starts.length ? (starts[cursor + 1] as number) - 1 : text.length;
    const whole = text.slice(lineStart, lineEnd);
    hits.push({
      line: cursor + 1,
      text: whole.length > LINE_CAP ? `${whole.slice(0, LINE_CAP - 1)}…` : whole,
      from: at,
      to: at + needle.length,
    });
    // ⚠ ADVANCE PAST THE MATCH, NOT THE LINE: two hits on one line are two
    // hits, and stepping by line would silently drop the second.
    at = hay.indexOf(needle, at + needle.length);
  }
  return hits;
}

/** Is this character a word boundary for scoring purposes? */
function isBoundary(ch: string): boolean {
  return ch === " " || ch === "-" || ch === "_" || ch === "/" || ch === "." || ch === "'";
}

/**
 * How well `name` matches `query` as a fuzzy subsequence — higher is better,
 * `null` when the query's characters do not appear in order at all.
 *
 * The weights encode what someone typing into a jump box means:
 *
 * - **contiguity** dominates, because `mare` meaning `Maren` is the common case
 *   and `m…a…r…e` scattered through a sentence is the rare one;
 * - **word starts** score, so `mb` finds `Maren's Bakery` rather than `Number`;
 * - **earlier is better**, and a **shorter name** wins a tie, because the thing
 *   you meant is usually the thing with less around it.
 *
 * ⚠ THE NUMBERS ARE TASTE, NOT TRUTH. They are pinned by cells that assert
 * ORDERINGS ("this beats that") rather than values, so they can be retuned
 * without rewriting the tests — which is the only way a scorer like this stays
 * changeable.
 */
export function scoreName(name: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return null;
  const hay = name.toLowerCase();
  let score = 0;
  let at = 0;
  let run = 0;
  for (const ch of q) {
    const found = hay.indexOf(ch, at);
    if (found === -1) return null;
    run = found === at && at > 0 ? run + 1 : 0;
    score += 10 + run * 12;
    if (found === 0 || isBoundary(hay[found - 1] as string)) score += 14;
    // Distance from where we were looking costs, so scattered matches rank low.
    score -= Math.min(found - at, 12);
    at = found + 1;
  }
  // A whole-word substring is the strongest signal there is; say so loudly.
  if (hay.includes(q)) score += 40;
  if (hay.startsWith(q)) score += 25;
  // Shorter names win ties.
  score -= Math.min(name.length, 40) / 4;
  return score;
}

/** A document the NAME matched. */
export type NameMatch = {
  path: string;
  slug?: string;
  name: string;
  title?: string;
  score: number;
};

/**
 * ⛔ THE SWAP SEAM (Cole): "if we find that actually we should use Fuse, it's
 * fairly easy to replace."
 *
 * The interface is CORPUS-SHAPED — take the whole candidate list and a query,
 * return a ranked slice — and that shape is the whole point. A per-item
 * `score(name, query)` hook would have looked like the smaller abstraction and
 * would have FOUGHT the very library it exists to admit: Fuse indexes a list
 * and searches it, it does not score one string at a time. Written this way,
 * moving to Fuse is a new function and one default changed:
 *
 *     const fuseNames: NameSearch = (candidates, query, limit) => {
 *       const fuse = new Fuse(candidates, { keys: ["name", "title"], … });
 *       return fuse.search(query, { limit }).map(…);
 *     };
 *
 * Nothing else in this module, the session, the wire or the surface moves.
 */
export type NameSearch = (
  candidates: readonly Candidate[],
  query: string,
  limit: number,
) => NameMatch[];

/** A document the CONTENT matched. */
export type TextMatch = {
  path: string;
  slug?: string;
  name: string;
  version?: number;
  hits: Hit[];
};

export type SearchReport = {
  query: string;
  /** Name/title matches, best first — the jump list. */
  documents: NameMatch[];
  /** Content matches, in context order — the find list. */
  text: TextMatch[];
  /** Total content hits reported. */
  count: number;
  /** True when a cap stopped the search early, so "3" and "3 of more" differ. */
  truncated: boolean;
};

/** Per-document content cap, so one enormous document cannot fill the report. */
export const PER_DOC = 20;
/** Whole-report content cap. */
export const TOTAL = 200;
/** How many name matches are worth showing. */
export const NAMES = 10;

/**
 * The default `NameSearch`: `scoreName` over every candidate, ranked.
 *
 * A document's TITLE is matched as well as its filename — an OKF document's
 * name and title often differ and the human may remember either — and the
 * better of the two scores is the one that counts.
 */
export const rankNames: NameSearch = (candidates, query, limit) => {
  const out: NameMatch[] = [];
  for (const c of candidates) {
    const byName = scoreName(c.name, query);
    const byTitle = c.title === undefined ? null : scoreName(c.title, query);
    if (byName === null && byTitle === null) continue;
    out.push({
      path: c.path,
      ...(c.slug !== undefined ? { slug: c.slug } : {}),
      name: c.name,
      ...(c.title !== undefined ? { title: c.title } : {}),
      score: Math.max(byName ?? -Infinity, byTitle ?? -Infinity),
    });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, limit);
};

export type Candidate = {
  path: string;
  /** The basename, which is what a human types at. */
  name: string;
  slug?: string;
  title?: string;
  version?: number;
};

/**
 * Search a list of candidates for both kinds of match.
 *
 * `read` may throw or return null for a document that has been deleted under
 * the context — a search is not the moment to fail over that, so it is skipped
 * rather than reported as a document with no hits.
 */
export function searchDocuments(
  candidates: readonly Candidate[],
  query: string,
  read: (c: Candidate) => string | null,
  caps: { perDoc?: number; total?: number; names?: number; nameSearch?: NameSearch } = {},
): SearchReport {
  const q = query.trim();
  if (q === "") return { query: "", documents: [], text: [], count: 0, truncated: false };
  const perDoc = caps.perDoc ?? PER_DOC;
  const total = caps.total ?? TOTAL;
  const names = caps.names ?? NAMES;

  const scored = (caps.nameSearch ?? rankNames)(candidates, q, names);

  const text: TextMatch[] = [];
  let count = 0;
  let truncated = false;
  for (const c of candidates) {
    if (count >= total) {
      truncated = true;
      break;
    }
    let body: string | null = null;
    try {
      body = read(c);
    } catch {
      body = null;
    }
    if (body === null) continue;
    const room = Math.min(perDoc, total - count);
    const hits = searchText(body, q, room + 1);
    if (hits.length === 0) continue;
    if (hits.length > room) truncated = true;
    const kept = hits.slice(0, room);
    count += kept.length;
    text.push({
      path: c.path,
      ...(c.slug !== undefined ? { slug: c.slug } : {}),
      name: c.name,
      ...(c.version !== undefined ? { version: c.version } : {}),
      hits: kept,
    });
  }

  return { query: q, documents: scored, text, count, truncated };
}
