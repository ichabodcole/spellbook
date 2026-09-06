// P1–P7 — the compose box (join mode, unarchived channel only), the reply
// banner above it, and the archived note that replaces it.

import { useEffect, useRef, useState } from "react";
import { aliasColor, snippet } from "../state/feed";
import type { Message } from "../state/types";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function ArchivedNote() {
  return (
    <div className="sticky bottom-0 bg-linear-to-t from-bg from-80% to-transparent pt-3 pb-2 text-center font-mono text-xs text-attention">
      🔒 this channel is archived — read-only
    </div>
  );
}

export function Composer({
  alias,
  replyingTo,
  onCancelReply,
  onSend,
}: {
  alias: string;
  replyingTo: Message | null;
  onCancelReply: () => void;
  onSend: (draft: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // F6 — choosing a reply focuses the box.
  useEffect(() => {
    if (replyingTo) inputRef.current?.focus();
  }, [replyingTo]);

  const submit = async () => {
    if (await onSend(draft)) setDraft(""); // P6 — clear on success only
  };

  return (
    <div className="sticky bottom-0 bg-linear-to-t from-bg from-80% to-transparent pt-3 pb-1">
      {replyingTo && (
        <div className="-mb-px flex items-center gap-1.5 rounded-t-lg border border-edge border-l-2 border-l-grape bg-surface-raised px-2.5 py-1.5 font-mono text-xs text-ink-dim">
          <span className="text-grape-soft">↳</span>
          <span>replying to</span>
          <span className="font-mono font-semibold" style={{ color: aliasColor(replyingTo.from) }}>
            {replyingTo.from}
          </span>
          <span className="flex-1 truncate">{snippet(replyingTo.text || "")}</span>
          <Button
            variant="ghost"
            size="auto"
            className="ml-auto px-1 text-xs"
            aria-label="Cancel reply"
            onClick={onCancelReply}
          >
            ✕
          </Button>
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textarea
          ref={inputRef}
          className="max-h-40 flex-1 resize-none text-sm leading-normal"
          rows={1}
          value={draft}
          placeholder={`message as ${alias}…`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // P4 — Enter sends, Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="submit"
          variant="primary"
          size="auto"
          className="self-end px-4 py-2.5 text-sm"
          disabled={!draft.trim()}
        >
          send
        </Button>
      </form>
    </div>
  );
}
