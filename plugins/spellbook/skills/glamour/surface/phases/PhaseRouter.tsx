import { FeedbackBar } from "../components/FeedbackBar";
import { NarrationFeed } from "../components/NarrationFeed";
import type { ClientToServer, GlamourState } from "../state/types";
import { Analysis } from "./Analysis";
import { Direction } from "./Direction";
import { Gather } from "./Gather";
import { Prompts } from "./Prompts";
import { Spec } from "./Spec";
import { Variants } from "./Variants";

export type PhaseProps = {
  state: GlamourState;
  send: (msg: ClientToServer) => void;
};

function renderPhase(state: GlamourState, send: (m: ClientToServer) => void) {
  switch (state.phase) {
    case "gather":
      return <Gather state={state} send={send} />;
    case "analysis":
      return <Analysis state={state} send={send} />;
    case "direction":
      return <Direction state={state} send={send} />;
    case "prompts":
      return <Prompts state={state} send={send} />;
    case "variants":
      return <Variants state={state} send={send} />;
    case "spec":
      return <Spec state={state} send={send} />;
    default:
      return null;
  }
}

export function PhaseRouter({
  state,
  send,
  connectionStatus,
}: PhaseProps & { connectionStatus: string }) {
  return (
    <div className="min-h-screen">
      {state.handoff && (
        <div className="bg-violet-700/80 text-violet-50 text-sm px-4 py-2 text-center font-medium">
          ↪ {state.handoff}
        </div>
      )}
      {connectionStatus !== "open" && (
        <div className="bg-amber-700/40 text-amber-100 text-xs px-3 py-1">{connectionStatus}…</div>
      )}
      {renderPhase(state, send)}
      {state.narration.length > 0 && <div className="h-40" aria-hidden />}
      <NarrationFeed items={state.narration} />
      <FeedbackBar phase={state.phase} send={send} />
    </div>
  );
}
