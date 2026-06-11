import { GitMerge, MessageSquare, Send, Star } from "lucide-react";
import { useState } from "react";
import type { ClientToServer, GlamourState } from "../state/types";

interface AnalysisStudioProps {
  state: GlamourState;
  send: (m: ClientToServer) => void;
}

export function AnalysisStudio({ state, send }: AnalysisStudioProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const items = state.influences
    .filter((i) => (drafts[i.id] ?? "").trim())
    .map((i) => ({ id: i.id, text: (drafts[i.id] ?? "").trim() }));

  function sendCorrections() {
    send({ type: "feedback", scope: "analysis", items, overall: "" });
    setDrafts({});
    setOpen({});
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="section-title">What I see in each — correct me at the source</div>
      <p className="text-faint">
        My read of each image (the picture + your note). The direction is all of these combined.
      </p>
      <div className="space-y-2.5">
        {state.influences.map((inf) => (
          <div key={inf.id} className="inset p-3">
            <div className="flex gap-3">
              <div className="tile w-16 h-16 shrink-0 relative">
                <img src={inf.src} alt={inf.name} />
                {inf.starred && (
                  <div className="absolute top-0.5 right-0.5">
                    <Star className="w-3 h-3 text-amber-300 fill-current" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-mono text-slate-400 truncate">{inf.name}</span>
                  {inf.aspects.map((a) => (
                    <span key={a} className="badge-muted !text-[9px] !py-0">
                      {a}
                    </span>
                  ))}
                </div>
                <p className="text-[13px] text-slate-300 leading-relaxed">
                  {inf.read || "…reading…"}
                </p>
                <button
                  type="button"
                  className="btn-ghost mt-2 !text-[11px]"
                  onClick={() => setOpen((o) => ({ ...o, [inf.id]: !o[inf.id] }))}
                >
                  <MessageSquare className="w-3 h-3" />
                  {open[inf.id] ? "cancel" : "that's not quite it"}
                </button>
                {open[inf.id] && (
                  <div className="mt-2">
                    <textarea
                      className="textarea h-16 !text-[12px]"
                      value={drafts[inf.id] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [inf.id]: e.target.value }))}
                      placeholder="you've got the color, but it's really the grain I care about…"
                    />
                  </div>
                )}
                {!open[inf.id] && (drafts[inf.id] ?? "").trim() && (
                  <span className="badge-accent mt-2 inline-block">comment staged</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          className={`btn-outline${items.length === 0 ? " opacity-50 pointer-events-none" : ""}`}
          onClick={sendCorrections}
          disabled={items.length === 0}
        >
          <Send className="w-4 h-4" />
          Send corrections &amp; re-read
          {items.length > 0 && <span> ({items.length})</span>}
        </button>
        <button
          type="button"
          className="btn-primary ml-auto"
          onClick={() => send({ type: "nudge", label: "synthesize the direction" })}
        >
          <GitMerge className="w-4 h-4" />
          Looks right — synthesize the direction
        </button>
      </div>
    </div>
  );
}
