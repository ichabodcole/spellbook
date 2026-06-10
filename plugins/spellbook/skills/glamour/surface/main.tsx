import { createRoot } from "react-dom/client";
import { PhaseRouter } from "./phases/PhaseRouter";
import { useSession } from "./state/useSession";
import "./styles.css";

function App() {
  const { state, send, status } = useSession();
  if (!state) return <div className="p-6 text-slate-400">connecting…</div>;
  return <PhaseRouter state={state} send={send} connectionStatus={status} />;
}
const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
