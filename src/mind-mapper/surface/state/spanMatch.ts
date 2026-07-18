// Contract 6 — whitespace-tolerant span anchoring, the message-text half
// (T11): a span is a VERBATIM excerpt matched with \s+ across whatever
// reflow happened between capture and render (same rule DocViewer applies
// to doc content). A miss returns the text unmarked — an anchor that
// drifted must never crash or mis-highlight.

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function spanSegments(
  content: string,
  span?: string | null,
): { text: string; mark: boolean }[] {
  if (!span?.trim()) return [{ text: content, mark: false }];
  const pattern = span.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const match = new RegExp(pattern).exec(content);
  if (!match) return [{ text: content, mark: false }];
  return [
    { text: content.slice(0, match.index), mark: false },
    { text: match[0], mark: true },
    { text: content.slice(match.index + match[0].length), mark: false },
  ].filter((seg) => seg.text.length > 0 || seg.mark);
}
