// C2 — the span-flash × markdown offset mapper (ratified mechanism): the
// span is matched against the rendered DOM's textContent (spanMatch's
// whitespace-tolerant rule), which yields ONE global character range; this
// pure helper maps that range onto the bubble's text nodes as per-node wrap
// instructions. The DOM half (TreeWalker collection + splitText + <mark>
// wrapping — never Range.surroundContents, which throws on partial element
// overlap) lives in MessageBubble; everything decidable without a DOM is
// decided here, tested.
//
// Invariant the mapping relies on: element.textContent is exactly the
// concatenation of its text nodes in tree order — the same order TreeWalker
// yields them.

export type WrapInstruction = {
  // Index into the text-node list (tree order).
  index: number;
  // Local character offsets within that node's text: [start, end).
  start: number;
  end: number;
};

export function mapRangeToNodes(
  nodes: { text: string }[],
  start: number,
  end: number,
): WrapInstruction[] {
  if (end <= start) return [];
  const out: WrapInstruction[] = [];
  let offset = 0;
  for (const [i, node] of nodes.entries()) {
    const len = node.text.length;
    const localStart = Math.max(start - offset, 0);
    const localEnd = Math.min(end - offset, len);
    // Zero-length overlaps produce no instruction — an empty <mark> is
    // invisible noise the teardown would still have to unwind.
    if (localStart < localEnd) out.push({ index: i, start: localStart, end: localEnd });
    offset += len;
    if (offset >= end) break;
  }
  return out;
}
