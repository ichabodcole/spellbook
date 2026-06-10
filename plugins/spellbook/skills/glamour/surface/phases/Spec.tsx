// surface/phases/Spec.tsx
import { useState } from "react";
import { Lightbox } from "../components/Lightbox";
import type { Variant } from "../state/types";
import type { PhaseProps } from "./PhaseRouter";

export function Spec({ state, send }: PhaseProps) {
  const [zoom, setZoom] = useState<Variant | null>(null);
  const { understanding, modules, recreatePrompt, model } = state.spec;
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-violet-50">Style spec</h2>
        {state.cost && <span className="text-xs text-emerald-300">{state.cost}</span>}
      </div>

      <section className="space-y-1">
        <h3 className="text-xs uppercase tracking-wide text-slate-500">the look</h3>
        <div className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-4 text-sm text-slate-200 whitespace-pre-wrap">
          {understanding || (
            <span className="text-slate-500">…the agent is distilling the spec…</span>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-slate-500">sections</h3>
        {modules.map((m) => (
          <div
            key={m.key}
            className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-3 space-y-1"
          >
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={m.on}
                onChange={(e) =>
                  send({
                    type: "spec.module",
                    key: m.key,
                    on: e.target.checked,
                  })
                }
              />
              {m.label}
            </label>
            {m.on && m.content && (
              <p className="text-xs text-slate-400 whitespace-pre-wrap pl-6">{m.content}</p>
            )}
          </div>
        ))}
      </section>

      {recreatePrompt && (
        <section className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-slate-500">
            recreate prompt{model && ` · ${model}`}
          </h3>
          <pre className="bg-[#140f1d] border border-[#2a2238] rounded-lg p-3 text-xs text-slate-300 whitespace-pre-wrap">
            {recreatePrompt}
          </pre>
        </section>
      )}

      {state.variants.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wide text-slate-500">
            pick the canonical image
          </h3>
          <div className="grid grid-cols-3 gap-3">
            {state.variants.map((v) => (
              <div
                key={v.id}
                className={`rounded-lg overflow-hidden border-2 ${v.canonical ? "border-violet-500" : "border-transparent"}`}
              >
                <button
                  type="button"
                  onClick={() => setZoom(v)}
                  className="block w-full cursor-zoom-in"
                >
                  <img src={v.src} alt={v.label || v.prompt} className="w-full h-28 object-cover" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    send({
                      type: "variant.canonical",
                      id: v.id,
                      canonical: !v.canonical,
                    })
                  }
                  className={`w-full text-xs py-1 ${v.canonical ? "bg-violet-600 text-white" : "bg-[#1b1626] text-slate-300"}`}
                >
                  {v.canonical ? "★ canonical" : "set canonical"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={() => send({ type: "submit" })}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-emerald-600 text-white"
      >
        Finish &amp; hand back the spec
      </button>

      {zoom && (
        <Lightbox src={zoom.src} alt={zoom.label || zoom.prompt} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}
