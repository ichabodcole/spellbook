// The centre pane: the open document's header, the read-only view, and the
// status strip under it with real values (E18).
import { cn } from "cn";
import {
  BookOpenIcon,
  ColumnsIcon,
  FileCodeIcon,
  FileTextIcon,
  GitCompareIcon,
  SaveIcon,
  UndoDotIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/ui/resizable";
import { Separator } from "@/ui/separator";
import { useConfirm } from "../../../kit/ui/ConfirmDialog";
import type { DiffPayload, DiffSide, DocView } from "../../backend/protocol";
import { contentStats, relativeTime } from "../state/stats";
import { CompareView } from "./CompareView";
import { DocumentView } from "./DocumentView";
import { MarkdownView } from "./MarkdownView";
import { NewVersionDialog, type VersionIntent } from "./NewVersionDialog";
import { type At, NoteAtSelection } from "./NoteAtSelection";
import { type StatusSegment, StatusStrip } from "./StatusStrip";
import { VersionMenu, versionSummary } from "./VersionMenu";

/**
 * E29's three modes from Operator's editor — raw, rendered, and both — plus
 * E36's `compare`, which is a different KIND of thing and shares the toolbar
 * anyway: the other three show one text, compare shows two. It sits here
 * because "how am I looking at this document" is the question the toolbar
 * answers, and a comparison is an answer to it.
 */
export const VIEW_MODES = ["raw", "rendered", "split", "compare"] as const;
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
  { mode: "compare", label: "Compare with another version", icon: GitCompareIcon },
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
  diff,
  onAgainst,
  onTake,
  onActivate,
  onNewVersion,
  onDeleteVersion,
  onRevealVersion,
  onSelect,
  reveal,
  focusedNote,
  onAddNote,
  onShowNote,
  onDeleteNote,
  splitLayout,
  onEdit,
  onSave,
  onRevert,
  onFollowLink,
  onAddFrontmatter,
}: {
  doc: DocView | null;
  text: string | undefined;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  /** The daemon's comparison — null until the first answer arrives (E36). */
  diff: DiffPayload | null;
  /** The side the picker changes to; which side is SHOWN comes from the payload. */
  onAgainst: (side: DiffSide) => void;
  onTake: (hunks: number[]) => void;
  /** E37: the human makes a version, and chooses which one is active. */
  onActivate: (version: number) => void;
  onNewVersion: (label: string, intent: VersionIntent) => void;
  onDeleteVersion: (version: number) => void;
  onRevealVersion: (version: number) => void;
  /** E45/E48: the editor's selection — offsets for notes, lines for the wire. */
  onSelect: (from: number, to: number, fromLine: number, toLine: number, text: string) => void;
  reveal: { from: number; to: number; seq: number } | null;
  /** E47: the note the panel has focused — the rendered view paints it apart. */
  focusedNote: string | null;
  onAddNote: (from: number, to: number, body: string) => void;
  /** E47: the document pointing at a note — the panel borders it. */
  onShowNote: (id: string) => void;
  onDeleteNote: (id: string) => void;
  /** The buffer, debounced by the editor — written to the active version (E7). */
  onEdit: (text: string) => void;
  /** Write the active version over the original. The human's decision, always. */
  onSave: () => void;
  /** Take the file on disk back over the active version. */
  onRevert: () => void;
  /** A link inside the rendered document — the daemon resolves it (E33). */
  onFollowLink: (target: string) => void;
  /** Offer a frontmatter block for a document that has none (E35). */
  onAddFrontmatter: () => void;
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
  const [naming, setNaming] = useState<VersionIntent | null>(null);
  const { confirm, dialog } = useConfirm();
  /** Where the human right-clicked a passage, and which passage (E46). */
  const [noteAt, setNoteAt] = useState<At | null>(null);

  const segments: StatusSegment[] = doc
    ? [
        // Read-only here, and a control in the header (E38): the strip is where
        // you glance to see WHICH version, the header is where you go to change
        // it. The name is shown here precisely because nothing competes with it.
        { label: "Version", value: versionSummary(active, doc.active) },
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
            {/* ⛔ LEFT OF THE TITLE, AND THAT IS THE POINT (Cole, E38). The
                strip below is read-only status, so the one control down there
                did not read as a control at all — and which version you are in
                is not a status property, it is part of what you are looking
                at. It reads with the name now: "v2 · the agent's pass —
                note.md". */}
            <VersionMenu
              versions={doc.versions}
              active={doc.active}
              onActivate={onActivate}
              onCompare={(n) => {
                onAgainst(n);
                onMode("compare");
              }}
              onNewVersion={setNaming}
              onReveal={onRevealVersion}
              onDelete={async (n) => {
                const v = doc.versions.find((x) => x.n === n);
                // ⛔ ASKED, because this removes a FILE. The version's own text
                // is the only copy of whatever was tried in it — the original
                // on disk and the active version both survive, but what was
                // written here does not.
                const ok = await confirm({
                  title: `Delete ${v?.label?.trim() ? `“${v.label.trim()}”` : `v${n}`}?`,
                  message: `v${n} and its file are removed from this session. The file on disk and the version you are editing are untouched.`,
                  warning: "Anything written only in this version is lost.",
                  confirmLabel: "Delete",
                  confirmClassName: "bg-danger text-bg hover:bg-danger/90",
                });
                if (ok) onDeleteVersion(n);
              }}
            />
            <Separator orientation="vertical" className="my-2 shrink-0" />
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
                title={`Save v${doc.active} to ${doc.name} — the file in your folder (⌘S)`}
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
      {doc && shown !== undefined && doc.meta === null && (
        // E35: OFFERED, never written for them. A document dropped in from
        // elsewhere is somebody else's file; the block lands in the BUFFER, so
        // the human reads it before Save puts it on disk.
        <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/60 px-3 py-1.5 text-xs text-ink-dim">
          <span>This document has no frontmatter.</span>
          <button
            type="button"
            onClick={onAddFrontmatter}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline"
          >
            Add a block
          </button>
        </div>
      )}
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
      ) : showing === "compare" ? (
        // The payload is asked for by App whenever the document, the active
        // version or the chosen side changes; until the first one lands the
        // pane holds its space rather than flashing an empty comparison.
        diff && diff.doc === doc.slug ? (
          <CompareView
            payload={diff}
            file={doc.name}
            versions={doc.versions}
            onAgainst={onAgainst}
            onTake={onTake}
          />
        ) : (
          <div className="flex-1" aria-busy="true" />
        )
      ) : showing === "raw" ? (
        <DocumentView
          docKey={doc.slug}
          text={shown}
          editable
          notes={doc.notes}
          onChange={onEdit}
          onSave={onSave}
          onSelect={onSelect}
          reveal={reveal}
          pendingNote={noteAt && noteAt.from < noteAt.to ? noteAt : null}
          onContextMenu={setNoteAt}
        />
      ) : showing === "rendered" ? (
        <MarkdownView
          text={shown}
          meta={doc.meta}
          notes={doc.notes}
          focusedNote={focusedNote}
          pendingNote={noteAt && noteAt.from < noteAt.to ? noteAt : null}
          onFollowLink={onFollowLink}
          onSelect={onSelect}
          onContextMenu={setNoteAt}
        />
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
              notes={doc.notes}
              onChange={onEdit}
              onSave={onSave}
              onSelect={onSelect}
              reveal={reveal}
              pendingNote={noteAt && noteAt.from < noteAt.to ? noteAt : null}
              onContextMenu={setNoteAt}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="doc-rendered"
            defaultSize="50"
            minSize="25"
            className="flex flex-col border-l border-edge"
          >
            <MarkdownView
              text={shown}
              meta={doc.meta}
              notes={doc.notes}
              focusedNote={focusedNote}
              pendingNote={noteAt && noteAt.from < noteAt.to ? noteAt : null}
              onFollowLink={onFollowLink}
              onSelect={onSelect}
              onContextMenu={setNoteAt}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      {doc && <StatusStrip segments={segments} />}
      {dialog}
      <NoteAtSelection
        at={noteAt}
        quote={noteAt && shown !== undefined ? shown.slice(noteAt.from, noteAt.to) : ""}
        existing={(noteAt?.noteIds ?? []).flatMap((id) => {
          const n = doc?.notes.find((x) => x.id === id);
          return n ? [{ id, label: n.body }] : [];
        })}
        onClose={() => setNoteAt(null)}
        onAdd={onAddNote}
        onShowNote={onShowNote}
        onDeleteNote={onDeleteNote}
      />
      {doc && (
        <NewVersionDialog
          open={naming !== null}
          intent={naming ?? "branch"}
          from={doc.active}
          next={Math.max(...doc.versions.map((v) => v.n)) + 1}
          onOpenChange={(o) => {
            if (!o) setNaming(null);
          }}
          onCreate={(label) => onNewVersion(label, naming ?? "branch")}
        />
      )}
    </div>
  );
}
