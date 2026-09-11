// THE CONTEXT SIDEBAR — built to be reused across apps (E16), so its boundary
// is PROPS ONLY: entries, the open document, callbacks, and a `listDir` for the
// path box. No WebSocket, no fetch, no daemon types beyond the wire's shapes.
// When a second app needs it, it moves to `src/kit/` as it stands.
//
// Two views of ONE entry type (E15):
//   · the LIST — every context entry. One holding a single document shows as
//     that document and opens it on click; any other entry shows as a set and
//     drills in on click.
//   · a SET, drilled into — its tree (EntryTree), with a way back to the list.
import { cn } from "cn";
import { ArrowLeftIcon, FileTextIcon, FolderTreeIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Button } from "@/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import type { ContextEntry } from "../../../backend/protocol";
import type { Listing } from "../../state/useDaemon";
import { AddPath } from "./AddPath";
import { EntryTree } from "./EntryTree";
import { docsIn, joinPath, shortPath, singleDoc, tildify } from "./model";

/** Said up front, not ellipsed away at the end of a subtitle (verify pass). */
function TruncatedBadge() {
  return (
    <span
      className="shrink-0 rounded-sm bg-attention/15 px-1 font-sans text-[10px] font-medium text-attention"
      title="This folder has more files than the sidebar lists — the scan stopped at its cap."
    >
      partial
    </span>
  );
}

export type ContextSidebarProps = {
  entries: readonly ContextEntry[];
  /** The open document, located by its entry and rel — or null. */
  activeDoc: { entryId: string; rel: string } | null;
  /** For `~` abbreviation of paths; null shows them absolute. */
  userHome: string | null;
  onOpenDoc: (entry: ContextEntry, rel: string) => void;
  onAddPath: (path: string) => void;
  onRemoveEntry: (entry: ContextEntry) => void;
  listDir: (path: string) => Promise<Listing>;
  /** A refusal to show the human (a path that could not be added, …), or null. */
  notice?: string | null;
  onDismissNotice?: () => void;
};

/** macOS has no native key for a context menu, so Shift+F10 is synthesised (grapevine's ChannelRail). */
function openMenuOnShiftF10(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "F10" || !e.shiftKey) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: r.left + 24,
      clientY: r.top + r.height / 2,
    }),
  );
}

export function ContextSidebar({
  entries,
  activeDoc,
  userHome,
  onOpenDoc,
  onAddPath,
  onRemoveEntry,
  listDir,
  notice,
  onDismissNotice,
}: ContextSidebarProps) {
  const [drilled, setDrilled] = useState<string | null>(null);
  const drilledEntry = drilled ? entries.find((e) => e.id === drilled) : undefined;

  // A drilled entry that was removed returns the view to the list.
  useEffect(() => {
    if (drilled && !drilledEntry) setDrilled(null);
  }, [drilled, drilledEntry]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {drilledEntry ? (
        <SetView
          entry={drilledEntry}
          activeRel={activeDoc?.entryId === drilledEntry.id ? activeDoc.rel : null}
          userHome={userHome}
          onBack={() => setDrilled(null)}
          onOpenDoc={(rel) => onOpenDoc(drilledEntry, rel)}
        />
      ) : (
        <ListView
          entries={entries}
          activeDoc={activeDoc}
          userHome={userHome}
          onOpenDoc={onOpenDoc}
          onDrill={(e) => setDrilled(e.id)}
          onRemoveEntry={onRemoveEntry}
        />
      )}
      {notice && (
        <div
          role="alert"
          className="mx-2 mb-1 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-ink"
        >
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          {onDismissNotice && (
            <button
              type="button"
              onClick={onDismissNotice}
              aria-label="Dismiss"
              className="shrink-0 text-ink-dim hover:text-ink"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <AddPath listDir={listDir} onAdd={onAddPath} />
    </div>
  );
}

function ListView({
  entries,
  activeDoc,
  userHome,
  onOpenDoc,
  onDrill,
  onRemoveEntry,
}: {
  entries: readonly ContextEntry[];
  activeDoc: ContextSidebarProps["activeDoc"];
  userHome: string | null;
  onOpenDoc: ContextSidebarProps["onOpenDoc"];
  onDrill: (entry: ContextEntry) => void;
  onRemoveEntry: ContextSidebarProps["onRemoveEntry"];
}) {
  if (entries.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderTreeIcon />
          </EmptyMedia>
          <EmptyTitle>No context yet</EmptyTitle>
          <EmptyDescription>
            Add a markdown file or a folder by path below — or ask the agent to add one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5" aria-label="Context">
      {entries.map((entry) => {
        const only = singleDoc(entry);
        const holdsActive = activeDoc?.entryId === entry.id;
        const isActiveDoc = only !== null && holdsActive && activeDoc?.rel === only.rel;
        const count = only ? 1 : docsIn(entry.nodes).length;
        const full = only ? joinPath(entry.root, only.rel) : entry.root;
        // A single document's row names its FOLDER (the file name is the title);
        // a set's row names its root. Cut from the front; the tooltip is whole.
        const where = shortPath(entry.root, userHome);
        return (
          <li key={entry.id}>
            <ContextMenu>
              <ContextMenuTrigger
                render={
                  <button
                    type="button"
                    onClick={() => (only ? onOpenDoc(entry, only.rel) : onDrill(entry))}
                    onKeyDown={openMenuOnShiftF10}
                    title={tildify(full, userHome)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none",
                      "hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60",
                      (isActiveDoc || (holdsActive && !only)) && "bg-rubric/12",
                    )}
                  />
                }
              >
                {only ? (
                  <FileTextIcon
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0",
                      isActiveDoc ? "text-rubric" : "text-ink-faint",
                    )}
                  />
                ) : (
                  <FolderTreeIcon
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0",
                      holdsActive ? "text-rubric" : "text-ink-faint",
                    )}
                  />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      "truncate text-sm",
                      isActiveDoc ? "font-medium text-ink" : "text-ink",
                    )}
                  >
                    {only ? only.rel.split("/").pop() : entry.label}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-ink-dim">
                    {entry.truncated && <TruncatedBadge />}
                    <span className="truncate">
                      {only
                        ? where
                        : `${count} ${count === 1 ? "document" : "documents"} · ${where}`}
                    </span>
                  </span>
                </span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {!only && (
                  <>
                    <ContextMenuItem onClick={() => onDrill(entry)}>Open set</ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )}
                <ContextMenuItem variant="destructive" onClick={() => onRemoveEntry(entry)}>
                  <XIcon />
                  Remove from context
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </li>
        );
      })}
    </ul>
  );
}

function SetView({
  entry,
  activeRel,
  userHome,
  onBack,
  onOpenDoc,
}: {
  entry: ContextEntry;
  activeRel: string | null;
  userHome: string | null;
  onBack: () => void;
  onOpenDoc: (rel: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-1.5 py-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="Back to the context list"
        >
          <ArrowLeftIcon />
        </Button>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-ink">{entry.label}</span>
          <span
            className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px] text-ink-dim"
            title={entry.root}
          >
            {entry.truncated && <TruncatedBadge />}
            {shortPath(entry.root, userHome)}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1">
        <EntryTree key={entry.id} entry={entry} activeRel={activeRel} onOpenDoc={onOpenDoc} />
      </div>
    </div>
  );
}
