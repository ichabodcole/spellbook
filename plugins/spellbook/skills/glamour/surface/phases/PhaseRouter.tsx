import { NarrationFeed } from "../components/NarrationFeed";
import type { ClientToServer, GlamourState } from "../state/types";
import { Gather } from "./Gather";

export type PhaseProps = {
  state: GlamourState;
  send: (msg: ClientToServer) => void;
};

export function PhaseRouter({
  state,
  send,
  connectionStatus,
}: PhaseProps & { connectionStatus: string }) {
  return (
    <div className="min-h-screen">
      {connectionStatus !== "open" && (
        <div className="bg-amber-700/40 text-amber-100 text-xs px-3 py-1">{connectionStatus}…</div>
      )}
      {state.phase === "gather" ? (
        <Gather state={state} send={send} />
      ) : (
        <div className="p-6 text-slate-400">
          phase &quot;{state.phase}&quot; — not migrated yet (Plan 2)
        </div>
      )}
      {state.narration.length > 0 && <div className="h-40" aria-hidden />}
      <NarrationFeed items={state.narration} />
    </div>
  );
}
