// The context canvas — read a source doc beside the map (the proposal's
// map ⇆ context split). Header idiom follows glamour's DetailsFlyout (title,
// kind chip, X).
//
// MDVIEW (finding #9): the body renders as MARKDOWN via the shared <Markdown>
// component (extracted from MessageBubble) — the same micromark render + the
// whitespace-tolerant TreeWalker span-flash the chat uses, so the evidence
// span still highlights and scrolls into view on rendered output. No more raw
// <pre> / hand-rolled 3-segment highlight / normalize() — micromark renders
// paragraphs, and the header already shows the title.
//
// BACKLINKS (finding #6): a "Referenced by" section derives (client-side, zero
// engine) the nodes/proposals that cite this doc — the inverse of the
// node→doc source jump. A click routes back to the map via onNavigate.

import { CornerDownRight, X } from "lucide-react";
import { useMemo } from "react";
import { Markdown } from "./Markdown";
import { type Backlink, backlinksFor } from "./state/backlinks";
import type { Doc, MapNode, Proposal } from "./types";
import { Button } from "./ui/button";

export function DocViewer({
  doc,
  highlight,
  nodes,
  proposals,
  onNavigate,
  onClose,
}: {
  doc: Doc;
  highlight?: string;
  nodes: MapNode[];
  proposals: Proposal[];
  // Route a clicked backlink back to the map (select + follow) — the inverse
  // of the node→doc onOpenSource jump.
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const backlinks = useMemo(
    () => backlinksFor(doc.id, nodes, proposals),
    [doc.id, nodes, proposals],
  );
  const hasBacklinks = backlinks.ratified.length + backlinks.pending.length > 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col border-l border-edge bg-surface">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
        <h2 className="min-w-0 truncate font-story text-sm text-ink">{doc.title}</h2>
        {/* K1: null kind = no chip at all (absence, not an empty pill). */}
        {doc.kind && (
          <span className="rounded bg-surface-raised px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-dim">
            {doc.kind}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close document"
          title="Close document"
          className="ml-auto shrink-0"
        >
          <X size={15} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <Markdown
          text={doc.content}
          highlightSpan={highlight ?? null}
          scrollToHighlight
          className="font-story text-sm leading-relaxed text-ink-dim"
        />
      </div>
      {hasBacklinks && (
        <div className="border-t border-edge px-5 py-3">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Referenced by
          </h3>
          <ul className="flex flex-col gap-1">
            {backlinks.ratified.map((b) => (
              <BacklinkRow key={b.id} link={b} pending={false} onNavigate={onNavigate} />
            ))}
            {backlinks.pending.map((b) => (
              <BacklinkRow key={b.id} link={b} pending onNavigate={onNavigate} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// A ratified node reads at its tier vocabulary (canon-ink); a pending proposal
// wears the pending stage tint (the staging-overlay token), so the two are
// distinguishable at a glance — same distinction the queue/canvas draw.
function BacklinkRow({
  link,
  pending,
  onNavigate,
}: {
  link: Backlink;
  pending: boolean;
  onNavigate: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onNavigate(link.id)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-ink-dim hover:bg-surface-raised hover:text-ink"
      >
        <CornerDownRight size={12} className="shrink-0 text-ink-faint" aria-hidden />
        <span className="min-w-0 truncate">{link.title}</span>
        {pending && (
          <span className="ml-auto shrink-0 rounded-full bg-pending/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-pending">
            pending
          </span>
        )}
      </button>
    </li>
  );
}
