import { ChevronRight } from "lucide-react";
import { atLeast } from "../state/atLeast";
import { PHASES } from "../state/constants";
import type { Phase } from "../state/types";

interface PhaseStepperProps {
  phase: Phase;
}

export function PhaseStepper({ phase }: PhaseStepperProps) {
  return (
    <div className="px-6 py-2 flex items-center gap-1.5 border-b border-[#241d33] text-[11px] overflow-x-auto">
      {PHASES.map((ph, i) => {
        const isActive = phase === ph.key;
        const isReached = atLeast(phase, ph.key);

        const chipClass = isActive
          ? "bg-violet-600/25 border-violet-500/50 text-violet-100"
          : isReached
            ? "border-[#2e2640] text-slate-400"
            : "border-transparent text-slate-600";

        const circleClass = isActive
          ? "bg-violet-500 text-white"
          : isReached
            ? "bg-[#2e2640] text-slate-300"
            : "bg-[#1b1626] text-slate-600";

        return (
          <div key={ph.key} className="flex items-center gap-1.5 shrink-0">
            <span
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${chipClass}`}
            >
              <span
                className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-semibold ${circleClass}`}
              >
                {i + 1}
              </span>
              <span>{ph.label}</span>
            </span>
            {i < PHASES.length - 1 && <ChevronRight className="w-3 h-3 text-slate-700" />}
          </div>
        );
      })}
    </div>
  );
}
