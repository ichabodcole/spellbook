// R6 QUEUE — the ingestion tray: a toggled aside (ReviewQueue's idiom) that
// lists the raw human input awaiting agent curation. Fed by the pure
// processingItems derive (state/ingestionQueue.ts) over the SAME inclusive
// proposals store the canvas reads — DECOUPLED from the canvas view (a zoned or
// off-screen raw item still shows here). An item drains the instant it ratifies
// (a curated node appears) or is deleted — both fire events the reducer
// applies, so the list re-derives with no tray-specific bookkeeping.
//
// Equal-capabilities: the human clears litter here (DELETE /proposals/:id) just
// as the agent does via the CLI. The FUTURE `proposals.claimed_by` seam (named
// in ingestionQueue.ts) is where lease ownership would render — a multi-agent
// drop-in this round deliberately ships without.

import { Loader, Trash2, X } from "lucide-react";
import type { Proposal } from "./types";
import { Button } from "./ui/button";

function rawTitle(p: Proposal): string {
  const t = p.draft.title;
  return typeof t === "string" && t.trim() ? t : "untitled";
}

export function IngestionTray({
  items,
  onDelete,
  onClose,
}: {
  items: Proposal[];
  // Litter-clearing: hard-remove a raw item (DELETE /proposals/:id). App owns
  // the fetch; the reducer's proposal.deleted drop drains this list.
  onDelete: (proposalId: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-edge bg-surface xl:w-80">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ink-faint">
          <Loader size={11} className="animate-pulse text-pending" aria-hidden />
          Ingesting · {items.length}
        </h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close ingestion tray" onClick={onClose}>
          <X size={12} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="p-2 text-xs text-ink-faint">
            nothing ingesting — raw notes you add land here while the agent curates them.
          </p>
        ) : (
          items.map((p) => (
            <div
              key={p.id}
              className="flex items-start justify-between gap-1.5 rounded border border-dotted border-pending/50 bg-bg p-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs text-ink">{rawTitle(p)}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[10px] italic text-pending">
                  <Loader size={9} className="animate-pulse" aria-hidden /> curating…
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Discard "${rawTitle(p)}"`}
                title="Discard this raw note"
                className="shrink-0 text-ink-faint hover:text-attention"
                onClick={() => onDelete(p.id)}
              >
                <Trash2 size={11} />
              </Button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
