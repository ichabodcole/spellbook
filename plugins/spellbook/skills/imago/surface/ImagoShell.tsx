// surface/ImagoShell.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "./components/Canvas";
import { Conversation } from "./components/Conversation";
import { EndedOverlay } from "./components/EndedOverlay";
import { GenerationsRail } from "./components/GenerationsRail";
import { Header } from "./components/Header";
import { WorkingBanner } from "./components/WorkingBanner";
import type { ClientToServer, ImagoState } from "./state/types";

// A compact signature of the slices a generation changes; when it moves after a
// "send", the optimistic spinner clears (ports glamour's auto-spinner).
function sig(s: ImagoState): string {
  const vars = s.batches.reduce((n, b) => n + b.variants.length, 0);
  return [s.batches.length, vars, s.conversation.length].join("|");
}

// The three-pane shell: Generations | canvas (stage) | Conversation (spine).
export function ImagoShell({
  state,
  send,
  status,
  ended,
}: {
  state: ImagoState;
  send: (m: ClientToServer) => void;
  status: string;
  ended: boolean;
}) {
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

  useEffect(() => {
    if (working && sig(state) !== workingSig.current) clearWorking();
  }, [state, working, clearWorking]);

  // Wrap send so confirming a prompt shows an immediate optimistic spinner.
  const sendW = (m: ClientToServer) => {
    if (m.type === "proposal.send") {
      setWorking(true);
      setWorkingText("generating…");
      workingSig.current = sig(state);
      if (workTimer.current) clearTimeout(workTimer.current);
      workTimer.current = setTimeout(clearWorking, 120000);
    }
    send(m);
  };

  if (ended) return <EndedOverlay />;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header state={state} connectionStatus={status} send={send} />
      <WorkingBanner state={state} working={working} workingText={workingText} />
      <div className="flex-1 grid grid-cols-[270px_1fr_360px] gap-3 p-3 min-h-0">
        <GenerationsRail state={state} send={sendW} />
        <Canvas state={state} send={sendW} />
        <Conversation state={state} send={sendW} />
      </div>
    </div>
  );
}
