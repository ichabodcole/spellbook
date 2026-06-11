import { Loader2 } from "lucide-react";
import type { GlamourState } from "../state/types";

interface WorkingBannerProps {
  state: GlamourState;
  working: boolean;
  workingText: string;
}

export function WorkingBanner({ state, working, workingText }: WorkingBannerProps) {
  if (!working && !state.status.busy) {
    return null;
  }

  return (
    <div className="px-6 py-2 flex items-center gap-2 bg-violet-600/10 border-b border-violet-500/20 text-sm text-violet-200">
      <Loader2 className="w-4 h-4 animate-spin" />
      <span>{workingText || state.status.text || "the agent is working…"}</span>
    </div>
  );
}
