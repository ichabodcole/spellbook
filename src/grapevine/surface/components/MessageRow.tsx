// F2–F8 — one message: the reply quote, the meta line, the body by kind.

import { cn } from "cn";
import { Button } from "@/ui/button";
import { aliasColor, fmtTime, fromLabel, isChannelNote, snippet } from "../state/feed";
import type { Message } from "../state/types";

// F3 — one body recipe per message kind.
const BODY: Record<string, string> = {
  message: "rounded-[10px] border border-edge bg-surface-raised px-3.5 py-2.5",
  topic:
    "rounded-[10px] border border-dashed border-grape bg-transparent px-3.5 py-2.5 italic text-grape-soft",
  announcement: "rounded-[10px] border border-edge bg-surface-raised px-3.5 py-2.5",
  status: "rounded-[10px] border border-edge bg-surface-raised px-3.5 py-2.5",
};

// F11 — the archive/unarchive frame. Same treatment as `topic` and for the same
// reason: both are channel-level facts, not somebody's message, and a `status`
// frame rendered as an utterance puts words in a participant's mouth. Neutral
// rather than accented — the grape dashes are the topic's identity.
const CHANNEL_NOTE =
  "rounded-[10px] border border-dashed border-edge bg-transparent px-3.5 py-2.5 italic text-ink-dim";

export function MessageRow({
  m,
  parent,
  canReply,
  onReply,
}: {
  m: Message;
  parent: Message | undefined;
  canReply: boolean;
  onReply: (m: Message) => void;
}) {
  const kind = m.kind || "message";
  const channelNote = isChannelNote(m);
  const isReply = m.in_reply_to != null;
  return (
    <div
      className={cn(
        "group my-2.5 max-w-[720px]",
        isReply && "ml-6",
        kind === "announcement" &&
          "rounded-md border-l-[3px] border-attention bg-announce-wash px-2.5 py-1.5",
      )}
    >
      {isReply && parent && (
        <div className="mb-1 flex max-w-full items-center gap-1.5 border-l-2 border-edge pl-2 font-mono text-[11px] text-ink-dim">
          <span className="text-grape-soft">↳</span>
          <span className="font-semibold" style={{ color: aliasColor(parent.from) }}>
            {parent.from}
          </span>
          <span className="truncate">{snippet(parent.text)}</span>
        </div>
      )}
      <div className="mb-1 flex items-baseline gap-2 text-xs">
        <span
          className={cn(
            "font-mono font-semibold",
            kind === "topic" && "text-grape-soft",
            channelNote && "text-ink-dim",
          )}
          style={kind === "topic" || channelNote ? undefined : { color: aliasColor(m.from) }}
        >
          {fromLabel(m)}
          {kind === "announcement" && <span className="italic opacity-60"> · announced</span>}
        </span>
        <span className="font-mono text-[11px] text-ink-dim">{fmtTime(m.ts)}</span>
        {canReply && kind !== "topic" && !channelNote && (
          <Button
            variant="ghost"
            size="inline"
            className="opacity-0 group-hover:opacity-100"
            onClick={() => onReply(m)}
          >
            reply
          </Button>
        )}
      </div>
      <div
        className={cn(
          "whitespace-pre-wrap break-words",
          channelNote ? CHANNEL_NOTE : (BODY[kind] ?? BODY.message),
        )}
      >
        {m.text}
      </div>
    </div>
  );
}
