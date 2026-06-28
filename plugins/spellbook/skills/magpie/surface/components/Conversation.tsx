// surface/components/Conversation.tsx
// Ported from imago's settled Conversation (the conversation spine + composer is
// a settled house pattern). Adapted to magpie's simpler Message shape — no
// prompt proposals / batches / quick-prompt library here; magpie's surface
// steers via element judgments, not generation proposals. The thread + composer
// + drop-target pattern is kept faithful.
import { ImagePlus, SendHorizontal, Terminal } from "lucide-react";
import { useRef, useState } from "react";
import { processFiles } from "../state/fileIntake";
import type { ClientToServer, MagpieState, Message } from "../state/types";

export function Conversation({
  state,
  send,
}: {
  state: MagpieState;
  send: (m: ClientToServer) => void;
}) {
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function submit() {
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    send({ type: "say", text: t });
  }

  return (
    <aside className="card flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider">
        <span className="section-title">Conversation</span>
      </div>

      {/* THREAD */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {state.conversation.length === 0 && (
          <p className="text-faint italic text-center mt-8">
            magpie reviews the board's elements with you here — confirm the good cutouts, drop the
            misses, retry the close calls.
          </p>
        )}
        {state.conversation.map((m) => (
          <Bubble key={m.id} m={m} send={send} />
        ))}
      </div>

      {/* COMPOSER — also a forgiving drop target for the board image */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-drop file zone */}
      <div
        className={`border-t p-3 flex flex-col gap-2 transition-colors ${
          dragging ? "border-accent/60 bg-accent/5" : "border-divider"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          processFiles(e.dataTransfer.files, send);
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          rows={3}
          className="textarea !resize-y min-h-[84px]"
          placeholder="talk to magpie about the breakdown…"
        />
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            processFiles(e.target.files, send);
            e.target.value = "";
          }}
        />
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-faint flex items-center gap-1">
            <Terminal className="w-3 h-3" /> also in your terminal
          </span>
          <span className="text-[11px] text-faint ml-auto">⌘↵</span>
          <button
            type="button"
            title="Drop in the composite board image"
            onClick={() => fileInput.current?.click()}
            className="btn-ghost !p-1.5"
          >
            <ImagePlus className="w-4 h-4" />
          </button>
          <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={submit}>
            <SendHorizontal className="w-4 h-4" /> Send
          </button>
        </div>
      </div>
    </aside>
  );
}

function Bubble({ m, send }: { m: Message; send: (m: ClientToServer) => void }) {
  if (m.kind === "gesture") {
    return (
      <div className="text-center text-[11px] text-faint italic py-0.5 break-words [overflow-wrap:anywhere]">
        {m.text}
      </div>
    );
  }

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] text-sm rounded-lg rounded-br-sm px-3 py-2 bg-accent/20 border border-accent/30 text-ink break-words [overflow-wrap:anywhere]">
          {m.text}
        </div>
      </div>
    );
  }

  // agent messages
  const asking = m.kind === "question";
  const action = m.action; // an optional one-click CTA (a shortcut for saying it)
  return (
    <div className="flex gap-2">
      <span className="text-base shrink-0 mt-0.5" aria-hidden>
        🐦
      </span>
      <div className="flex flex-col gap-2 max-w-[88%]">
        {m.text && (
          <div
            className={`text-sm rounded-lg rounded-tl-sm px-3 py-2 break-words [overflow-wrap:anywhere] ${
              asking
                ? "bg-attention/40 border border-attention/40 text-attention-ink"
                : "bg-surface border border-edge text-ink"
            }`}
          >
            {m.text}
          </div>
        )}
        {m.kind === "question" && m.options && m.options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {m.options.map((o) => (
              <button
                type="button"
                key={o}
                className="chip"
                onClick={() => send({ type: "say", text: o })}
              >
                {o}
              </button>
            ))}
          </div>
        )}
        {action && (
          <button
            type="button"
            onClick={() => send(action.command)}
            className="btn-primary !px-3 !py-1.5 text-xs self-start"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
