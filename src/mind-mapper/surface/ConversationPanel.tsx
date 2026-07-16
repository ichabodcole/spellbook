// The conversation — right sidebar, glamour's Conversation shape adapted to
// tokens (not imported; house rule). Cole's ruling (vine msg 12): this is
// where human and agent work through what exists AND what doesn't yet —
// history gets real estate; the copy invites working-through, not Q&A.
// Selection-as-context rides as tier-colored chips above the input (the
// mapper's ground is typed nodes, so chips carry tier where glamour shows a
// count line). No agent behind it in the spike — the seed message says so in
// the agent's own bubble.

import { SendHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MessageBubble } from "./MessageBubble";
import type { MapNode, Message, Tier } from "./types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const TIER_CHIP: Record<Tier, string> = {
  canon: "border-canon/60 text-canon",
  thread: "border-thread-tier/60 text-thread-tier",
  "story-local": "border-story-local/60 text-story-local",
  background: "border-background-tier/60 text-background-tier",
};

export function ConversationPanel({
  nodes,
  selection,
  onDeselect,
  messages,
  onSend,
}: {
  nodes: MapNode[];
  selection: MapNode[];
  onDeselect: (id: string) => void;
  messages: Message[];
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length === 0) return;
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <aside className="flex min-h-0 w-80 shrink-0 flex-col border-l border-edge bg-surface xl:w-96">
      <div ref={historyRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-xs text-ink-faint">
            think out loud — pull nodes into context and work through where it goes.
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} nodes={nodes} />)
        )}
      </div>

      <div className="border-t border-edge p-3">
        {selection.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {selection.map((n) => (
              <Badge key={n.id} className={TIER_CHIP[n.tier]}>
                {n.title}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${n.title} from context`}
                  onClick={() => onDeselect(n.id)}
                  className="h-3 w-3"
                >
                  <X size={11} />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            selection.length > 0
              ? `working with ${selection.map((n) => n.title).join(", ")}…`
              : "work it through…"
          }
          className="min-h-16 max-h-64 resize-y p-2 text-xs"
        />
        <div className="mt-2 flex justify-end">
          <Button onClick={submit} disabled={!draft.trim()}>
            <SendHorizontal size={12} />
            Send
          </Button>
        </div>
      </div>
    </aside>
  );
}
