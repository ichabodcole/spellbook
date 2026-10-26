// The CSS Custom Highlight API, as the document views use it: painting ranges
// over text without touching the text. Both `Highlight` and `CSS.highlights` are
// recent, so either may be missing, and then nothing is painted.
//
// BUILT BY ADDING, NEVER BY SPREADING. `new Highlight(...ranges)` passes every
// range as an argument, and past the engine's argument limit (around a hundred
// thousand in Chrome) it throws: a find for a common word in a long document
// blanked the whole page that way. Each range is added on its own instead.

/** The page's highlight registry, or null where the API is missing. */
export type HighlightRegistry = Map<string, unknown> & { delete(name: string): boolean };

export function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const has = typeof (globalThis as { Highlight?: unknown }).Highlight === "function";
  return has && css?.highlights ? css.highlights : null;
}

/** A Highlight holding `ranges`, or null where the API is missing. */
export function makeHighlight(ranges: Iterable<Range>): unknown | null {
  const Ctor = (globalThis as { Highlight?: new () => { add(r: Range): unknown } }).Highlight;
  if (!Ctor) return null;
  const h = new Ctor();
  for (const r of ranges) h.add(r);
  return h;
}

/** Paint `ranges` under `name`, replacing what was there. False where nothing can be painted. */
export function paintHighlight(name: string, ranges: Iterable<Range>): boolean {
  const reg = highlightRegistry();
  const h = reg ? makeHighlight(ranges) : null;
  if (!reg || !h) return false;
  reg.set(name, h);
  return true;
}

export function clearHighlight(...names: string[]): void {
  const reg = highlightRegistry();
  for (const n of names) reg?.delete(n);
}
