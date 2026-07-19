// The context rail — every source doc in the session, as cards. Adapted from
// imago's ContextLibrary / glamour's LibraryTile idiom (kind badge, selected
// ring, bottom title) reshaped to rows for a doc list. Doc-kind tints reuse
// the tier vocabulary on purpose: bible = canon, story = story-local,
// ramble = pending (raw capture is staging-colored until its claims ratify).
//
// P2.2 — intake affordances (plan/circe.md): the whole rail is a drop
// target (file intake), and "+ new document" opens a minimal compose form
// (title required; an optional brain-dump body routes to ingestText/ramble,
// left empty routes to ingestBlank/story). Both converge on state/intake.ts,
// which converges on POST /ingest — the rail itself stays a dumb list
// renderer plus these two entry points, no ingest logic inline here.

import { BookOpen, Crosshair, Mic, Plus, ScrollText, Sparkles, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import type { DocKind, DocMeta } from "./types";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Textarea } from "./ui/textarea";

const KIND_ICON: Record<DocKind, typeof BookOpen> = {
  ramble: Mic,
  story: ScrollText,
  bible: BookOpen,
};

// Exported as the surface's doc-kind tint vocabulary — MessageBubble's
// doc-ref chips (Claim G) reuse it so a doc reads the same color everywhere.
export const KIND_BADGE: Record<DocKind, string> = {
  ramble: "bg-pending/20 text-pending",
  story: "bg-story-local/20 text-story-local",
  bible: "bg-canon/20 text-canon",
};

export function ContextRail({
  docs,
  openDocId,
  onOpen,
  onIngestFiles,
  onIngestText,
  onIngestBlank,
  onAnalyze,
  onDocLens,
  onDelete,
}: {
  docs: DocMeta[];
  openDocId: string | null;
  onOpen: (docId: string) => void;
  onIngestFiles: (files: FileList) => void;
  onIngestText: (title: string, text: string) => void;
  onIngestBlank: (title: string) => void;
  // T5/T6 — the doc card context menu's two verbs. Analyze is a normal
  // conversational message (Claim G); Delete only STARTS the confirm flow
  // (Claim A: the unforced DELETE is never fired from the raw click).
  onAnalyze: (doc: DocMeta) => void;
  // V2 — "Show extracted nodes": sets the doc lens. Lives in the context
  // menu AND as the card's hover crosshair twin — single-click keeps meaning
  // open-viewer (ruled: falsified card-click-as-lens at ratify).
  onDocLens: (doc: DocMeta) => void;
  onDelete: (doc: DocMeta) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const submitCompose = () => {
    const t = title.trim();
    if (!t) return;
    if (body.trim()) onIngestText(t, body);
    else onIngestBlank(t);
    setTitle("");
    setBody("");
    setComposing(false);
  };

  return (
    <aside
      className={`flex w-56 shrink-0 flex-col border-r border-edge bg-surface ${
        dragOver ? "ring-2 ring-inset ring-ring/60" : ""
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) onIngestFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <h2 className="text-[10px] uppercase tracking-widest text-ink-faint">Context</h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Add a document"
          title="Add a document"
          onClick={() => setComposing((c) => !c)}
        >
          <Plus size={12} />
        </Button>
      </div>
      {composing && (
        <div className="space-y-1.5 border-b border-edge p-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setComposing(false)}
            placeholder="document title…"
            aria-label="New document title"
            className="w-full rounded border border-edge bg-bg px-1.5 py-1 text-xs text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="paste or write a brain-dump… (leave empty for a blank doc)"
            className="min-h-16 p-1.5 text-xs"
          />
          <div className="flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="auto"
              className="px-2 py-1"
              onClick={() => setComposing(false)}
            >
              cancel
            </Button>
            <Button
              size="auto"
              className="px-2 py-1"
              onClick={submitCompose}
              disabled={!title.trim()}
            >
              add
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {docs.length === 0 ? (
          <p className="flex items-start gap-1.5 p-2 text-xs text-ink-faint">
            <Upload size={13} className="mt-0.5 shrink-0" aria-hidden />
            no source docs yet — drop a file or "+" one.
          </p>
        ) : (
          docs.map((d) => {
            const Icon = KIND_ICON[d.kind];
            const open = d.id === openDocId;
            return (
              <ContextMenu key={d.id}>
                <ContextMenuTrigger>
                  {/* The hover crosshair is a SIBLING overlay, not a child —
                      a button nested in a button is invalid HTML, and the
                      twin must not hijack the card's open-viewer click. */}
                  <div className="group relative">
                    <Button
                      variant="card"
                      size="auto"
                      onClick={() => onOpen(d.id)}
                      className={`flex-col items-start gap-0 p-2.5 ${
                        open ? "border-ring bg-secondary ring-1 ring-ring/40" : ""
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon size={13} className="shrink-0 text-ink-dim" aria-hidden />
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${KIND_BADGE[d.kind]}`}
                        >
                          {d.kind}
                        </span>
                      </div>
                      <p className="mt-1.5 w-full truncate text-xs text-ink">{d.title}</p>
                      {d.mark && (
                        // T7 — the live mark (Claim B): status text, stale
                        // tint when the file moved on after the mark vouched
                        // for it. The note rides as a hover title — the badge
                        // stays a glance, not a paragraph.
                        <p
                          className={`mt-1 w-full truncate text-[9px] ${
                            d.mark.stale ? "text-attention" : "text-ink-faint"
                          }`}
                          title={d.mark.note ?? undefined}
                        >
                          {d.mark.status}
                          {d.mark.stale ? " · stale" : ""} · {d.mark.author}
                        </p>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Show nodes extracted from ${d.title}`}
                      title="Show extracted nodes"
                      onClick={() => onDocLens(d)}
                      className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Crosshair size={11} />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuLabel>{d.title}</ContextMenuLabel>
                  <ContextMenuItem onClick={() => onAnalyze(d)}>
                    <Sparkles /> Analyze
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onDocLens(d)}>
                    <Crosshair /> Show extracted nodes
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onDelete(d)} className="text-attention">
                    <Trash2 /> Delete…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })
        )}
      </div>
    </aside>
  );
}
