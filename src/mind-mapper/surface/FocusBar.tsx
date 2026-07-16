// The focus bar — glamour's FocusBar idiom (owner-tinted pill, Crosshair,
// X = zoom out) adapted to tokens. The lens it renders is addressable
// view-state (vine msg 15): V1 gives the agent write access to it, so the
// owner distinction is load-bearing from day one even though the spike only
// wires the human trigger.

import { Crosshair, Minus, Plus, X } from "lucide-react";
import type { Lens } from "./types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

export function FocusBar({
  lens,
  title,
  count,
  onDepth,
  onZoomOut,
}: {
  lens: Lens;
  title: string;
  count: number;
  onDepth: (depth: number) => void;
  onZoomOut: () => void;
}) {
  if (!lens.owner) return null;
  const tint =
    lens.owner === "agent"
      ? "border-thread-tier/40 bg-thread-tier/15 text-thread-tier"
      : "border-canon/40 bg-canon/15 text-canon";
  return (
    <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-edge bg-surface/90 px-4 py-1.5 text-xs backdrop-blur">
      <Badge className={`gap-1.5 py-1 pl-2.5 pr-1 ${tint}`}>
        <Crosshair className="h-3.5 w-3.5" />
        {lens.owner === "agent" ? "Agent focused" : "You focused"} · {title} · {count} node
        {count === 1 ? "" : "s"}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onZoomOut}
          aria-label="Exit focus — back to the full map"
          title="Back to the full map"
          className="ml-0.5 rounded-full text-inherit hover:bg-secondary"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </Badge>
      <span className="inline-flex items-center gap-1 text-ink-dim">
        depth
        <Button
          size="icon-xs"
          onClick={() => onDepth(Math.max(1, lens.depth - 1))}
          disabled={lens.depth <= 1}
          aria-label="Narrow focus"
          className="rounded"
        >
          <Minus className="h-3 w-3" />
        </Button>
        {lens.depth}
        <Button
          size="icon-xs"
          onClick={() => onDepth(lens.depth + 1)}
          aria-label="Widen focus"
          className="rounded"
        >
          <Plus className="h-3 w-3" />
        </Button>
      </span>
    </div>
  );
}
