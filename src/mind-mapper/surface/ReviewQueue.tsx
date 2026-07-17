// P3.1 — the review queue (plan/circe.md P3.1), the ratified review-queue
// contract: proposals batch-by-source (bobbin's spec), the agent-drafted
// candidate renders VERBATIM (draftSummary only summarizes into a row, never
// edits), ruling is one keystroke — accept-the-draft or reject, never
// compose-in-UI. Placement mirrors ContextRail's aside idiom (a toggled
// panel, not a modal — the queue is part of the board, not a detour from it).

import { Check, X } from "lucide-react";
import { useMemo } from "react";
import { draftSummary, groupProposalsByDoc, UNGROUNDED } from "./state/reviewQueue";
import type { DocMeta, Proposal, Ruling, Tier } from "./types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const TIER_BADGE: Record<Tier, string> = {
  canon: "border-canon/60 text-canon",
  thread: "border-thread-tier/60 text-thread-tier",
  "story-local": "border-story-local/60 text-story-local",
  background: "border-background-tier/60 text-background-tier",
};

// The one-keystroke ruling row: the suggested tier is pre-picked (a single
// click accepts it as-is); "reject" needs no justification per the contract.
const RULINGS: { ruling: Ruling; label: string }[] = [
  { ruling: "canon", label: "canon" },
  { ruling: "thread", label: "thread" },
  { ruling: "story-local", label: "story-local" },
];

export function ReviewQueue({
  proposals,
  docs,
  onRule,
  onClose,
}: {
  proposals: Proposal[];
  docs: DocMeta[];
  onRule: (id: string, ruling: Ruling) => void;
  onClose: () => void;
}) {
  const groups = useMemo(() => groupProposalsByDoc(proposals), [proposals]);
  const docTitle = (docId: string) =>
    docId === UNGROUNDED ? "ungrounded" : (docs.find((d) => d.id === docId)?.title ?? docId);

  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-surface xl:w-96">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <h2 className="text-[10px] uppercase tracking-widest text-ink-faint">
          Review · {pendingCount} pending
        </h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close review queue" onClick={onClose}>
          <X size={12} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {groups.size === 0 ? (
          <p className="p-2 text-xs text-ink-faint">nothing pending — the board is caught up.</p>
        ) : (
          Array.from(groups.entries()).map(([docId, group]) => (
            <div key={docId}>
              <p className="px-1 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                {docTitle(docId)}
              </p>
              <div className="space-y-1.5">
                {group.map((p) => {
                  const { title, detail } = draftSummary(p);
                  return (
                    <div key={p.id} className="rounded border border-edge bg-bg p-2">
                      <div className="flex items-start justify-between gap-1.5">
                        <p className="text-xs text-ink">{title}</p>
                        <Badge
                          className={`shrink-0 px-1.5 py-0 text-[9px] ${TIER_BADGE[p.suggestedTier]}`}
                        >
                          {p.suggestedTier}
                        </Badge>
                      </div>
                      {detail && <p className="mt-1 text-[11px] text-ink-dim">{detail}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {RULINGS.map((r) => (
                          <Button
                            key={r.ruling}
                            size="auto"
                            className={`px-1.5 py-0.5 text-[10px] ${
                              r.ruling === p.suggestedTier ? TIER_BADGE[r.ruling] : ""
                            }`}
                            onClick={() => onRule(p.id, r.ruling)}
                          >
                            <Check size={10} />
                            {r.label}
                          </Button>
                        ))}
                        <Button
                          variant="ghost"
                          size="auto"
                          className="ml-auto px-1.5 py-0.5 text-[10px] text-ink-faint"
                          onClick={() => onRule(p.id, "reject")}
                        >
                          <X size={10} />
                          reject
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
