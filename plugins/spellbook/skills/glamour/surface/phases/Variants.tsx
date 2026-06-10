// surface/phases/Variants.tsx
import { useState } from "react";
import { Lightbox } from "../components/Lightbox";
import type { Variant } from "../state/types";
import type { PhaseProps } from "./PhaseRouter";

export function Variants({ state, send }: PhaseProps) {
  const [zoom, setZoom] = useState<Variant | null>(null);
  const rounds = [...new Set(state.variants.map((v) => v.round))].sort((a, b) => a - b);
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-violet-50">Variants</h2>
        {state.cost && <span className="text-xs text-emerald-300">{state.cost}</span>}
      </div>
      <p className="text-xs text-slate-500">
        Like the ones that land. Click an image for full size + true aspect. Comment on a round to
        steer the next generation.
      </p>
      {state.variants.length === 0 && (
        <p className="text-sm text-slate-500">…awaiting the first generation round…</p>
      )}
      {rounds.map((r) => (
        <div key={r} className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">round {r}</div>
          <div className="grid grid-cols-3 gap-3">
            {state.variants
              .filter((v) => v.round === r)
              .map((v) => (
                <div
                  key={v.id}
                  className="bg-[#1b1626] border border-[#2e2640] rounded-lg overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setZoom(v)}
                    className="block w-full cursor-zoom-in"
                  >
                    <img
                      src={v.src}
                      alt={v.label || v.prompt}
                      className="w-full h-32 object-cover"
                    />
                  </button>
                  <div className="p-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-400 truncate">
                      {v.label || "variant"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        send({
                          type: "variant.like",
                          id: v.id,
                          liked: !v.liked,
                        })
                      }
                      className={`text-xs px-2 py-0.5 rounded border ${v.liked ? "bg-rose-600 text-white border-rose-600" : "border-[#2e2640] text-slate-300"}`}
                    >
                      {v.liked ? "♥ liked" : "♡ like"}
                    </button>
                  </div>
                </div>
              ))}
          </div>
          <input
            placeholder={`note on round ${r} (steers the next generation)…`}
            onBlur={(e) => {
              const t = e.target.value.trim();
              if (t) {
                send({ type: "steer", text: `round ${r}: ${t}` });
                e.target.value = "";
              }
            }}
            className="w-full bg-transparent border-b border-[#2a2238] text-xs text-slate-300 outline-none py-1"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => send({ type: "nudge", label: "distill the spec" })}
        disabled={state.variants.length === 0}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white disabled:opacity-40"
      >
        Distill the spec
      </button>
      {zoom && (
        <Lightbox src={zoom.src} alt={zoom.label || zoom.prompt} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}
