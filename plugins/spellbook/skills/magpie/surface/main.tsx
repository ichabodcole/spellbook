import { createRoot } from "react-dom/client";
import { MagpieShell } from "./MagpieShell";
import { useSession } from "./state/useSession";
import "./styles.css";

function App() {
  const { state, send, status, agentPresent, ended } = useSession();
  if (!state) return <div className="p-6 text-slate-400">connecting…</div>;
  return (
    <MagpieShell
      state={state}
      send={send}
      status={status}
      agentPresent={agentPresent}
      ended={ended}
    />
  );
}
const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
