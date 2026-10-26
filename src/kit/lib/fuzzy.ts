// Fuzzy matching on names, shared by the daemon's search and the browser's
// pickers. Pure, with no imports, so any subpath may use it: the link picker
// ranks the session's documents with the same taste the header's search does.

/**
 * Lower-case `text` without changing its length, so offsets in the folded text are
 * offsets in the original. A character whose lowercase is a different length (the
 * dotted capital I becomes two) is kept as it is: it still matches itself, and
 * the rest of the document stays searchable.
 */
export function fold(text: string): string {
  const whole = text.toLowerCase();
  if (whole.length === text.length) return whole;
  let out = "";
  for (const ch of text) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

function isBoundary(ch: string): boolean {
  return ch === " " || ch === "-" || ch === "_" || ch === "/" || ch === "." || ch === "'";
}

/**
 * How well `name` matches `query` as a fuzzy subsequence: higher is better,
 * null when the query's characters do not appear in order at all. Contiguity
 * dominates, word starts score, earlier is better, a shorter name wins a tie.
 * The numbers are taste; the tests pin orderings, not values.
 */
export function scoreName(name: string, query: string): number | null {
  const q = fold(query.trim()).replace(/\s+/g, " ");
  if (q === "") return null;
  const hay = fold(name);
  // A space in the query stands for any word boundary in the name, so "the old
  // mill" finds "the-old-mill".
  const matches = (ch: string, c: string) => (ch === " " ? isBoundary(c) : ch === c);
  let score = 0;
  let at = 0;
  let run = 0;
  for (const ch of q) {
    let found = -1;
    for (let i = at; i < hay.length; i++) {
      if (matches(ch, hay[i] as string)) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    run = found === at && at > 0 ? run + 1 : 0;
    score += 10 + run * 12;
    if (found === 0 || isBoundary(hay[found - 1] as string)) score += 14;
    score -= Math.min(found - at, 12);
    at = found + 1;
  }
  const spaced = [...hay].map((c) => (isBoundary(c) ? " " : c)).join("");
  if (hay.includes(q) || spaced.includes(q)) score += 40;
  if (hay.startsWith(q) || spaced.startsWith(q)) score += 25;
  score -= Math.min(name.length, 40) / 4;
  return score;
}
