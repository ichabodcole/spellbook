import { Check } from "lucide-react";
import { FeedbackControl } from "../components/FeedbackControl";
import type { ClientToServer, GlamourState } from "../state/types";

interface DirectionStudioProps {
  state: GlamourState;
  send: (m: ClientToServer) => void;
}

export function DirectionStudio({ state, send }: DirectionStudioProps) {
  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center">
        <div className="section-title">My full read — align here before we generate</div>
        <span className="badge-muted ml-auto">revision {state.direction.revision}</span>
      </div>
      <p className="text-faint -mt-1">
        This is the gate. Generation is costly — push back on anything off now, while it&apos;s just
        words.
      </p>
      <div className="text-body whitespace-pre-wrap">
        {state.direction.understanding || "…the agent is composing its read…"}
      </div>
      <FeedbackControl onSubmit={(mode, text) => send({ type: "direction.correct", text, mode })} />
      <button
        type="button"
        className="btn-primary"
        onClick={() => send({ type: "nudge", label: "draft the prompts" })}
      >
        <Check className="w-4 h-4" />
        Yes — draft the prompts
      </button>
    </div>
  );
}
