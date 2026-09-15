// The status strip's counts (E18), after Operator's `useContentStats`: words
// are whitespace-separated runs (a contraction is one word), characters are the
// text's length including whitespace. Pure, so it is tested rather than trusted;
// the hook that debounces it lives beside the component that shows it.
export type ContentStats = { words: number; characters: number };

export function contentStats(text: string): ContentStats {
  const trimmed = text.trim();
  return { words: trimmed === "" ? 0 : trimmed.split(/\s+/).length, characters: text.length };
}

/** A relative time for the strip: "just now", "5 min ago", then a date. */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
