// The centre pane: the open document's header, the read-only view, and the
// status strip under it with real values (E18).
import { cn } from "cn";
import {
  BookOpenIcon,
  ColumnsIcon,
  FileCodeIcon,
  FileTextIcon,
  SaveIcon,
  UndoDotIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/ui/resizable";
import type { DocView } from "../../backend/protocol";
import { contentStats, relativeTime } from "../state/stats";
import { DocumentView } from "./DocumentView";
import { MarkdownView } from "./MarkdownView";
import { type StatusSegment, StatusStrip } from "./StatusStrip";

/** E29: the three modes Operator's editor has — raw, rendered, and both. */
export const VIEW_MODES = ["raw", "rendered", "split"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/**
 * Below this the pane cannot hold two readable columns: the raw view's measure
 * is 76ch and the rendered view's the same, so a split narrower than this is
 * two columns of broken lines rather than a comparison. Split is then not
 * offered, and a SAVED split falls back to rendered until there is room again —
 * the pane is resizable and the chat pane is beside it, so "enough room" is a
 * thing the human changes minute to minute (E11).
 */
const SPLIT_MIN_PX = 720;

/** The pane's own width, watched — a container query cannot change a MODE. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const MODE_BUTTONS: { mode: ViewMode; label: string; icon: typeof FileTextIcon }[] = [
  { mode: "raw", label: "Raw markdown", icon: FileCodeIcon },
  { mode: "rendered", label: "Rendered", icon: BookOpenIcon },
  { mode: "split", label: "Raw and rendered side by side", icon: ColumnsIcon },
];

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

export function DocumentPane({
  doc,
  text,
  mode,
  onMode,
  splitLayout,
  onEdit,
  onSave,
  onRevert,
}: {
  doc: DocView | null;
  text: string | undefined;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  /** The buffer, debounced by the editor — written to the active version (E7). */
  onEdit: (text: string) => void;
  /** Write the active version over the original. The human's decision, always. */
  onSave: () => void;
  /** Take the file on disk back over the active version. */
  onRevert: () => void;
  /** The saved sizes of the split, kept in the home's prefs like the outer panes. */
  splitLayout: {
    defaultLayout: Parameters<typeof ResizablePanelGroup>[0]["defaultLayout"];
    onLayoutChanged: Parameters<typeof ResizablePanelGroup>[0]["onLayoutChanged"];
  };
}) {
  // While a newly active version's text is on its way, keep showing the last
  // text of THIS document rather than blanking the pane (verify pass).
  const lastShown = useRef<{ slug: string; text: string } | null>(null);
  if (doc && text !== undefined) lastShown.current = { slug: doc.slug, text };
  const shown =
    text ?? (doc && lastShown.current?.slug === doc.slug ? lastShown.current.text : undefined);
  const stats = useDebouncedStats(shown);
  const now = useNow();
  const [paneRef, width] = useWidth();
  // Width 0 is "not measured yet", not "too narrow": a saved split must not
  // flicker through rendered on the first frame.
  const roomToSplit = width === 0 || width >= SPLIT_MIN_PX;
  const showing: ViewMode = mode === "split" && !roomToSplit ? "rendered" : mode;
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
    <div ref={paneRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
        {doc ? (
          <>
            <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
            <span className="truncate text-sm text-ink" title={doc.original}>
              {doc.name}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={onRevert}
                disabled={!doc.dirty && !doc.outsideChanged}
                title="Take the file on disk back over your edits"
                className="h-7 gap-1.5 px-2 text-xs"
              >
                <UndoDotIcon className="size-3.5" />
                Revert
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSave}
                disabled={!doc.dirty}
                title="Write this version over the file (⌘S)"
                className="h-7 gap-1.5 px-2 text-xs"
              >
                <SaveIcon className="size-3.5" />
                Save
              </Button>
              <div
                role="toolbar"
                aria-label="How to show this document"
                className="flex items-center gap-0.5 rounded-md bg-surface-raised p-0.5"
              >
                {MODE_BUTTONS.map(({ mode: m, label, icon: Icon }) => {
                  const unavailable = m === "split" && !roomToSplit;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => onMode(m)}
                      disabled={unavailable}
                      aria-pressed={showing === m}
                      aria-label={label}
                      title={unavailable ? `${label} — the pane is too narrow` : label}
                      className={cn(
                        "flex size-6 items-center justify-center rounded-sm text-ink-faint outline-none",
                        "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-faint",
                        showing === m && "bg-bg text-ink shadow-sm",
                      )}
                    >
                      <Icon aria-hidden className="size-3.5" />
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <span className="text-xs font-medium tracking-wide text-ink-dim uppercase">Document</span>
        )}
      </div>
      {doc?.outsideChanged && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-attention/40 bg-attention/10 px-3 py-1.5 text-xs text-ink"
        >
          <span className="min-w-0 flex-1">
            This file changed on disk while you have unsaved edits.
          </span>
          <button
            type="button"
            onClick={onSave}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline"
          >
            Keep mine
          </button>
          <button
            type="button"
            onClick={onRevert}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline"
          >
            Take the file's
          </button>
        </div>
      )}
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
      ) : showing === "raw" ? (
        <DocumentView docKey={doc.slug} text={shown} editable onChange={onEdit} onSave={onSave} />
      ) : showing === "rendered" ? (
        <MarkdownView text={shown} meta={doc.meta} />
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={splitLayout.defaultLayout}
          onLayoutChanged={splitLayout.onLayoutChanged}
        >
          <ResizablePanel id="doc-raw" defaultSize="50" minSize="25" className="flex flex-col">
            <DocumentView
              docKey={doc.slug}
              text={shown}
              editable
              onChange={onEdit}
              onSave={onSave}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="doc-rendered"
            defaultSize="50"
            minSize="25"
            className="flex flex-col border-l border-edge"
          >
            <MarkdownView text={shown} meta={doc.meta} />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      {doc && <StatusStrip segments={segments} />}
    </div>
  );
}
