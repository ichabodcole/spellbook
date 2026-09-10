import { createRoot } from "react-dom/client";
import { ImagoShell } from "./ImagoShell";
import { useSession } from "./state/useSession";
import "./styles.css";

function App() {
  const { state, send, status, ended } = useSession();
  if (!state) return <div className="p-6 text-slate-400">connecting…</div>;
  return <ImagoShell state={state} send={send} status={status} ended={ended} />;
}
const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
