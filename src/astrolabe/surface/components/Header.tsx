import { Plus, Radar } from "lucide-react";
import { Button } from "./Button";

// The board header: identity, live-connection dot, the at-a-glance counts, and
// the + Add entry to registration. t14: the title block flexes (min-w-0 so it
// truncates), and the counts + Add never wrap (shrink-0 whitespace-nowrap).
export function Header({
  title,
  connected,
  counts,
  hasProjects,
  onAdd,
}: {
  title: string;
  connected: boolean;
  counts: { attention: number; active: number; quiet: number };
  hasProjects: boolean;
  onAdd: () => void;
}) {
  return (
    <header className="border-b border-divider bg-surface/40">
      <div className="mx-auto max-w-5xl px-5 py-3 flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-accent/20 ring-1 ring-accent-hover/40">
          <Radar className="w-4 h-4 text-accent-ink" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-lg font-semibold text-ink-strong truncate">{title}</div>
          <div className="text-faint text-xs">
            cross-project board · what's moving, what needs you
          </div>
        </div>
        <div
          className={`flex items-center gap-1.5 text-xs shrink-0 ${connected ? "text-muted" : "text-faint-2"}`}
        >
          <span className="relative flex h-2 w-2">
            {connected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-chip bg-positive opacity-60" />
            )}
            <span
              className={`relative inline-flex h-2 w-2 rounded-chip ${connected ? "bg-positive" : "bg-faint-2"}`}
            />
          </span>
          <span>{connected ? "Live" : "Reconnecting…"}</span>
        </div>
        {hasProjects && (
          <span className="text-faint text-xs shrink-0 whitespace-nowrap">
            <span className="text-attention-ink-2/80">{counts.attention}</span> need you ·{" "}
            <span>{counts.active}</span> active · <span>{counts.quiet}</span> quiet
          </span>
        )}
        <Button onClick={onAdd} className="shrink-0 whitespace-nowrap">
          <Plus className="w-4 h-4" aria-hidden="true" /> Add
        </Button>
      </div>
    </header>
  );
}
