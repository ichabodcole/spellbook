// Small pure rules about the text in the editor.
import { lineAt } from "../lib/lineBreaks.ts";

/** One replacement in a text: `from`..`to` becomes `insert`. */
export type TextChange = { from: number; to: number; insert: string };

/** `text` with `changes` applied in order, each in the offsets the one before it left. */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (const c of changes) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

/** The smallest single replacement turning `a` into `b`: common prefix and suffix kept. */
export function minimalChange(a: string, b: string): TextChange | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

/**
 * `r` in the text `c` turns it into: null when either end falls inside what `c`
 * replaced, where no position means the same thing in both texts. A start at the
 * very point of an insertion moves past it (the text it began with follows the
 * insertion); an end there stays (the text it ended with comes before it).
 */
export function rangeThrough(
  r: { from: number; to: number },
  c: TextChange | null,
): { from: number; to: number } | null {
  if (!c) return r;
  const delta = c.insert.length - (c.to - c.from);
  const from = r.from < c.from ? r.from : r.from >= c.to ? r.from + delta : null;
  const to = r.to <= c.from ? r.to : r.to > c.to ? r.to + delta : null;
  if (from === null || to === null) return null;
  // A collapsed range at an insertion point: both ends name the same place.
  return from <= to ? { from, to } : { from: to, to };
}

/** The change that undoes `c`, made to `a` (the text `c` was made to). */
export function invertChange(c: TextChange, a: string): TextChange {
  return { from: c.from, to: c.from + c.insert.length, insert: a.slice(c.from, c.to) };
}

/**
 * Line `line` of `a`, as a line of `b`, the text `c` made of `a`. A line that
 * begins inside what `c` replaced has no counterpart, so it goes to the nearer
 * edge of the change: a scroll to it still lands next to the passage, never
 * nowhere. Past the last line, the last.
 */
export function lineThrough(line: number, a: string, b: string, c: TextChange | null): number {
  if (!c) return line;
  // Lines as the raw editor counts them (a lone `\r` ends one); past the last, the last.
  let at = 0;
  const br = /\r\n?|\n/g;
  for (let n = 1; n < line; n++) {
    br.lastIndex = at;
    const m = br.exec(a);
    if (!m) break;
    at = m.index + m[0].length;
  }
  const delta = c.insert.length - (c.to - c.from);
  const p =
    at < c.from ? at : at >= c.to ? at + delta : at - c.from <= c.to - at ? c.from : c.to + delta;
  return lineAt(b, p);
}
