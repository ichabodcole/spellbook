// R6 SUBMAP-CREATE — the group-ratified-nodes-under-a-parent modal, the mirror
// of ZoneGroupModal (same chassis: centered card, backdrop, cancel). Where the
// zone modal picks/creates a ZONE, this picks the PARENT node from among the
// selected ratified nodes — the rest anchor under it (POST /nodes/:id/anchor).
// App owns the fetch fan-out (submapChildTargets decides which children move).

import { FolderTree } from "lucide-react";
import type { MapNode } from "./types";
import { Button } from "./ui/button";

export function SubmapGroupModal({
  nodes,
  onPickParent,
  onCancel,
}: {
  // The selected ratified nodes (≥2) — any one can be the submap root.
  nodes: MapNode[];
  onPickParent: (parentId: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute left-1/2 top-1/3 z-30 w-72 -translate-x-1/2 rounded-lg border border-edge bg-surface/95 p-3 shadow-xl backdrop-blur">
      <p className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-widest text-ink-faint">
        <FolderTree size={11} aria-hidden /> group under a node
      </p>
      <p className="mb-2 text-[11px] text-ink-dim">
        pick the parent — the other {nodes.length - 1} nest inside its submap.
      </p>
      <div className="flex flex-col gap-1">
        {nodes.map((n) => (
          <Button
            key={n.id}
            variant="outline"
            size="auto"
            className="justify-start px-2 py-1 text-left text-xs text-ink"
            onClick={() => onPickParent(n.id)}
          >
            <span className="truncate">{n.title}</span>
          </Button>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" size="auto" className="px-2 py-1 text-xs" onClick={onCancel}>
          cancel
        </Button>
      </div>
    </div>
  );
}
