import { FileText, Palette, Star, Trash2 } from "lucide-react";
import { ASPECTS } from "../state/constants";
import type { ClientToServer, Context, GlamourState, Influence } from "../state/types";

interface GatherStudioProps {
  state: GlamourState;
  send: (m: ClientToServer) => void;
  selInf: string | null;
  selCtx: string | null;
  onSelInf: (id: string | null) => void;
  onSelCtx: (id: string | null) => void;
}

export function GatherStudio({
  state,
  send,
  selInf,
  selCtx,
  onSelInf,
  onSelCtx,
}: GatherStudioProps) {
  const sel: Influence | null = state.influences.find((i) => i.id === selInf) ?? null;
  const selCtxObj: Context | null = state.contexts.find((c) => c.id === selCtx) ?? null;

  function toggleAspect(aspect: string) {
    if (!sel) return;
    const next = sel.aspects.includes(aspect)
      ? sel.aspects.filter((x) => x !== aspect)
      : [...sel.aspects, aspect];
    send({ type: "influence.annotate", id: sel.id, patch: { aspects: next } });
  }

  function toggleStar() {
    if (!sel) return;
    send({
      type: "influence.annotate",
      id: sel.id,
      patch: { starred: !sel.starred },
    });
  }

  function toggleStarCtx() {
    if (!selCtxObj) return;
    send({
      type: "context.annotate",
      id: selCtxObj.id,
      patch: { starred: !selCtxObj.starred },
    });
  }

  if (!sel && !selCtxObj) {
    return (
      <div className="card p-10 text-center">
        <Palette className="w-10 h-10 text-violet-400/60 mx-auto mb-3" />
        <div className="page-title mb-1">Two ways in</div>
        <p className="text-muted max-w-md mx-auto">
          <span className="text-violet-200">Know the look?</span> Drop references, annotate what
          matters, and steer the agent toward it.
        </p>
        <p className="text-muted max-w-md mx-auto mt-2">
          <span className="text-violet-200">Still discovering?</span> Drop what you have — reference
          images <em>and</em> context files (.md / .txt world-building) — and ask the agent for a
          few contrasting directions. One might spark it.
        </p>
      </div>
    );
  }

  if (sel) {
    return (
      <div className="card p-5 space-y-4">
        <div className="section-title">Annotate · {sel.name}</div>
        <div className="flex gap-4">
          <div className="tile w-40 h-40 shrink-0">
            <img src={sel.src} alt={sel.name} />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <div className="text-faint mb-1.5">what about this image matters?</div>
              <div className="flex flex-wrap gap-1.5">
                {ASPECTS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={sel.aspects.includes(a) ? "chip-on" : "chip"}
                    onClick={() => toggleAspect(a)}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <button
                type="button"
                onClick={toggleStar}
                className={`inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                  sel.starred
                    ? "bg-amber-500/15 border-amber-500/40 text-amber-200"
                    : "border-[#3a3050] text-slate-400 hover:text-slate-200"
                }`}
              >
                <Star className={`w-4 h-4 ${sel.starred ? "fill-current" : ""}`} />
                {sel.starred ? "starred — this one matters more" : "star this one"}
              </button>
            </div>
            <div>
              <div className="text-faint mb-1.5">
                why you chose it <span className="opacity-60">(optional)</span>
              </div>
              <textarea
                key={sel.id}
                className="textarea h-20"
                defaultValue={sel.note}
                onBlur={(e) => {
                  const next = e.target.value;
                  if (next !== sel.note) {
                    send({
                      type: "influence.annotate",
                      id: sel.id,
                      patch: { note: next },
                    });
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                send({ type: "influence.remove", id: sel.id });
                onSelInf(null);
              }}
            >
              <Trash2 className="w-3 h-3" />
              remove
            </button>
          </div>
        </div>
      </div>
    );
  }

  // selCtxObj selected
  if (selCtxObj) {
    return (
      <div className="card p-5 space-y-4">
        <div className="section-title flex items-center gap-2">
          <FileText className="w-4 h-4 text-violet-300" />
          {selCtxObj.name}
        </div>
        <div className="inset p-3 max-h-48 overflow-y-auto">
          <pre className="text-[12px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
            {selCtxObj.text}
          </pre>
        </div>
        <button
          type="button"
          onClick={toggleStarCtx}
          className={`inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition-colors ${
            selCtxObj.starred
              ? "bg-amber-500/15 border-amber-500/40 text-amber-200"
              : "border-[#3a3050] text-slate-400 hover:text-slate-200"
          }`}
        >
          <Star className={`w-4 h-4 ${selCtxObj.starred ? "fill-current" : ""}`} />
          {selCtxObj.starred ? "starred — important context" : "star this one"}
        </button>
        <div>
          <div className="text-faint mb-1.5">
            why you provided it / what to focus on <span className="opacity-60">(optional)</span>
          </div>
          <textarea
            key={selCtxObj.id}
            className="textarea h-20"
            defaultValue={selCtxObj.note}
            onBlur={(e) => {
              const next = e.target.value;
              if (next !== selCtxObj.note) {
                send({
                  type: "context.annotate",
                  id: selCtxObj.id,
                  patch: { note: next },
                });
              }
            }}
          />
        </div>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            send({ type: "context.remove", id: selCtxObj.id });
            onSelCtx(null);
          }}
        >
          <Trash2 className="w-3 h-3" />
          remove
        </button>
      </div>
    );
  }

  return null;
}
