import { Crosshair, X } from "lucide-react";
import type { FocusOwner } from "../state/types";

export function FocusBar({
  owner,
  count,
  note,
  onZoomOut,
}: {
  owner: FocusOwner;
  count: number;
  note: string;
  onZoomOut: () => void;
}) {
  if (!owner) return null;
  const tint =
    owner === "agent"
      ? "bg-violet-600/25 text-violet-200 border-violet-500/40"
      : "bg-fuchsia-600/20 text-fuchsia-200 border-fuchsia-500/40";
  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-4 py-1.5 text-xs">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-1 ${tint}`}
      >
        <Crosshair className="h-3.5 w-3.5" />
        {owner === "agent" ? "Agent focused" : "You focused"} · {count} item
        {count === 1 ? "" : "s"}
        <button
          type="button"
          onClick={onZoomOut}
          aria-label="exit focus — back to full library"
          title="Back to full library"
          className="ml-0.5 rounded-full p-0.5 hover:bg-white/15"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
      {note && <span className="text-[11px] italic text-slate-400">{note}</span>}
    </div>
  );
}
