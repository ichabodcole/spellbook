// R6 SUBMAP-CREATE — the group-ratified-nodes-under-a-parent modal, the mirror
// of ZoneGroupModal. Where the zone modal picks/creates a ZONE, this picks the
// PARENT node from among the selected ratified nodes — the rest anchor under it
// (POST /nodes/:id/anchor). App owns the fetch fan-out (submapChildTargets
// decides which children move).
//
// drive7 #6B — ported to the vendored Dialog: outside-click + Escape dismiss
// (Cole's ask). The selection is already snapshotted at open (App stores the
// `nodes` array, not live selectedIds), so a dismissing canvas click can't yank
// the group out from under it. This modal SURVIVES #6A as the explicit
// parent-pick path (the top-bar "submap · N" button); the right-click path
// resolves inline with the clicked node as parent.

import { FolderTree } from "lucide-react";
import type { MapNode } from "./types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

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
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="w-72 max-w-[90vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-ink-faint">
            <FolderTree size={11} aria-hidden /> group under a node
          </DialogTitle>
          <DialogDescription className="text-[11px] text-ink-dim">
            pick the parent — the other {nodes.length - 1} nest inside its submap.
          </DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
}
