// The conversation — right sidebar, glamour's Conversation shape adapted to
// tokens (not imported; house rule). Cole's ruling (vine msg 12): this is
// where human and agent work through what exists AND what doesn't yet —
// history gets real estate; the copy invites working-through, not Q&A.
// Selection-as-context rides as tier-colored chips above the input (the
// mapper's ground is typed nodes, so chips carry tier where glamour shows a
// count line).
//
// T11 — message-evidence navigation: every bubble is anchorable
// (data-message-id), a scrollRequest {messageId, span, seq} imperative prop
// scrolls to + flash-highlights the anchored message (span matched
// whitespace-tolerantly within the text, Contract 6), and the unconditional
// autoscroll-to-bottom YIELDS while a request is being serviced — otherwise
// any concurrent message would yank the viewport off the evidence.

import { AlertTriangle, SendHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator } from "./ActivityIndicator";
import { MessageBubble } from "./MessageBubble";
import type { AgentBadge } from "./state/activity";
import type { DocMeta, MapNode, Message, Tier } from "./types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const TIER_CHIP: Record<Tier, string> = {
  canon: "border-canon/60 text-canon",
  thread: "border-thread-tier/60 text-thread-tier",
  "story-local": "border-story-local/60 text-story-local",
  background: "border-background-tier/60 text-background-tier",
};

// How long a serviced scroll request holds the viewport (and the flash)
// before autoscroll may resume.
const FLASH_MS = 2000;

export type ScrollRequest = { messageId: string; span?: string | null; seq: number };

// C3 — a structured verb seeding the composer (the {payload, seq} idiom):
// sets the draft and focuses the input; the human appends intent or sends
// as-is. The ground chips ride selection, not this request.
export type ComposerSeed = { text: string; seq: number };

export function ConversationPanel({
  nodes,
  docs,
  selection,
  onDeselect,
  messages,
  onSend,
  disabled = false,
  agentBadge = null,
  scrollRequest,
  composerSeed,
}: {
  nodes: MapNode[];
  docs: DocMeta[];
  selection: MapNode[];
  onDeselect: (id: string) => void;
  messages: Message[];
  onSend: (text: string) => void;
  // Daemon unreachable (T1) — sends would silently vanish, so the composer
  // goes quiet rather than pretending.
  disabled?: boolean;
  // T8/R4 ACT1 — the agent's live badge, where the reply will land:
  // "thinking" pulses; "stalled" renders its own STATIC attention branch
  // (never the pulse — false-liveness would vouch for a stuck agent).
  agentBadge?: AgentBadge;
  scrollRequest?: ScrollRequest | null;
  composerSeed?: ComposerSeed | null;
}) {
  const [draft, setDraft] = useState("");
  const historyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The flash is render state; the yield is a ref (the autoscroll effect
  // must see it synchronously, not a render behind).
  const [flash, setFlash] = useState<{ messageId: string; span?: string | null } | null>(null);
  const servicingRef = useRef(false);
  // Seeded from the mount-time prop so a remount never replays a stale
  // request (the focusRequest idiom).
  const lastSeq = useRef(scrollRequest?.seq ?? 0);
  const lastSeedSeq = useRef(composerSeed?.seq ?? 0);

  // C3 — service a composer seed: overwrite the draft (a seed IS the new
  // intent; merging with a stale half-typed draft would garble both) and put
  // the caret at the end, ready for the human to append or just send.
  useEffect(() => {
    if (!composerSeed || composerSeed.seq === lastSeedSeq.current) return;
    lastSeedSeq.current = composerSeed.seq;
    setDraft(composerSeed.text);
    const len = composerSeed.text.length;
    // Caret after the commit that carries the new value — setSelectionRange
    // against the not-yet-updated controlled value would clamp to the old
    // draft's length.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(len, len);
    });
  }, [composerSeed]);

  useEffect(() => {
    if (!scrollRequest || scrollRequest.seq === lastSeq.current) return;
    lastSeq.current = scrollRequest.seq;
    const el = historyRef.current?.querySelector(
      `[data-message-id="${CSS.escape(scrollRequest.messageId)}"]`,
    );
    if (!el) return;
    servicingRef.current = true;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash({ messageId: scrollRequest.messageId, span: scrollRequest.span });
    const t = setTimeout(() => {
      servicingRef.current = false;
      setFlash(null);
    }, FLASH_MS);
    return () => clearTimeout(t);
  }, [scrollRequest]);

  useEffect(() => {
    if (messages.length === 0) return;
    // Yield to an in-flight evidence scroll — the bottom can wait.
    if (servicingRef.current) return;
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight });
  }, [messages]);

  const submit = () => {
    if (disabled) return;
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
          messages.map((m) => (
            <div
              key={m.id}
              data-message-id={m.id}
              className={flash?.messageId === m.id ? "mm-message-flash" : undefined}
            >
              <MessageBubble
                message={m}
                nodes={nodes}
                docs={docs}
                highlightSpan={flash?.messageId === m.id ? flash.span : undefined}
              />
            </div>
          ))
        )}
        {agentBadge === "thinking" && <ActivityIndicator />}
        {agentBadge === "stalled" && (
          // STATIC on purpose — no animation, no pulse: the honest signal
          // for "received your message, then went quiet past the TTL".
          <div className="flex items-center gap-2 text-[11px] text-attention" role="status">
            <AlertTriangle size={12} aria-hidden />
            <span>agent may be stuck — it took this in, then went quiet.</span>
          </div>
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
          ref={inputRef}
          disabled={disabled}
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
          <Button onClick={submit} disabled={disabled || !draft.trim()}>
            <SendHorizontal size={12} />
            Send
          </Button>
        </div>
      </div>
    </aside>
  );
}
