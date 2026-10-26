// Line numbers as the raw editor counts them. CodeMirror breaks a line at
// `\r\n`, at a lone `\r` and at `\n` alike, so every line number the kit shows
// or reports (a selection's lines, a note's lines, where the split view scrolls)
// counts the same three. Counting `\n` alone put a whole file with old-Mac
// endings on line 1, and the rendered view scrolled against the wrong line of
// the raw one.

/** The 1-based line holding `offset` in `text`. Clamped, never throws. */
export function lineAt(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let i = 0; i < at; i++) {
    const c = text.charCodeAt(i);
    // A `\r` is a break unless a `\n` follows it, which then ends the pair.
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) line++;
  }
  return line;
}
