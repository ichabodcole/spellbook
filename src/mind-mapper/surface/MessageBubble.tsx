// Sibling of glamour's MessageBubble (adapted, not imported — house rule):
// user right / agent left, ground line above the bubble, who-caption below.
// Tokens instead of glamour's raw palette. Ground is the Claim G prefix
// grammar: bare id = node ref (resolved against nodes, rendered as today),
// doc:<id> = doc ref (rendered with the ContextRail doc-kind tint
// vocabulary), zone:<id> = the board the human was on (R11 SEAM 4),
// unresolvable refs drop silently.
//
// C2 — agent bubbles render markdown via the shared <Markdown> component
// (MDVIEW extraction: the micromark render + TreeWalker span-flash now lives
// in Markdown.tsx, consumed by both the chat and the DocViewer); user bubbles
// stay plain text with whitespace-pre-wrap. Span flash (T11/Contract 6)
// composes with the rendered markdown per the ratified mechanism — see
// Markdown.tsx; a no-match degrades to the bubble-level mm-message-flash the
// panel already applies.
//
// R11 SEAM 3 — CHANNEL awareness. A message that arrived through a side
// channel (the canvas ramble, an analyze ask) wears a channel chip and a
// dashed plate (the staging vocabulary: an intermediate state awaiting the
// agent, not a settled thing) and collapses to a one-line summary by default,
// because the human already knows what they said. Expanding is one click and
// the choice sticks per bubble.
//
// R11 SEAM 2 — the activity state renders HERE, on the message being worked,
// not in a panel (a new panel would repeat the mistake this round undoes). It
// sits OUTSIDE the collapsible body so a collapsed ramble still shouts that
// it's being worked.

import {
  AlertTriangle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FileText,
  Layers,
} from "lucide-react";
import { useState } from "react";
import { ActivityIndicator } from "./ActivityIndicator";
import { Markdown } from "./Markdown";
import type { AgentBadge } from "./state/activity";
import { kindBadgeClass, NEUTRAL_BADGE } from "./state/docKind";
import { resolveGroundRef } from "./state/groundRefs";
import { ACTIVITY_ROW_LABEL } from "./state/messageActivity";
import {
  channelChipClass,
  channelLabel,
  channelTitle,
  collapsesByDefault,
  isSideChannel,
  messageSummary,
} from "./state/messageChannel";
import { spanSegments } from "./state/spanMatch";
import type { DocMeta, MapNode, Message, Zone } from "./types";

// The working ring — unmissable without being loud, and keyed to the tint each
// state already owns elsewhere (thread-tier = the agent, attention = trouble).
const ACTIVITY_RING: Record<Exclude<AgentBadge, null>, string> = {
  thinking: "ring-1 ring-thread-tier/60",
  stalled: "ring-1 ring-attention/60",
};

export function MessageBubble({
  message,
  nodes,
  docs,
  zones = [],
  // T11 message-evidence flash: the whitespace-tolerant span to mark inside
  // this bubble's text while a scroll request is being serviced.
  highlightSpan,
  // R11 SEAM 2: the agent state attributed to THIS message (null = none).
  activity = null,
}: {
  message: Message;
  nodes: MapNode[];
  docs: DocMeta[];
  zones?: Zone[];
  highlightSpan?: string | null;
  activity?: AgentBadge;
}) {
  const isUser = message.who === "user";
  const sideChannel = isSideChannel(message.channel);
  const [expanded, setExpanded] = useState(() => !collapsesByDefault(message));
  const refs = message.ground
    .map((ref) => resolveGroundRef(ref, nodes, docs, zones))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const nodeTitles = refs.filter((r) => r.type === "node").map((r) => r.node.title);
  const docRefs = refs.filter((r) => r.type === "doc");
  const zoneRefs = refs.filter((r) => r.type === "zone");

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {refs.length > 0 && (
        <span className="mb-1 flex flex-wrap items-center gap-1 text-[10px] text-canon/90">
          <CheckSquare className="h-3 w-3" />
          {/* "about:" claims the message is ABOUT something — true of node and
              doc refs, false of a bare zone ref (that's where you were, not
              what you meant). A zone-only ground line says "from:". */}
          {nodeTitles.length > 0 || docRefs.length > 0 ? "about:" : "from:"}
          {nodeTitles.length > 0 && <span>{nodeTitles.join(", ")}</span>}
          {docRefs.map((r) => (
            // K1: the chip is a doc REFERENCE (it renders the title either
            // way), so an untyped doc wears the neutral plate rather than
            // absence — the no-badge rule applies to kind badges only.
            <span
              key={r.doc.id}
              className={`flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold ${kindBadgeClass(r.doc.kind) ?? NEUTRAL_BADGE}`}
            >
              <FileText className="h-2.5 w-2.5" aria-hidden />
              {r.doc.title}
            </span>
          ))}
          {zoneRefs.map((r) => (
            // R11 SEAM 4: the board the human was on when they sent — the Z3
            // placement meaning, carried as context rather than dropped.
            <span
              key={r.zone.id}
              className="flex items-center gap-0.5 rounded-full border border-edge px-1.5 py-0.5 text-ink-dim"
              title={`sent from the ${r.zone.name} zone`}
            >
              <Layers className="h-2.5 w-2.5" aria-hidden />
              {r.zone.name}
            </span>
          ))}
        </span>
      )}
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
          isUser ? "whitespace-pre-wrap bg-canon/15 text-ink" : "bg-surface-raised"
        } ${sideChannel && isUser ? "border border-dashed border-canon/40 bg-canon/10" : ""} ${
          !isUser && message.kind === "info" ? "italic text-ink-faint" : "text-ink"
        } ${activity ? ACTIVITY_RING[activity] : ""}`}
      >
        {sideChannel && isUser && (
          // The channel line: what this is and where it came from. The whole
          // row is the expand affordance when there's something folded away.
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            title={channelTitle(message.channel)}
            className={`-mx-1 mb-1 flex w-[calc(100%+0.5rem)] items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase tracking-wide ${channelChipClass(message.channel)}`}
          >
            {expanded ? (
              <ChevronDown size={10} aria-hidden />
            ) : (
              <ChevronRight size={10} aria-hidden />
            )}
            {channelLabel(message.channel)}
          </button>
        )}
        {!expanded ? (
          <p className="italic text-ink-dim">{messageSummary(message.text)}</p>
        ) : isUser ? (
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
          <Markdown text={message.text} highlightSpan={highlightSpan} />
        )}
      </div>
      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-faint">
        {isUser ? "you" : "agent"}
        {/* R11 SEAM 2 — outside the collapsible body on purpose: a folded
            ramble must still show that it's being worked. The reply IS
            completion, so there is no third "done" state to render. */}
        {activity === "thinking" && <ActivityIndicator label={ACTIVITY_ROW_LABEL.thinking} />}
        {activity === "stalled" && (
          // STATIC — never the pulse (false liveness would vouch for a stuck
          // agent; R4 ACT1's standing rule).
          <span className="flex items-center gap-1 text-attention" role="status">
            <AlertTriangle size={10} aria-hidden />
            {ACTIVITY_ROW_LABEL.stalled}
          </span>
        )}
      </span>
    </div>
  );
}
