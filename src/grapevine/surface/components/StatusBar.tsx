// T1, T2 — the sticky status line: a pulsing dot (leaf; attention when
// disconnected) and the connection text.

import { cn } from "cn";

export function StatusBar({ status, disconnected }: { status: string; disconnected: boolean }) {
  return (
    <div className="sticky bottom-0 border-t border-edge bg-surface px-3 py-2 font-mono text-[11px] text-ink-dim">
      <span
        className={cn(
          "mr-1.5 inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full",
          disconnected ? "bg-attention" : "bg-leaf",
        )}
      />
      <span>{status}</span>
    </div>
  );
}
