import type { ProjectCard as Card } from "../../scripts/state";
import { avatarRing, relTime } from "../state/board";
import { Nudge } from "./Nudge";
import { PresenceDot } from "./PresenceDot";
import { StatusBadge } from "./StatusBadge";

// The full-size card, attention + active variants. Shared shell; the attention
// variant tints the surface (amber) + floats the question; the active variant
// shows phase + status summary. rounded-card throughout (t14).
export function ProjectCard({
  p,
  tone,
  poked,
  onPoke,
  now,
}: {
  p: Card;
  tone: "attention" | "active";
  poked: boolean;
  onPoke: () => void;
  now: number;
}) {
  const shell =
    tone === "attention"
      ? "rounded-card shadow-sm border border-attention/50 bg-attention/[0.05] ring-1 ring-attention/20 gap-3"
      : "rounded-card shadow-sm border border-edge bg-surface/60 gap-2.5";
  const when = p.status ? relTime(p.status.lastUpdated, now) : "";

  return (
    <div className={`p-4 h-full flex flex-col ${shell}`}>
      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-lg ring-1 ${avatarRing(p.name)}`}
        >
          <span>{p.avatar}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink-strong">{p.name}</div>
          <div className="font-mono text-[11px] text-faint truncate">{p.path}</div>
        </div>
        <StatusBadge zone={tone === "attention" ? "attention" : "working"} />
      </div>

      {tone === "attention" && p.question && (
        <div className="rounded-control border border-attention-strong/30 bg-attention-surface/30 p-3 text-sm text-attention-surface-ink">
          {p.question}
        </div>
      )}

      {tone === "active" && (
        <>
          {p.status?.phase && (
            <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-ink/80">
              {p.status.phase}
            </div>
          )}
          <div className="text-sm text-ink-2 leading-relaxed flex-1">
            {p.status?.summary || "No status yet."}
          </div>
        </>
      )}

      <div className="flex items-center justify-between pt-1">
        <PresenceDot connected={p.connected} when={when} />
        <Nudge
          poked={poked}
          onPoke={onPoke}
          tone={tone === "attention" ? "attention" : "default"}
        />
      </div>
    </div>
  );
}
