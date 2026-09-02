import { Sparkles } from "lucide-react";

export function EndedOverlay() {
  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center">
      <div className="card p-8 text-center max-w-sm">
        <Sparkles className="w-8 h-8 text-accent-ink mx-auto mb-2" />
        <div className="page-title mb-1">Session ended</div>
        <p className="text-muted">
          The imago has been handed back to the agent. You can close this tab.
        </p>
      </div>
    </div>
  );
}
