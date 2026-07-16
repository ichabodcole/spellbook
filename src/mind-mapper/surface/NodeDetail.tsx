// Node detail — a floating card over the canvas (the conversation owns the
// right sidebar now). Shows what's "stored" at the last-selected node plus the
// candidate node-action vocabulary (Sensecape's Explain / Questions /
// Subtopics) as stubs — no agent behind them in the spike.

import { Crosshair, FileText, HelpCircle, ListTree, ScrollText, X } from "lucide-react";
import type { DocMeta, MapNode, SourceRef } from "./types";
import { Button } from "./ui/button";

const VERBS = [
  { label: "Explain", icon: ScrollText },
  { label: "Questions", icon: HelpCircle },
  { label: "Subtopics", icon: ListTree },
] as const;

export function NodeDetail({
  node,
  docs,
  onVerb,
  onOpenSource,
  onFocus,
  onClose,
}: {
  node: MapNode;
  docs: DocMeta[];
  onVerb: (verb: string, node: MapNode) => void;
  onOpenSource: (source: SourceRef) => void;
  onFocus: (node: MapNode) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex w-72 flex-col gap-3 rounded-lg border border-edge bg-surface/95 p-4 shadow-xl backdrop-blur">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="text-[10px] uppercase tracking-widest text-ink-dim">
            {node.kind} · {node.tier}
            {node.pending ? " · proposed" : ""}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Focus on ${node.title}`}
              title="Focus — narrow the map to this neighborhood"
              onClick={() => onFocus(node)}
            >
              <Crosshair size={13} />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Close node detail" onClick={onClose}>
              <X size={13} />
            </Button>
          </div>
        </div>
        <h2 className="mt-1 font-story text-xl text-ink">{node.title}</h2>
      </div>
      <p className="text-sm leading-relaxed text-ink-dim">{node.synopsis}</p>
      {node.pending && (
        <p className="rounded-md border border-dashed border-pending/60 px-2 py-1.5 text-xs text-pending">
          Staging: proposed, not yet ratified into canon.
        </p>
      )}
      {node.sources && node.sources.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-widest text-ink-faint">Sources</div>
          {node.sources.map((s) => {
            const doc = docs.find((d) => d.id === s.docId);
            if (!doc) return null;
            return (
              <Button
                key={`${s.docId}:${s.span ?? ""}`}
                variant="card"
                size="auto"
                onClick={() => onOpenSource(s)}
                className="justify-start rounded-md bg-secondary px-2 py-1.5"
              >
                <FileText size={12} className="mt-0.5 shrink-0 self-start" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate">{doc.title}</span>
                  {s.span && (
                    <span className="mt-0.5 block truncate text-[11px] italic text-ink-faint">
                      "{s.span}"
                    </span>
                  )}
                </span>
              </Button>
            );
          })}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-widest text-ink-faint">Ask the map</div>
        <div className="flex gap-1.5">
          {VERBS.map(({ label, icon: Icon }) => (
            <Button
              key={label}
              size="auto"
              onClick={() => onVerb(label, node)}
              className="flex-1 flex-col gap-1 px-2 py-2"
            >
              <Icon size={14} aria-hidden />
              {label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
