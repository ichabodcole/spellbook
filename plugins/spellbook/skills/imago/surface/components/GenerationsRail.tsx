import { Heart } from "lucide-react";
import { useState } from "react";
import { variantLabel } from "../state/derive";
import type { ClientToServer, ImagoState } from "../state/types";

type Size = "s" | "m" | "l";
const THUMB: Record<Size, string> = {
  s: "w-[60px]",
  m: "w-[92px]",
  l: "w-[132px]",
};

// Left pane: every kept generation, grouped by batch. Click a variant to focus
// it on the canvas (a "focus" gesture the agent hears).
export function GenerationsRail({
  state,
  send,
}: {
  state: ImagoState;
  send: (m: ClientToServer) => void;
}) {
  const [size, setSize] = useState<Size>("m");

  return (
    <aside className="card flex flex-col min-h-0 h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
        <span className="section-title">Generations</span>
        <div className="inline-flex rounded-md border border-edge-strong overflow-hidden">
          {(["s", "m", "l"] as Size[]).map((z) => (
            <button
              type="button"
              key={z}
              onClick={() => setSize(z)}
              className={`px-2 py-0.5 text-xs font-medium ${
                size === z ? "bg-accent text-white" : "text-muted hover:bg-surface-3"
              }`}
            >
              {z.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
        {state.batches.length === 0 && (
          <p className="text-faint italic text-center mt-10 px-4">
            generations appear here — say what you want to make on the right
          </p>
        )}

        {state.batches.map((b, bi) => (
          <div key={b.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-ink">Batch {bi + 1}</span>
              <span className={b.kind === "edit" ? "badge-canon" : "badge-accent"}>{b.kind}</span>
              <span className="text-faint ml-auto">
                {b.variants.length} {b.variants.length === 1 ? "variant" : "variants"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {b.variants.map((v, vi) => {
                const selected = state.focus?.variantId === v.id;
                return (
                  <button
                    type="button"
                    key={v.id}
                    onClick={() =>
                      send({
                        type: "focus.set",
                        batchId: b.id,
                        variantId: v.id,
                      })
                    }
                    className={`relative rounded-md overflow-hidden aspect-square shrink-0 ${THUMB[size]} ${
                      selected ? "ring-2 ring-accent" : "ring-1 ring-edge hover:ring-edge-hover"
                    }`}
                  >
                    {v.src ? (
                      <img
                        src={v.src}
                        alt={`variant ${variantLabel(vi)}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-surface-2" />
                    )}
                    <span className="absolute top-0.5 left-0.5 text-[9px] bg-black/60 text-ink px-1 rounded">
                      {variantLabel(vi)}
                    </span>
                    {v.liked && (
                      <Heart className="absolute bottom-0.5 right-0.5 w-3 h-3 text-like fill-like" />
                    )}
                  </button>
                );
              })}
            </div>
            {b.tag && <p className="text-faint italic">{b.tag}</p>}
          </div>
        ))}
      </div>
    </aside>
  );
}
