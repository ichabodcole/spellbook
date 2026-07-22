// MDVIEW (finding #9) — the shared markdown renderer + TreeWalker span-flash,
// extracted from MessageBubble's module-private AgentMarkdown so BOTH the chat
// bubbles and the context DocViewer render markdown with the same
// evidence-span highlight. The mechanism (ratified, T11/Contract 6): render
// micromark HTML via dangerouslySetInnerHTML (safe default — raw HTML in the
// source is encoded, so no sanitizer/injection path), then match the
// whitespace-tolerant span against the rendered DOM's textContent, turn the
// range into per-text-node wrap instructions (state/spanFlash), and wrap via
// TreeWalker + splitText — never Range.surroundContents (it throws on ranges
// that partially overlap an element). Teardown unwraps + normalizes so a
// repeat flash maps clean offsets. A span crossing a <strong> yields two marks
// and that's correct.

import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "./state/markdown";
import { mapRangeToNodes } from "./state/spanFlash";
import { spanRange } from "./state/spanMatch";

// The DOM half of the flash: wrap each instructed slice in a <mark>. The
// instructions are per-node with local offsets, so splitting node i never
// invalidates node j's offsets — each wrap touches only its own text node.
function wrapInstructions(root: HTMLElement, span: string): HTMLElement[] {
  const range = spanRange(root.textContent ?? "", span);
  if (!range) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);
  const instructions = mapRangeToNodes(
    textNodes.map((t) => ({ text: t.data })),
    range.start,
    range.end,
  );
  const marks: HTMLElement[] = [];
  for (const ins of instructions) {
    const target = textNodes[ins.index];
    if (!target) continue;
    const slice = ins.start > 0 ? target.splitText(ins.start) : target;
    if (ins.end - ins.start < slice.data.length) slice.splitText(ins.end - ins.start);
    const mark = document.createElement("mark");
    mark.className = "mm-span-mark";
    slice.parentNode?.insertBefore(mark, slice);
    mark.appendChild(slice);
    marks.push(mark);
  }
  return marks;
}

function unwrapMarks(marks: HTMLElement[]) {
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    // Merge the split text nodes back so a repeat flash maps clean offsets.
    parent.normalize();
  }
}

export function Markdown({
  text,
  highlightSpan,
  // DocViewer's old mount-scroll: after wrapping, bring the first mark into
  // view (the chat leaves this off — its scroll is scrollRequest-driven).
  scrollToHighlight,
  // Extends the base mm-markdown styling (DocViewer wants a larger,
  // font-story register than the chat bubble's text-xs).
  className,
}: {
  text: string;
  highlightSpan?: string | null;
  scrollToHighlight?: boolean;
  className?: string;
}) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const bodyRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(html): deliberate extra dep — if React swaps the innerHTML, the old marks died with the old DOM and the effect must re-wrap against the fresh tree
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !highlightSpan) return;
    const marks = wrapInstructions(el, highlightSpan);
    if (scrollToHighlight && marks[0]) marks[0].scrollIntoView({ block: "center" });
    return () => unwrapMarks(marks);
  }, [highlightSpan, html, scrollToHighlight]);

  return (
    <div
      ref={bodyRef}
      className={className ? `mm-markdown ${className}` : "mm-markdown"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: micromark output only — raw HTML in the source is encoded by the renderer (state/markdown.ts, tested)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
