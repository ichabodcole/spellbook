import { ContextCard } from "../components/ContextCard";
import { DropZone } from "../components/DropZone";
import { InfluenceCard } from "../components/InfluenceCard";
import { IntentField } from "../components/IntentField";
import type { PhaseProps } from "./PhaseRouter";

export function Gather({ state, send }: PhaseProps) {
  const canProceed = state.influences.length > 0 || state.contexts.length > 0; // BUG-4: either is enough
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <IntentField state={state} send={send} />
      <DropZone send={send} />
      <div className="grid grid-cols-3 gap-2">
        {state.influences.map((i) => (
          <InfluenceCard key={i.id} inf={i} send={send} />
        ))}
      </div>
      <div className="space-y-1">
        {state.contexts.map((c) => (
          <ContextCard key={c.id} ctx={c} send={send} />
        ))}
      </div>
      <button
        type="button"
        disabled={!canProceed}
        onClick={() => send({ type: "nudge", label: "read the influences" })}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white disabled:opacity-40"
      >
        Read the influences
      </button>
    </div>
  );
}
