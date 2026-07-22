// Node detail — a floating card over the canvas (the conversation owns the
// right sidebar now). Shows what's "stored" at the last-selected node plus the
// candidate node-action vocabulary (Sensecape's Explain / Questions /
// Subtopics) as stubs — no agent behind them in the spike.

import {
  Crosshair,
  FileText,
  HelpCircle,
  ListTree,
  MessageSquare,
  ScrollText,
  Tag,
  X,
} from "lucide-react";
import { useState } from "react";
import { addTag, removeTag, TAG_CHIP, tagSuggestions } from "./state/tags";
import type { DocMeta, DocSourceRef, MapNode, MessageSourceRef } from "./types";
import { isDocSource } from "./types";
import { Button } from "./ui/button";

const VERBS = [
  { label: "Explain", icon: ScrollText },
  { label: "Questions", icon: HelpCircle },
  { label: "Subtopics", icon: ListTree },
] as const;

export function NodeDetail({
  node,
  docs,
  existingTags,
  onSetTags,
  onVerb,
  onOpenSource,
  onOpenMessageSource,
  onFocus,
  onClose,
}: {
  node: MapNode;
  docs: DocMeta[];
  // TAGS (R7): the client-derived existing-tag set (union of every node's +
  // proposal's tags — the engine keeps no registry) for the reuse autocomplete.
  existingTags: string[];
  // Target is the node id OR — for a pending proposal's synthetic node — the
  // proposal id (the synthetic-node-id-IS-proposal-id convention makes one
  // target key serve both). A wholesale PUT of the WHOLE new list.
  onSetTags: (targetId: string, tags: string[]) => void;
  onVerb: (verb: string, node: MapNode) => void;
  onOpenSource: (source: DocSourceRef) => void;
  // T11 — message-grounded evidence (Claim E): click navigates the
  // conversation panel to the anchored message instead of opening a doc.
  onOpenMessageSource: (source: MessageSourceRef) => void;
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
            if (isDocSource(s)) {
              // A docId absent from docs[] is tolerated by rendering
              // nothing (Claim A: nodes survive a doc delete; the stale
              // ref must never crash the card).
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
            }
            return (
              <Button
                key={`${s.messageId}:${s.span ?? ""}`}
                variant="card"
                size="auto"
                onClick={() => onOpenMessageSource(s)}
                className="justify-start rounded-md bg-secondary px-2 py-1.5"
              >
                <MessageSquare size={12} className="mt-0.5 shrink-0 self-start" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate">from the conversation</span>
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
      <TagsSection node={node} existingTags={existingTags} onSetTags={onSetTags} />
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

// TAGS (R7) — the Tags section beside Sources: current tags as removable chips,
// an input to add one, and a reuse-suggestion dropdown over the client-derived
// existing-tag set (curation is a surface concern; the engine stores freeform
// strings). Every edit PUTs the WHOLE new list (wholesale replace), routed by
// the node id — which, for a pending proposal's synthetic node, IS the proposal
// id (the target-keyed node_tags table).
function TagsSection({
  node,
  existingTags,
  onSetTags,
}: {
  node: MapNode;
  existingTags: string[];
  onSetTags: (targetId: string, tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const current = node.tags ?? [];
  const suggestions = focused ? tagSuggestions(existingTags, current, draft).slice(0, 6) : [];

  const commit = (raw: string) => {
    const next = addTag(current, raw);
    if (next !== current) onSetTags(node.id, next);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-ink-faint">
        <Tag size={10} aria-hidden /> Tags
      </div>
      {current.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {current.map((t) => (
            <span
              key={t}
              className={`flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-[10px] ${TAG_CHIP}`}
            >
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => onSetTags(node.id, removeTag(current, t))}
                className="text-ink-faint hover:text-attention"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          // Blur is deferred so a mousedown on a suggestion still fires (the
          // suggestion's onMouseDown preventDefault keeps focus, but the delay
          // is the belt-and-braces for a plain click too).
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Escape" && draft) {
              e.preventDefault();
              e.stopPropagation();
              setDraft("");
            }
          }}
          placeholder="add a tag…"
          aria-label="Add a tag"
          className="w-full rounded-md border border-edge bg-secondary px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-ring focus:outline-none"
        />
        {suggestions.length > 0 && (
          <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-32 overflow-y-auto rounded-md border border-edge bg-surface-raised py-1 shadow-xl">
            {suggestions.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  // Keep the input focused through the click so the dropdown
                  // doesn't blur-close before the handler runs.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(s)}
                  className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs text-ink-dim hover:bg-secondary hover:text-ink"
                >
                  <Tag size={10} className="shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 truncate">{s}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
