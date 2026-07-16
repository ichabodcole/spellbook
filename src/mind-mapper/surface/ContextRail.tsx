// The context rail — every source doc in the session, as cards. Adapted from
// imago's ContextLibrary / glamour's LibraryTile idiom (kind badge, selected
// ring, bottom title) reshaped to rows for a doc list. Doc-kind tints reuse
// the tier vocabulary on purpose: bible = canon, story = story-local,
// ramble = pending (raw capture is staging-colored until its claims ratify).

import { BookOpen, Mic, ScrollText } from "lucide-react";
import type { DocKind, DocMeta } from "./types";
import { Button } from "./ui/button";

const KIND_ICON: Record<DocKind, typeof BookOpen> = {
  ramble: Mic,
  story: ScrollText,
  bible: BookOpen,
};

const KIND_BADGE: Record<DocKind, string> = {
  ramble: "bg-pending/20 text-pending",
  story: "bg-story-local/20 text-story-local",
  bible: "bg-canon/20 text-canon",
};

export function ContextRail({
  docs,
  openDocId,
  onOpen,
}: {
  docs: DocMeta[];
  openDocId: string | null;
  onOpen: (docId: string) => void;
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-surface">
      <div className="border-b border-edge px-3 py-2">
        <h2 className="text-[10px] uppercase tracking-widest text-ink-faint">Context</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {docs.length === 0 ? (
          <p className="p-2 text-xs text-ink-faint">no source docs in this session yet.</p>
        ) : (
          docs.map((d) => {
            const Icon = KIND_ICON[d.kind];
            const open = d.id === openDocId;
            return (
              <Button
                key={d.id}
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
              </Button>
            );
          })
        )}
      </div>
    </aside>
  );
}
