// Round 7 (SUBMAPPEND) — the pending-group variant of SubmapGroupModal. Where
// SubmapGroupModal groups already-RATIFIED nodes (a pure anchor fan-out), this
// ratifies ≥2 PENDING proposals into a submap in ONE ratify-batch call: pick a
// single tier for the whole group (sidesteps the per-proposal tier problem),
// then pick the parent — one of the selected proposals OR an existing real node
// — and the rest nest under it. App owns the fetch (buildSubmapAppend + POST
// /proposals/ratify-batch).

import { FolderTree } from "lucide-react";
import { useState } from "react";
import { TIER_LABEL } from "./GraphCanvas";
import type { BatchRuling } from "./state/submapAppend";
import type { MapNode } from "./types";
import { Button } from "./ui/button";

const TIERS: BatchRuling[] = ["canon", "thread", "story-local"];

export function SubmapAppendModal({
  proposals,
  existingNodes,
  onCommit,
  onCancel,
}: {
  // The selected pending proposals (≥2), as synthetic MapNodes — any one can be
  // the submap root, or an existing node below can.
  proposals: MapNode[];
  // Real ratified nodes offered as an alternative parent (nest the new group
  // under an existing idea). Scrollable — a board can hold many.
  existingNodes: MapNode[];
  onCommit: (parentRef: string, ruling: BatchRuling) => void;
  onCancel: () => void;
}) {
  const [ruling, setRuling] = useState<BatchRuling>("thread");

  return (
    <div className="absolute left-1/2 top-1/4 z-30 w-80 -translate-x-1/2 rounded-lg border border-edge bg-surface/95 p-3 shadow-xl backdrop-blur">
      <p className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-widest text-ink-faint">
        <FolderTree size={11} aria-hidden /> ratify & nest as a submap
      </p>
      <p className="mb-2 text-[11px] text-ink-dim">
        ratify all {proposals.length} at one tier, then pick the parent — the rest nest inside its
        submap.
      </p>

      <div className="mb-1 text-[9px] uppercase tracking-widest text-ink-faint">tier</div>
      <div className="mb-3 flex gap-1">
        {TIERS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setRuling(t)}
            aria-pressed={ruling === t}
            className={`flex-1 rounded-sm border px-1.5 py-1 text-[10px] ${
              ruling === t
                ? "border-ink bg-secondary text-ink"
                : "border-edge text-ink-dim hover:border-ink-faint hover:text-ink"
            }`}
          >
            {TIER_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="mb-1 text-[9px] uppercase tracking-widest text-ink-faint">
        parent (from the selection)
      </div>
      <div className="flex flex-col gap-1">
        {proposals.map((n) => (
          <Button
            key={n.id}
            variant="outline"
            size="auto"
            className="justify-start px-2 py-1 text-left text-xs text-ink"
            onClick={() => onCommit(n.id, ruling)}
          >
            <span className="truncate">{n.title}</span>
          </Button>
        ))}
      </div>

      {existingNodes.length > 0 && (
        <>
          <div className="mb-1 mt-2 text-[9px] uppercase tracking-widest text-ink-faint">
            …or under an existing idea
          </div>
          <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
            {existingNodes.map((n) => (
              <Button
                key={n.id}
                variant="ghost"
                size="auto"
                className="justify-start px-2 py-1 text-left text-xs text-ink-dim hover:text-ink"
                onClick={() => onCommit(n.id, ruling)}
              >
                <span className="truncate">{n.title}</span>
              </Button>
            ))}
          </div>
        </>
      )}

      <div className="mt-2 flex justify-end">
        <Button variant="ghost" size="auto" className="px-2 py-1 text-xs" onClick={onCancel}>
          cancel
        </Button>
      </div>
    </div>
  );
}
