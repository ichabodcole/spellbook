import { Plus, Radar } from "lucide-react";
import { Button } from "./Button";

export function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mx-auto max-w-md text-center py-16">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-card-lg bg-surface-3/60 ring-1 ring-edge-strong">
        <Radar className="w-7 h-7 text-faint" aria-hidden="true" />
      </div>
      <h2 className="text-lg font-semibold text-ink-strong mb-1">Nothing in the sky yet</h2>
      <p className="text-muted text-sm mb-5">
        Register a project, then have an agent{" "}
        <span className="font-mono text-xs text-muted">join</span> it to bring it online.
      </p>
      <Button onClick={onAdd} className="mx-auto">
        <Plus className="w-4 h-4" aria-hidden="true" /> Add a project
      </Button>
    </div>
  );
}
