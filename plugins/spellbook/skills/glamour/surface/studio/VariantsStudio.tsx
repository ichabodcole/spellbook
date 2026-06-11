import { CheckCheck, Heart, Info, RefreshCw, Star } from "lucide-react";
import { useState } from "react";
import { Lightbox } from "../components/Lightbox";
import { STEER_CHIPS } from "../state/constants";
import type { ClientToServer, GlamourState, Variant } from "../state/types";

interface VariantsStudioProps {
  state: GlamourState;
  send: (m: ClientToServer) => void;
}

export function VariantsStudio({ state, send }: VariantsStudioProps) {
  const [zoom, setZoom] = useState<Variant | null>(null);
  const [steerText, setSteerText] = useState("");
  const [promptOpen, setPromptOpen] = useState<Record<string, boolean>>({});

  function handleRegenerate() {
    if (steerText.trim()) {
      send({ type: "steer", text: steerText.trim() });
    }
    send({ type: "generate" });
    setSteerText("");
  }

  return (
    <div className="space-y-4">
      <div className="card p-5 space-y-4">
        <div className="flex items-center">
          <div className="section-title">Round {state.round} · pick what's working</div>
          <span className="text-faint ml-auto">♥ like · ★ canonical · ⓘ prompt</span>
        </div>

        {!state.variants.length && (
          <div className="inset p-8 text-center text-faint">
            no variants yet — the agent is generating…
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          {state.variants.map((v) => (
            <div key={v.id} className="tile">
              {/* Zoom button sits behind controls */}
              <button
                type="button"
                className="absolute inset-0 z-0 block w-full h-full"
                onClick={() => setZoom(v)}
              >
                <img src={v.src} alt={v.label || v.prompt} className="w-full h-full object-cover" />
              </button>

              {/* Control cluster — above zoom button */}
              <div className="absolute top-1.5 right-1.5 flex gap-1 z-10">
                <button
                  type="button"
                  className={`w-7 h-7 rounded-full bg-black/45 backdrop-blur flex items-center justify-center${v.liked ? " text-rose-300" : " text-white/70 hover:text-white"}`}
                  onClick={() => send({ type: "variant.like", id: v.id, liked: !v.liked })}
                >
                  <Heart className={`w-3.5 h-3.5${v.liked ? " fill-current" : ""}`} />
                </button>
                <button
                  type="button"
                  className={`w-7 h-7 rounded-full bg-black/45 backdrop-blur flex items-center justify-center${v.canonical ? " text-amber-300" : " text-white/70 hover:text-white"}`}
                  onClick={() =>
                    send({
                      type: "variant.canonical",
                      id: v.id,
                      canonical: !v.canonical,
                    })
                  }
                >
                  <Star className={`w-3.5 h-3.5${v.canonical ? " fill-current" : ""}`} />
                </button>
                <button
                  type="button"
                  className="w-7 h-7 rounded-full bg-black/45 backdrop-blur flex items-center justify-center text-white/70 hover:text-white"
                  onClick={() => setPromptOpen((o) => ({ ...o, [v.id]: !o[v.id] }))}
                >
                  <Info className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Prompt overlay */}
              {promptOpen[v.id] && (
                <div className="absolute inset-0 bg-black/85 p-2 pt-8 overflow-y-auto z-10">
                  <span className="text-[10px] text-slate-200 font-mono leading-snug">
                    {v.prompt}
                  </span>
                </div>
              )}

              {/* Bottom strip */}
              <div className="absolute bottom-0 inset-x-0 bg-black/45 px-2 py-1 flex items-center justify-between gap-1 z-10">
                {v.label && (
                  <span className="text-[11px] text-violet-100 font-medium truncate">
                    {v.label}
                  </span>
                )}
                {v.canonical && <span className="badge-canon !py-0 shrink-0">canonical</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5 space-y-3">
        <div className="section-title">Steer the next round</div>
        <textarea
          className="textarea h-20"
          value={steerText}
          onChange={(e) => setSteerText(e.target.value)}
          placeholder="Star the ones you're drawn to (or none), then say what's landing and what isn't."
        />
        <div>
          <div className="text-faint mb-1.5">or nudge with a direction</div>
          <div className="flex flex-wrap gap-1.5">
            {STEER_CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                className="chip"
                onClick={() => setSteerText((t) => (t ? t + "; " : "") + c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button type="button" className="btn-outline" onClick={handleRegenerate}>
            <RefreshCw className="w-4 h-4" />
            Regenerate with this steer
          </button>
          <button
            type="button"
            className="btn-primary ml-auto"
            onClick={() => send({ type: "nudge", label: "distill the spec" })}
          >
            <CheckCheck className="w-4 h-4" />
            This is the direction → distill spec
          </button>
        </div>
      </div>

      {zoom && (
        <Lightbox src={zoom.src} alt={zoom.label || zoom.prompt} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}
