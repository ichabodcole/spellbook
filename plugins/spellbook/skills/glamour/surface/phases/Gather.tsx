import type { PhaseProps } from "./PhaseRouter";

export function Gather({ state }: PhaseProps) {
  return (
    <div className="p-6 text-slate-300">
      Gather phase — {state.influences.length} influences, {state.contexts.length} contexts
    </div>
  );
}
