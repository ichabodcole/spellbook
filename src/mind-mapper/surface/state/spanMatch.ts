// Contract 6 — whitespace-tolerant span anchoring, the message-text half
// (T11): a span is a VERBATIM excerpt matched with \s+ across whatever
// reflow happened between capture and render (same rule DocViewer applies
// to doc content). A miss returns the text unmarked — an anchor that
// drifted must never crash or mis-highlight.

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The match as a character range — the shape the C2 markdown flash needs
// (matching runs against the rendered DOM's textContent; the range is then
// mapped onto text nodes by state/spanFlash.ts). null = no match, and the
// caller degrades to the bubble-level flash.
export function spanRange(
  content: string,
  span?: string | null,
): { start: number; end: number } | null {
  if (!span?.trim()) return null;
  const pattern = span.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const match = new RegExp(pattern).exec(content);
  if (!match) return null;
  return { start: match.index, end: match.index + match[0].length };
}

export function spanSegments(
  content: string,
  span?: string | null,
): { text: string; mark: boolean }[] {
  const range = spanRange(content, span);
  if (!range) return [{ text: content, mark: false }];
  return [
    { text: content.slice(0, range.start), mark: false },
    { text: content.slice(range.start, range.end), mark: true },
    { text: content.slice(range.end), mark: false },
  ].filter((seg) => seg.text.length > 0 || seg.mark);
}
