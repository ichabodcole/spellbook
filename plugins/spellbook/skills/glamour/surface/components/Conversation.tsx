import { useState } from "react";
import type { LibraryItem, Message } from "../state/types";
import { ActivityIndicator } from "./ActivityIndicator";
import { MessageBubble } from "./MessageBubble";

export function Conversation({
  messages,
  library,
  grounded,
  thinking,
  statusText,
  onSend,
}: {
  messages: Message[];
  library: LibraryItem[];
  grounded: string[];
  thinking: boolean;
  statusText: string;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const isGrounded = grounded.length > 0;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <aside className="flex min-h-0 w-[360px] flex-1 flex-col border-l border-white/10 bg-slate-900/40 xl:w-[420px] 2xl:w-[480px]">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-xs text-slate-500">
            talk about the style — drop files or images anytime.
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} library={library} />)
        )}
      </div>

      {thinking && (
        <div className="px-4 pb-1">
          <ActivityIndicator label={statusText || undefined} />
        </div>
      )}

      <div className="border-t border-white/10 p-3">
        {isGrounded && (
          <div className="mb-2 flex items-center">
            <span className="text-[10px] text-fuchsia-300">
              grounded to {grounded.length} selected item
              {grounded.length > 1 ? "s" : ""}
            </span>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            isGrounded ? "say what you like about the selection…" : "talk about the style…"
          }
          className="min-h-16 max-h-64 w-full resize-y rounded bg-white/5 p-2 text-xs text-slate-200 outline-none ring-fuchsia-400/50 focus:ring-1"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="rounded bg-fuchsia-600/80 px-3 py-1 text-xs text-fuchsia-50 hover:bg-fuchsia-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}
