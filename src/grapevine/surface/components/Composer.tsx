// P1–P7 — the compose box (join mode, unarchived channel only), the reply
// banner above it, and the archived note that replaces it.

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Field, FieldLabel } from "@/ui/field";
import { Textarea } from "@/ui/textarea";
import { aliasColor, snippet } from "../state/feed";
import type { Message } from "../state/types";

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
  const draftId = useId();
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
            size="icon-xs"
            className="ml-auto"
            aria-label="Cancel reply"
            onClick={onCancelReply}
          >
            ✕
          </Button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field orientation="horizontal" className="items-end">
          <FieldLabel htmlFor={draftId} className="sr-only">
            Message
          </FieldLabel>
          <Textarea
            id={draftId}
            ref={inputRef}
            className="max-h-40 min-h-0 flex-1 resize-none"
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
          <Button type="submit" disabled={!draft.trim()}>
            send
          </Button>
        </Field>
      </form>
    </div>
  );
}
