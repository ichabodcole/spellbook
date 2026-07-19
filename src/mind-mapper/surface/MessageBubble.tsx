// Sibling of glamour's MessageBubble (adapted, not imported — house rule):
// user right / agent left, ground line above the bubble, who-caption below.
// Tokens instead of glamour's raw palette. Ground is the Claim G prefix
// grammar: bare id = node ref (resolved against nodes, rendered as today),
// doc:<id> = doc ref (rendered with the ContextRail doc-kind tint
// vocabulary), unresolvable refs drop silently.
//
// C2 — agent bubbles render markdown (state/markdown.ts: micromark, safe
// default) via dangerouslySetInnerHTML; user bubbles stay plain text with
// whitespace-pre-wrap. Span flash (T11/Contract 6) composes with the
// rendered markdown per the ratified mechanism: spanRange matches against
// the rendered DOM's textContent, the pure offset mapper (state/spanFlash)
// turns the range into per-text-node wrap instructions, and the effect below
// wraps via TreeWalker + splitText — never Range.surroundContents (it throws
// on ranges that partially overlap an element). Teardown unwraps the marks;
// a no-match degrades to the bubble-level mm-message-flash the panel already
// applies.

import { CheckSquare, FileText } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { KIND_BADGE } from "./ContextRail";
import { resolveGroundRef } from "./state/groundRefs";
import { renderMarkdown } from "./state/markdown";
import { mapRangeToNodes } from "./state/spanFlash";
import { spanRange, spanSegments } from "./state/spanMatch";
import type { DocMeta, MapNode, Message } from "./types";

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

function AgentMarkdown({ text, highlightSpan }: { text: string; highlightSpan?: string | null }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const bodyRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(html): deliberate extra dep — if React swaps the innerHTML, the old marks died with the old DOM and the effect must re-wrap against the fresh tree
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !highlightSpan) return;
    const marks = wrapInstructions(el, highlightSpan);
    return () => unwrapMarks(marks);
  }, [highlightSpan, html]);

  return (
    <div
      ref={bodyRef}
      className="mm-markdown"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: micromark output only — raw HTML in the source is encoded by the renderer (state/markdown.ts, tested)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function MessageBubble({
  message,
  nodes,
  docs,
  // T11 message-evidence flash: the whitespace-tolerant span to mark inside
  // this bubble's text while a scroll request is being serviced.
  highlightSpan,
}: {
  message: Message;
  nodes: MapNode[];
  docs: DocMeta[];
  highlightSpan?: string | null;
}) {
  const isUser = message.who === "user";
  const refs = message.ground
    .map((ref) => resolveGroundRef(ref, nodes, docs))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const nodeTitles = refs.filter((r) => r.type === "node").map((r) => r.node.title);
  const docRefs = refs.filter((r) => r.type === "doc");

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {refs.length > 0 && (
        <span className="mb-1 flex flex-wrap items-center gap-1 text-[10px] text-canon/90">
          <CheckSquare className="h-3 w-3" />
          about:{nodeTitles.length > 0 && <span>{nodeTitles.join(", ")}</span>}
          {docRefs.map((r) => (
            <span
              key={r.doc.id}
              className={`flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold ${KIND_BADGE[r.doc.kind]}`}
            >
              <FileText className="h-2.5 w-2.5" aria-hidden />
              {r.doc.title}
            </span>
          ))}
        </span>
      )}
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
          isUser ? "whitespace-pre-wrap bg-canon/15 text-ink" : "bg-surface-raised"
        } ${!isUser && message.kind === "info" ? "italic text-ink-faint" : "text-ink"}`}
      >
        {isUser ? (
          highlightSpan ? (
            spanSegments(message.text, highlightSpan).map((seg, i) =>
              seg.mark ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static 3-segment split
                <mark key={i} className="mm-span-mark">
                  {seg.text}
                </mark>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: static 3-segment split
                <span key={i}>{seg.text}</span>
              ),
            )
          ) : (
            message.text
          )
        ) : (
          <AgentMarkdown text={message.text} highlightSpan={highlightSpan} />
        )}
      </div>
      <span className="mt-0.5 text-[10px] text-ink-faint">{isUser ? "you" : "agent"}</span>
    </div>
  );
}
