// Sibling of glamour's MessageBubble (adapted, not imported — house rule):
// user right / agent left, ground line above the bubble, who-caption below.
// Tokens instead of glamour's raw palette. Ground is the Claim G prefix
// grammar: bare id = node ref (resolved against nodes, rendered as today),
// doc:<id> = doc ref (rendered with the ContextRail doc-kind tint
// vocabulary), unresolvable refs drop silently.

import { CheckSquare, FileText } from "lucide-react";
import { KIND_BADGE } from "./ContextRail";
import { resolveGroundRef } from "./state/groundRefs";
import { spanSegments } from "./state/spanMatch";
import type { DocMeta, MapNode, Message } from "./types";

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
          isUser ? "bg-canon/15 text-ink" : "bg-surface-raised"
        } ${!isUser && message.kind === "info" ? "italic text-ink-faint" : "text-ink"}`}
      >
        {highlightSpan
          ? spanSegments(message.text, highlightSpan).map((seg, i) =>
              seg.mark ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static 3-segment split
                <mark key={i} className="rounded-sm bg-canon/25 px-0.5 text-ink">
                  {seg.text}
                </mark>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: static 3-segment split
                <span key={i}>{seg.text}</span>
              ),
            )
          : message.text}
      </div>
      <span className="mt-0.5 text-[10px] text-ink-faint">{isUser ? "you" : "agent"}</span>
    </div>
  );
}
