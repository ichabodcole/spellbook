// Small pure rules about the text in the editor.

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
