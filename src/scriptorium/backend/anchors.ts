// Finding where a note belongs, in a document that has moved under it (E45).
//
// ⛔ QUOTED-TEXT ANCHORING, AND THE ALTERNATIVE IS WHY. An offset goes stale on
// the next keystroke: fix a typo three lines up and every note below points at
// the wrong words. Pinning a note to the VERSION it was made on would be exact
// forever and useless — the stated use is making notes WHILE reading and
// editing, and a note that detaches the moment you edit is a note you cannot
// use. So a note remembers the TEXT it was made on, plus a little of what
// surrounded it, and is re-found on every read (Cole approved the trade: "we
// test it out and see if it works and adjust as needed").
//
// ⛔ AND IT SAYS WHEN IT HAS LOST. The fourth outcome is ORPHANED — the quote is
// gone and the note is shown detached rather than pinned somewhere plausible.
// Visible-and-wrong beats invisible-and-wrong; a note silently re-anchored onto
// unrelated words is the failure this design exists to avoid.

/** How much text either side is kept, to tell identical quotes apart. */
export const CONTEXT_CHARS = 48;

/** What a note remembers about where it was made. */
export type Anchor = {
  /** The text the note was made on. Empty means the note is about the document. */
  quote: string;
  /** The characters immediately before and after the quote, when it was made. */
  before: string;
  after: string;
  /** Where it was then — a HINT for choosing between identical quotes, never a source of truth. */
  at: number;
};

/** Where a note belongs now, and how sure we are. */
export type Found =
  | { from: number; to: number; how: "context" | "unique" | "nearest" }
  | { from: null; to: null; how: "orphaned" };

const ORPHANED: Found = { from: null, to: null, how: "orphaned" };

/** Take an anchor from a selection — what the note will remember. */
export function anchorOf(text: string, from: number, to: number): Anchor {
  return {
    quote: text.slice(from, to),
    before: text.slice(Math.max(0, from - CONTEXT_CHARS), from),
    after: text.slice(to, to + CONTEXT_CHARS),
    at: from,
  };
}

/** Every index at which `needle` occurs in `hay`, including overlaps. */
function occurrences(hay: string, needle: string): number[] {
  if (needle === "") return [];
  const found: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    found.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return found;
}

/**
 * Where the note belongs in `text` now.
 *
 * Four answers, tried in order, and each says how it was reached so the surface
 * can show a re-anchored note differently from a certain one:
 *
 * 1. **context** — the quote WITH its surroundings occurs exactly once. The
 *    strongest answer: two identical sentences are told apart by what is
 *    around them.
 * 2. **unique** — the quote occurs exactly once. Its surroundings changed, the
 *    text did not.
 * 3. **nearest** — the quote occurs several times; the one closest to where it
 *    used to be wins. A guess, and labelled as one.
 * 4. **orphaned** — the quote is gone.
 */
export function findAnchor(text: string, anchor: Anchor): Found {
  if (anchor.quote === "") return ORPHANED;

  // 1. With context. The recorded context may itself be clipped at a document
  //    edge, so the whole run is searched rather than assembled blindly.
  const withContext = anchor.before + anchor.quote + anchor.after;
  const contexts = occurrences(text, withContext);
  if (contexts.length === 1) {
    const from = (contexts[0] as number) + anchor.before.length;
    return { from, to: from + anchor.quote.length, how: "context" };
  }

  const hits = occurrences(text, anchor.quote);
  if (hits.length === 0) return ORPHANED;

  // 2. The quote alone, once.
  if (hits.length === 1) {
    const from = hits[0] as number;
    return { from, to: from + anchor.quote.length, how: "unique" };
  }

  // 3. Several — take the one nearest where it was. `at` is a hint, which is
  //    why this answer is labelled: the note may have landed on a twin.
  let best = hits[0] as number;
  for (const hit of hits) if (Math.abs(hit - anchor.at) < Math.abs(best - anchor.at)) best = hit;
  return { from: best, to: best + anchor.quote.length, how: "nearest" };
}

/** A one-line version of the quote, for a list that cannot show all of it. */
export function quoteLabel(quote: string, max = 60): string {
  const flat = quote.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The 1-based lines `[from, to)` covers (E65), as a human counts them: a range
 * that ends just after a newline ends on the line it finished, not the next.
 */
export function linesOf(text: string, from: number, to: number): { from: number; to: number } {
  const lineAt = (i: number) => {
    let n = 1;
    for (let k = text.indexOf("\n"); k !== -1 && k < i; k = text.indexOf("\n", k + 1)) n++;
    return n;
  };
  return { from: lineAt(from), to: lineAt(Math.max(from, to - 1)) };
}
