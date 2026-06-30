import type { ProjectCard as Card } from "../../scripts/state";
import { avatarRing, relTime, type Zone } from "../state/board";
import { StatusBadge } from "./StatusBadge";

// A muted single-line row for the quiet zone (idle / stale). The silence of the
// quiet board is the signal — only the status badge carries any tint.
export function QuietRow({ p, zone, now }: { p: Card; zone: Zone; now: number }) {
  return (
    <div className="flex items-center gap-3 rounded-control border border-edge/60 bg-surface/30 px-3 py-2 opacity-70">
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control-sm text-base ring-1 ${avatarRing(p.name)}`}
      >
        <span>{p.avatar}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink-2">{p.name}</div>
        <div className="truncate text-xs text-faint">{p.status?.summary || p.path}</div>
      </div>
      <StatusBadge zone={zone} />
      <span className="text-[11px] text-faint-2 shrink-0 w-16 text-right">
        {relTime(p.status?.lastUpdated, now)}
      </span>
    </div>
  );
}
