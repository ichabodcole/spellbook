// surface/StudioShell.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { EndedOverlay } from "./components/EndedOverlay";
import { FeedbackBar } from "./components/FeedbackBar";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { InfluencePane } from "./components/InfluencePane";
import { NarrationFeed } from "./components/NarrationFeed";
import { PhaseStepper } from "./components/PhaseStepper";
import { SpecPane } from "./components/SpecPane";
import { WorkingBanner } from "./components/WorkingBanner";
import type { ClientToServer, GlamourState } from "./state/types";
import { Studio } from "./studio/Studio";

// A compact signature of the meaningful state slices; when it changes after a
// proceed action, the optimistic working spinner clears (ports the old
// auto-spinner behavior).
function sig(s: GlamourState): string {
  return [
    s.phase,
    s.round,
    s.variants.length,
    s.direction.revision,
    s.prompts.length,
    s.influences.filter((i) => i.read).length,
    (s.spec.understanding || "").length,
  ].join("|");
}

export function StudioShell({
  state,
  send,
  status,
  ended,
}: {
  state: GlamourState;
  send: (m: ClientToServer) => void;
  status: string;
  ended: boolean;
}) {
  const [selInf, setSelInf] = useState<string | null>(null);
  const [selCtx, setSelCtx] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [workingText, setWorkingText] = useState("");
  const workingSig = useRef("");
  const workTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWorking = useCallback(() => {
    setWorking(false);
    setWorkingText("");
    if (workTimer.current) {
      clearTimeout(workTimer.current);
      workTimer.current = null;
    }
  }, []);

  // Clear the optimistic spinner once the agent's response changes the state.
  useEffect(() => {
    if (working && sig(state) !== workingSig.current) clearWorking();
  }, [state, working, clearWorking]);

  const startWork = (text: string) => {
    setWorking(true);
    setWorkingText(text);
    workingSig.current = sig(state);
    if (workTimer.current) clearTimeout(workTimer.current);
    workTimer.current = setTimeout(clearWorking, 120000);
  };

  // Wrap send so "proceed" actions show an immediate optimistic spinner.
  const sendW = (m: ClientToServer) => {
    if (m.type === "nudge") startWork(`${m.label}…`);
    else if (m.type === "generate") startWork("generating…");
    else if (m.type === "feedback") startWork("revising…");
    else if (m.type === "direction.correct") startWork("re-interpreting…");
    send(m);
  };

  if (ended) return <EndedOverlay />;

  return (
    <div className="min-h-screen">
      <Header state={state} connectionStatus={status} />
      <PhaseStepper phase={state.phase} />
      {state.handoff && (
        <div className="px-6 py-2 bg-violet-700/30 border-b border-violet-500/30 text-sm text-violet-100 text-center font-medium">
          ↪ {state.handoff}
        </div>
      )}
      <WorkingBanner state={state} working={working} workingText={workingText} />
      <div className="grid grid-cols-[300px_1fr_330px] gap-4 p-4 items-start">
        <InfluencePane
          state={state}
          send={sendW}
          selInf={selInf}
          selCtx={selCtx}
          onSelInf={setSelInf}
          onSelCtx={setSelCtx}
        />
        <div className="space-y-4 min-h-[60vh]">
          <Studio
            state={state}
            send={sendW}
            selInf={selInf}
            selCtx={selCtx}
            onSelInf={setSelInf}
            onSelCtx={setSelCtx}
          />
        </div>
        <SpecPane state={state} send={sendW} />
      </div>
      <Footer send={send} />
      {state.narration.length > 0 && <div className="h-40" aria-hidden />}
      <NarrationFeed items={state.narration} />
      <FeedbackBar phase={state.phase} send={send} />
    </div>
  );
}
