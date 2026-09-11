// The centre pane: the open document's header, the read-only view, and the
// status strip under it with real values (E18).
import { FileTextIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import type { DocView } from "../../backend/protocol";
import { contentStats, relativeTime } from "../state/stats";
import { DocumentView } from "./DocumentView";
import { type StatusSegment, StatusStrip } from "./StatusStrip";

/** Recount after typing pauses, as Operator's useContentStats does (300 ms). */
function useDebouncedStats(text: string | undefined, ms = 300) {
  const [stats, setStats] = useState(() => contentStats(text ?? ""));
  useEffect(() => {
    const t = setTimeout(() => setStats(contentStats(text ?? "")), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return stats;
}

/** Re-render on a slow clock so "5 min ago" stays true. */
function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function DocumentPane({ doc, text }: { doc: DocView | null; text: string | undefined }) {
  // While a newly active version's text is on its way, keep showing the last
  // text of THIS document rather than blanking the pane (verify pass).
  const lastShown = useRef<{ slug: string; text: string } | null>(null);
  if (doc && text !== undefined) lastShown.current = { slug: doc.slug, text };
  const shown =
    text ?? (doc && lastShown.current?.slug === doc.slug ? lastShown.current.text : undefined);
  const stats = useDebouncedStats(shown);
  const now = useNow();
  const active = doc?.versions.find((v) => v.n === doc.active);

  const segments: StatusSegment[] = doc
    ? [
        { label: "Version", value: `v${doc.active}${active?.label ? ` · ${active.label}` : ""}` },
        { label: "Author", value: active?.author === "agent" ? "Agent" : "Human", priority: "low" },
        {
          label: "Updated",
          value: active ? relativeTime(active.createdAt, now) : "—",
          priority: "low",
        },
        { value: doc.outsideChanged ? "Changed on disk" : doc.dirty ? "Unsaved" : "Saved" },
        { label: "Words", value: stats.words.toLocaleString() },
        { label: "Characters", value: stats.characters.toLocaleString(), priority: "low" },
      ]
    : [];

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
        {doc ? (
          <>
            <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
            <span className="truncate text-sm text-ink" title={doc.original}>
              {doc.name}
            </span>
            <span className="ml-auto shrink-0 rounded-sm bg-surface-raised px-1.5 py-0.5 text-[11px] text-ink-faint">
              read-only
            </span>
          </>
        ) : (
          <span className="text-xs font-medium tracking-wide text-ink-dim uppercase">Document</span>
        )}
      </div>
      {!doc ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileTextIcon />
            </EmptyMedia>
            <EmptyTitle>No document open</EmptyTitle>
            <EmptyDescription>
              Pick a document from the context pane to read it here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : shown === undefined ? (
        <div className="flex-1" aria-busy="true" />
      ) : (
        <DocumentView docKey={doc.slug} text={shown} />
      )}
      {doc && <StatusStrip segments={segments} />}
    </>
  );
}
