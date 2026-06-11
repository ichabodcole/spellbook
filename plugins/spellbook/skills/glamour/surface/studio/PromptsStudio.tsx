import { MessageSquarePlus, Send, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ClientToServer, GlamourState } from "../state/types";

interface PromptsStudioProps {
  state: GlamourState;
  send: (m: ClientToServer) => void;
}

export function PromptsStudio({ state, send }: PromptsStudioProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [overall, setOverall] = useState("");

  const items = state.prompts
    .filter((p) => (drafts[p.id] ?? "").trim())
    .map((p) => ({ id: p.id, text: (drafts[p.id] ?? "").trim() }));

  const count = items.length + (overall.trim() ? 1 : 0);

  function handleSendFeedback() {
    send({
      type: "feedback",
      scope: "prompts",
      items,
      overall: overall.trim(),
    });
    setDrafts({});
    setOpen({});
    setOverall("");
  }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center">
        <div className="section-title">Prompts I'll send · {state.prompts.length}</div>
        <span className="text-faint ml-auto">comment to tweak before generating</span>
      </div>

      <div className="space-y-2">
        {state.prompts.map((p, idx) => (
          <div key={p.id} className="inset p-2.5">
            <div className="flex items-start gap-2">
              <span className="text-[10px] font-mono text-slate-600 mt-0.5">#{idx + 1}</span>
              <span className="text-mono !text-[11px] text-slate-400 leading-relaxed flex-1">
                {p.text}
              </span>
              <button
                type="button"
                className="shrink-0 text-slate-600 hover:text-violet-300"
                onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
              </button>
            </div>
            {open[p.id] && (
              <div className="mt-2">
                <textarea
                  className="textarea h-14 !text-[12px]"
                  value={drafts[p.id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  placeholder="tweak just this one…"
                />
              </div>
            )}
            {!open[p.id] && (drafts[p.id] ?? "").trim() && (
              <span className="badge-accent mt-1.5 inline-block">comment staged</span>
            )}
          </div>
        ))}
      </div>

      <div>
        <div className="text-faint mb-1.5">a note across all of them (optional)</div>
        <textarea
          className="textarea h-14 !text-[12px]"
          value={overall}
          onChange={(e) => setOverall(e.target.value)}
          placeholder="e.g. all too literal — push more abstract / atmospheric…"
        />
      </div>

      <div className="flex gap-2 pt-1 items-center">
        <button
          type="button"
          className={`btn-outline${count === 0 ? " opacity-50 pointer-events-none" : ""}`}
          onClick={handleSendFeedback}
          disabled={count === 0}
        >
          <Send className="w-4 h-4" />
          Send feedback &amp; revise{count > 0 && <span> ({count})</span>}
        </button>
        <button
          type="button"
          className="btn-primary ml-auto"
          onClick={() => send({ type: "generate" })}
        >
          <Sparkles className="w-4 h-4" />
          Looks good — generate
        </button>
      </div>
    </div>
  );
}
