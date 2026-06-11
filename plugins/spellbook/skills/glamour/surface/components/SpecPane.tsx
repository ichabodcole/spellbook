import { Brain, FileText, Package, Star, X } from "lucide-react";
import { atLeast } from "../state/atLeast";
import type { ClientToServer, GlamourState } from "../state/types";

interface SpecPaneProps {
  state: GlamourState;
  send: (m: ClientToServer) => void;
}

export function SpecPane({ state, send }: SpecPaneProps) {
  const canon = state.variants.filter((v) => v.canonical);
  const isAtLeastDirection = atLeast(state.phase, "direction");

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-center">
        <div className="section-title">Style spec</div>
        {state.phase === "spec" ? (
          <span className="badge-accent ml-auto">sealed</span>
        ) : isAtLeastDirection ? (
          <span className="badge-muted ml-auto">draft</span>
        ) : null}
      </div>

      {!isAtLeastDirection && (
        <div className="inset rounded-xl py-10 px-4 text-center">
          <FileText className="w-6 h-6 text-slate-600 mx-auto mb-2" />
          <div className="text-faint">
            The spec takes shape here as we converge — the durable thing you keep.
          </div>
        </div>
      )}

      {isAtLeastDirection && (
        <div className="space-y-4">
          {/* Synthesized understanding */}
          <div className="inset p-3 border-violet-500/25">
            <div className="text-faint mb-1.5 flex items-center gap-1">
              <Brain className="w-3 h-3 text-violet-300" />
              synthesized understanding
            </div>
            <p className="text-[13px] leading-relaxed text-slate-300 whitespace-pre-wrap">
              {state.spec.understanding || state.direction.understanding || "…"}
            </p>
          </div>

          {/* Canonical images */}
          <div>
            <div className="text-faint mb-1.5 flex items-center gap-1">
              <Star className="w-3 h-3 text-amber-300" />
              canonical images
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {!canon.length ? (
                <div className="col-span-3 text-faint italic">
                  star variants to ground the spec…
                </div>
              ) : (
                canon.map((v) => (
                  <div key={v.id} className="tile">
                    <img src={v.src} alt={v.label || v.prompt} />
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Optional modules (on) */}
          {state.spec.modules
            .filter((m) => m.on)
            .map((m) => (
              <div key={m.key}>
                <div className="text-faint mb-1.5 flex items-center gap-1.5">
                  <span>{m.label}</span>
                  <span className="badge-muted !text-[9px] !py-0">optional</span>
                  <button
                    type="button"
                    className="ml-auto text-slate-600 hover:text-slate-300"
                    onClick={() => send({ type: "spec.module", key: m.key, on: false })}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="inset p-2.5">
                  {m.content ? (
                    <span className="text-faint">{m.content}</span>
                  ) : (
                    <span className="text-faint italic">
                      the agent fills this in when your inputs call for it
                    </span>
                  )}
                </div>
              </div>
            ))}

          {/* Composable — add a module */}
          <div className="border-t border-[#2a2238] pt-3">
            <div className="text-faint mb-1.5">
              composable — the agent keeps only what your inputs warrant. add a module:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {state.spec.modules
                .filter((m) => !m.on)
                .map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className="chip"
                    onClick={() => send({ type: "spec.module", key: m.key, on: true })}
                  >
                    + {m.label}
                  </button>
                ))}
              {state.spec.modules.every((m) => m.on) && (
                <span className="text-faint italic">all modules added</span>
              )}
            </div>
          </div>

          {/* Recreate prompt + model */}
          {state.spec.recreatePrompt && (
            <div>
              <div className="text-faint mb-1.5">recreate prompt</div>
              <div className="inset p-2.5 text-mono !text-[11px] text-slate-400 leading-relaxed">
                {state.spec.recreatePrompt}
              </div>
              {state.spec.model && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-faint">pinned model</span>
                  <span className="badge-muted">{state.spec.model}</span>
                </div>
              )}
            </div>
          )}

          {/* Export / submit */}
          {state.phase === "spec" && (
            <div className="pt-1 space-y-2">
              <button
                type="button"
                className="btn-primary w-full"
                onClick={() => send({ type: "submit" })}
              >
                <Package className="w-4 h-4" />
                Export spec bundle
              </button>
              <div className="text-faint text-center">
                understanding + canonical images + recreate prompt
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
