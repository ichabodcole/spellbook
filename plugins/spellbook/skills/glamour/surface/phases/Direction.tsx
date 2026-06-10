import { FeedbackControl } from "../components/FeedbackControl";
import type { PhaseProps } from "./PhaseRouter";

export function Direction({ state, send }: PhaseProps) {
  const { understanding, revision } = state.direction;
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-violet-50">Direction</h2>
        {revision > 0 && <span className="text-[11px] text-slate-500">revision {revision}</span>}
      </div>
      <div className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-4 text-sm text-slate-200 whitespace-pre-wrap">
        {understanding || <span className="text-slate-500">…the agent is composing its read…</span>}
      </div>
      <FeedbackControl onSubmit={(mode, text) => send({ type: "direction.correct", text, mode })} />
      <button
        type="button"
        onClick={() => send({ type: "nudge", label: "draft the prompts" })}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white"
      >
        Draft the prompts
      </button>
    </div>
  );
}
