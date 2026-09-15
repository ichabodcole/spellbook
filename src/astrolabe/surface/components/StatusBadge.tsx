import { Activity, AlertTriangle, Clock, Moon } from "lucide-react";
import type { Zone } from "../state/board";

// Per-card status indicator (t12 icons + t14: a padded, slightly-rounded icon
// badge — rounded-control p-1.5, w-4 icon — not a flush pill). Tint + icon +
// accessible name per zone, all from @theme. Full literal class strings (not
// constructed) so Tailwind's JIT generates them.
const SPECS: Record<Zone, { Icon: typeof Activity; tint: string; label: string }> = {
  attention: {
    Icon: AlertTriangle,
    tint: "text-attention-ink bg-attention/20 ring-attention/50",
    label: "Needs you",
  },
  working: {
    Icon: Activity,
    tint: "text-positive-ink bg-positive-surface/10 ring-positive-surface/30",
    label: "Working",
  },
  idle: { Icon: Moon, tint: "text-muted bg-idle/10 ring-idle/30", label: "Idle" },
  stale: { Icon: Clock, tint: "text-faint bg-idle-strong/10 ring-idle-strong/30", label: "Stale" },
};

export function StatusBadge({ zone }: { zone: Zone }) {
  const { Icon, tint, label } = SPECS[zone];
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-control p-1.5 ring-1 ring-inset ${tint}`}
    >
      <Icon className="w-4 h-4" aria-hidden="true" />
    </span>
  );
}
