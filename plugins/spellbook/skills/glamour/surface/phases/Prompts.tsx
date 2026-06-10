import { useState } from "react";
import type { PhaseProps } from "./PhaseRouter";

export function Prompts({ state, send }: PhaseProps) {
  const [overall, setOverall] = useState("");
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <h2 className="text-lg font-semibold text-violet-50">Prompts</h2>
      <p className="text-xs text-slate-500">
        The prompts the agent will generate from. Comment on any, or add an overall note, then
        generate.
      </p>
      <div className="space-y-2">
        {state.prompts.map((p, i) => (
          <div key={p.id} className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-3 space-y-1">
            <div className="text-[11px] text-slate-500">prompt {i + 1}</div>
            <p className="text-sm text-slate-200 whitespace-pre-wrap">{p.text}</p>
            <input
              placeholder="comment on this prompt…"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v) {
                  send({ type: "prompt.comment", id: p.id, text: v });
                  e.target.value = "";
                }
              }}
              className="w-full bg-transparent border-b border-[#2a2238] text-xs text-slate-300 outline-none py-1"
            />
          </div>
        ))}
      </div>
      <textarea
        value={overall}
        onChange={(e) => setOverall(e.target.value)}
        placeholder="overall note on the set (optional)…"
        className="w-full bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 text-sm text-slate-200 outline-none"
        rows={2}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            if (overall.trim()) {
              send({ type: "prompts.comment", text: overall.trim() });
              setOverall("");
            }
          }}
          disabled={!overall.trim()}
          className="text-sm px-4 py-2 rounded-lg font-medium border border-[#2e2640] text-slate-200 disabled:opacity-40"
        >
          Send note
        </button>
        <button
          type="button"
          onClick={() => send({ type: "generate" })}
          className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white"
        >
          Generate
        </button>
      </div>
    </div>
  );
}
