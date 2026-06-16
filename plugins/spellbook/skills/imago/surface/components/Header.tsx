import { ImagePlus, LayoutGrid } from "lucide-react";
import { presence } from "../state/derive";
import type { ClientToServer, ImagoState } from "../state/types";

const PRESENCE_LABEL = {
  idle: "imago · idle",
  working: "imago working…",
  asking: "imago needs you",
};
const PRESENCE_DOT = {
  idle: "bg-faint",
  working: "bg-accent pulse-dot",
  asking: "bg-attention pulse-dot",
};
const PRESENCE_RING = {
  idle: "border-edge bg-surface",
  working: "border-accent/40 bg-accent/10",
  asking: "border-attention/40 bg-attention/10",
};

export function Header({
  state,
  connectionStatus,
  send,
}: {
  state: ImagoState;
  connectionStatus: string;
  send: (m: ClientToServer) => void;
}) {
  const p = presence(state);
  const gens = state.batches.reduce((n, b) => n + b.variants.length, 0);
  return (
    <header className="px-5 py-2.5 flex items-center gap-3 border-b border-divider">
      <span className="text-xl" aria-hidden>
        🜛
      </span>
      <div className="flex-1 min-w-0">
        <div className="page-title leading-tight truncate">{state.title || "imago"}</div>
        <div className="text-faint">a grounded image canvas</div>
      </div>

      {/* agent presence — always legible */}
      <div
        className={`flex items-center gap-2 px-2.5 py-1 rounded-full border ${PRESENCE_RING[p]}`}
      >
        <span className={`w-2 h-2 rounded-full ${PRESENCE_DOT[p]}`} />
        <span
          className={`text-xs ${
            p === "asking"
              ? "text-attention-ink"
              : p === "working"
                ? "text-accent-ink"
                : "text-muted"
          }`}
        >
          {PRESENCE_LABEL[p]}
        </span>
      </div>

      <button
        type="button"
        className="btn-primary !px-3 !py-1.5 text-xs"
        title="New image — clear the canvas, pick a size"
        onClick={() => send({ type: "focus.clear" })}
      >
        <ImagePlus className="w-3.5 h-3.5" /> New
      </button>
      <button type="button" className="btn-ghost !p-2" title="Gallery (later)" disabled>
        <LayoutGrid className="w-4 h-4" />
      </button>

      <span className="text-faint tabular-nums">
        {state.cost || "$0.00"} · {gens} {gens === 1 ? "generation" : "generations"}
      </span>
      <span
        className={`w-2 h-2 rounded-full ${connectionStatus === "open" ? "bg-positive" : "bg-attention"}`}
        title={connectionStatus === "open" ? "connected" : connectionStatus}
      />
    </header>
  );
}
