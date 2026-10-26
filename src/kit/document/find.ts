// Find in the views that are not an editor (rendered, the rendered half of split,
// compare): the rules, without a DOM. `FindBar.tsx` walks the text nodes, builds
// the ranges and paints them; everything decidable from strings is here, with
// tests.
//
// TEXT IS SEARCHED IN SEGMENTS. A segment is the run of text nodes inside one
// block (a paragraph, a list item, a cell of the comparison), joined. A match
// never crosses a segment's edge, so the end of one paragraph and the start of
// the next cannot make a match the reader does not see, and in compare a match
// never runs from one side's line into the other's.

/** One match: the segment it is in and its offsets in that segment's joined text. */
export type FindMatch = { seg: number; from: number; to: number };

/** Every match of `query` in each segment, in order. Literal; case-folded unless `matchCase`. */
export function findMatches(
  segments: readonly string[],
  query: string,
  opts: { matchCase?: boolean } = {},
): FindMatch[] {
  if (query === "") return [];
  const fold = (s: string) => (opts.matchCase ? s : s.toLowerCase());
  const q = fold(query);
  const out: FindMatch[] = [];
  segments.forEach((text, seg) => {
    const t = fold(text);
    // A lower-cased string can change length (a dotted capital I), which would
    // move every offset after it; such a segment is searched as written instead.
    const hay = t.length === text.length ? t : text;
    const needle = t.length === text.length ? q : query;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length))
      out.push({ seg, from: at, to: at + needle.length });
  });
  return out;
}

/**
 * Where offset `at` of a segment falls among its text nodes, given each node's
 * length. A start at a boundary belongs to the node that begins there; an end at
 * a boundary to the node that ends there, so a match never begins or ends in a
 * node it has no characters in.
 */
export function locate(
  lengths: readonly number[],
  at: number,
  edge: "start" | "end",
): { node: number; offset: number } {
  let base = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i] as number;
    const inside = edge === "start" ? at < base + len : at <= base + len;
    if (inside && len > 0) return { node: i, offset: at - base };
    base += len;
  }
  const last = Math.max(0, lengths.length - 1);
  return { node: last, offset: lengths[last] ?? 0 };
}

/** The next (or previous) match, wrapping at either end. -1 when there are none. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** How many matches are painted at most: the current one and those around it. */
export const MAX_PAINTED = 1000;

/**
 * Which matches to paint, `[from, to)`: a window of at most `max` around the
 * current one, so a search with a hundred thousand matches paints a thousand.
 * The count still says how many there are.
 */
export function paintWindow(current: number, count: number, max = MAX_PAINTED): [number, number] {
  if (count <= max) return [0, count];
  const at = Math.max(0, current);
  const from = Math.min(Math.max(0, at - Math.floor(max / 2)), count - max);
  return [from, from + max];
}

/** "3 of 12", "No results", or nothing before anything is typed. */
export function countLabel(index: number, count: number, query: string): string {
  if (query === "") return "";
  if (count === 0) return "No results";
  return `${index + 1} of ${count}`;
}

/** The keys of a keydown, as `opensFind` reads them. */
export type KeyLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** Cmd-F on a Mac, Ctrl-F elsewhere: the find shortcut, and nothing that merely contains it. */
export function isFindKey(e: KeyLike, mac: boolean): boolean {
  if (e.key.toLowerCase() !== "f" || e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * What Cmd-F does, given where the keyboard focus is.
 *
 * - `own` — the find bar's own field: select what is in it, as a second Cmd-F
 *   in any find does.
 * - `open` — focus is in this view, anywhere else in the document pane around
 *   it (a view-mode button just clicked, the pane itself), or nowhere in
 *   particular (the page): open the kit's find bar.
 * - `pass` — anything else: a text field (the chat's composer, the search box),
 *   the raw editor, which has CodeMirror's own find, or another part of the
 *   page such as a sidebar. The key is left to whoever owns that.
 */
export function findKeyAct(focus: {
  inBar: boolean;
  textField: boolean;
  inEditor: boolean;
  /** Inside the document pane that holds this view, the view itself included. */
  inPane: boolean;
  /** On the page itself: nothing has focus. */
  nowhere: boolean;
}): "own" | "open" | "pass" {
  if (focus.inBar) return "own";
  if (focus.textField || focus.inEditor) return "pass";
  return focus.inPane || focus.nowhere ? "open" : "pass";
}
