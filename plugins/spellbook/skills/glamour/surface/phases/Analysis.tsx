import type { PhaseProps } from "./PhaseRouter";

export function Analysis({ state, send }: PhaseProps) {
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <h2 className="text-lg font-semibold text-violet-50">Analysis</h2>
      <p className="text-xs text-slate-500">
        The agent&apos;s read of each influence. Add a note to any — agree-and-add or correct.
      </p>
      <div className="space-y-3">
        {state.influences.map((inf) => (
          <div
            key={inf.id}
            className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-3 flex gap-3"
          >
            <img src={inf.src} alt={inf.name} className="w-24 h-24 object-cover rounded shrink-0" />
            <div className="flex-1 space-y-1">
              <p className="text-sm text-slate-200">
                {inf.read || (
                  <span className="text-slate-500">…awaiting the agent&apos;s read…</span>
                )}
              </p>
              <input
                defaultValue={inf.note}
                placeholder="your note on this one…"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== inf.note) send({ type: "analysis.comment", id: inf.id, text: v });
                }}
                className="w-full bg-transparent border-b border-[#2a2238] text-xs text-slate-300 outline-none py-1"
              />
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => send({ type: "nudge", label: "synthesize the direction" })}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white"
      >
        Synthesize the direction
      </button>
    </div>
  );
}
