import { WandSparkles } from "lucide-react";
import type { GlamourState } from "../state/types";

interface HeaderProps {
  state: GlamourState;
  connectionStatus: string;
}

export function Header({ state, connectionStatus }: HeaderProps) {
  return (
    <header className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-[#241d33]">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-violet-600/20 border border-violet-500/30 flex items-center justify-center">
          <WandSparkles className="w-5 h-5 text-violet-300" />
        </div>
        <div>
          <div className="page-title leading-tight">{state.title}</div>
          <div className="text-faint">glamour · compose a visual style</div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span
          className={`w-2 h-2 rounded-full pulse-dot ${connectionStatus === "open" ? "bg-emerald-400" : "bg-amber-400"}`}
        />
        <span>{connectionStatus === "open" ? "agent listening" : connectionStatus}</span>
        <span className="text-faint ml-2">
          phase: <span className="text-violet-300">{state.phase}</span>
        </span>
        {state.round > 0 && <span className="text-faint">· round {state.round}</span>}
      </div>
    </header>
  );
}
