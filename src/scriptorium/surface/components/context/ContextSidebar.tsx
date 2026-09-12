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
//
// Organizing (E22–E24) is menus and dragging here and CLI verbs for the agent;
// both send the same structure ops and the daemon does the real change on disk.
// Nothing here deletes a file: "Remove from Scriptorium" hides.
import { cn } from "cn";
import {
  ArrowLeftIcon,
  EyeIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  HomeIcon,
  NetworkIcon,
  PencilIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { useConfirm } from "../../../../kit/ui/ConfirmDialog";
import type { ContextEntry, DocSummary, StructureOp } from "../../../backend/protocol";
import type { Listing, Mapping, Planning } from "../../state/useDaemon";
import { AddPath } from "./AddPath";
import { EntryTree } from "./EntryTree";
import { MapOverlay } from "./MapOverlay";
import { carriesFiles, droppedFiles, MoveToMenu, RevealItem } from "./menus";
import {
  baseName,
  dirOf,
  docsIn,
  joinPath,
  moveTargets,
  shortPath,
  singleDoc,
  splitDropped,
  statusMark,
  tildify,
} from "./model";

/** The drag payload of a row dragged within the sidebar: its absolute path. */
const ROW_MIME = "application/x-scriptorium-path";

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
  /** E23: where drops and new top-level documents land. */
  workspace: string;
  onOpenDoc: (entry: ContextEntry, rel: string) => void;
  onAddPath: (path: string) => void;
  /** Every organizing change — the daemon does it on disk (E24). */
  onStructure: (op: StructureOp) => void;
  /** Show a path in the OS file manager. */
  onReveal: (path: string) => void;
  /** Open the OS's own picker and add (or set as the workspace) what comes back. */
  onPick: (want: "context-file" | "context-folder" | "workspace") => void;
  /** A document's frontmatter summary, by absolute path (E32). */
  metaFor: (path: string) => DocSummary | undefined;
  listDir: (path: string) => Promise<Listing>;
  /** What a move would do — asked before a FOLDER is moved (E26). */
  planMove: (path: string, into: string) => Promise<Planning>;
  /** A set's map (E33), for the overlay. */
  mapOf: (entry: string) => Promise<Mapping>;
  /** Open a document by absolute path — the map's click, and a followed link. */
  onOpenPath: (path: string) => void;
  /** A new document or folder this viewer just made: shown in rename mode. `seq` makes a repeat new. */
  created?: { path: string; seq: number } | null;
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

/** An entry's own path: a set's folder, or a single document's file. */
const entryPath = (entry: ContextEntry): string => {
  const only = singleDoc(entry);
  return only ? joinPath(entry.root, only.rel) : entry.root;
};

export function ContextSidebar({
  entries,
  activeDoc,
  userHome,
  workspace,
  onOpenDoc,
  onAddPath,
  onStructure,
  onReveal,
  onPick,
  metaFor,
  listDir,
  planMove,
  mapOf,
  onOpenPath,
  created,
  notice,
  onDismissNotice,
}: ContextSidebarProps) {
  const [drilled, setDrilled] = useState<string | null>(null);
  const drilledEntry = drilled ? entries.find((e) => e.id === drilled) : undefined;
  const [renamePath, setRenamePath] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [editingWorkspace, setEditingWorkspace] = useState(false);

  // A drilled entry that was removed returns the view to the list.
  useEffect(() => {
    if (drilled && !drilledEntry) setDrilled(null);
  }, [drilled, drilledEntry]);

  // Something this viewer just made arrives in rename mode — in the view that
  // shows it: the list for a new top-level item, else the set that holds it.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => {
    if (!created) return;
    const all = entriesRef.current;
    const inSet = all.find(
      (e) => e.membership === "mirrored" && created.path.startsWith(`${e.root}/`),
    );
    if (all.some((e) => entryPath(e) === created.path)) setDrilled(null);
    else if (inSet) setDrilled(inSet.id);
    setRenamePath(created.path);
  }, [created]);
  const renameStarted = useCallback(() => setRenamePath(null), []);

  const moveTargetsFor = useCallback(
    (path: string) => moveTargets(entries, workspace, path, userHome),
    [entries, workspace, userHome],
  );

  /** E23: a drop is a COPY — each document's text is read here and written by the daemon. */
  const importFiles = useCallback(
    (dt: DataTransfer, into: string) => {
      const { files, folders } = droppedFiles(dt);
      const { docs, skipped } = splitDropped(files);
      for (const i of docs) {
        const f = files[i] as File;
        f.text().then(
          (text) => onStructure({ type: "import", name: f.name, text, into }),
          () => setLocalNotice(`Could not read ${f.name}.`),
        );
      }
      const said: string[] = [];
      if (skipped.length) said.push(`Not documents, so not copied: ${skipped.join(", ")}.`);
      if (folders.length)
        said.push(
          `Folders are not copied (${folders.join(", ")}) — add a folder by path below to link it.`,
        );
      setLocalNotice(said.length ? said.join(" ") : null);
    },
    [onStructure],
  );

  /**
   * E26: a move is asked about when it is a FOLDER (everything under it goes)
   * or when it LEAVES A GIT WORKING TREE — where the consequence reaches past
   * scriptorium. A plain document move inside the same repository, or outside
   * any, still happens at once: one file, and the log names it.
   *
   * ⛔ THE GIT HALF COVERS SINGLE DOCUMENTS BECAUSE IT HAD TO. This started as
   * "folders are confirmed, documents are not" and Cole's next drag was one
   * FILE — this repo's README — out of the repo and into his workspace, which
   * is the same surprise the folder rule was written for. A move's stakes are
   * set by where it lands, not by how many files it carries. Every move now
   * asks the daemon what it would do first (a local round trip), and the
   * dialog appears only for those two cases.
   */
  // E33: the map is an OVERLAY from a set's menu — Cole's ruling — so the
  // sidebar owns it, asks for the graph when it opens, and drops it on close.
  const [mapping, setMapping] = useState<{ entry: ContextEntry; graph: Mapping | null } | null>(
    null,
  );
  const showMap = useCallback(
    async (entry: ContextEntry) => {
      setMapping({ entry, graph: null });
      const result = await mapOf(entry.id);
      setMapping((current) =>
        current?.entry.id === entry.id ? { entry, graph: result } : current,
      );
      if (result.error) setLocalNotice(result.error);
    },
    [mapOf],
  );

  const { confirm, dialog } = useConfirm();
  const requestMove = useCallback(
    async (path: string, into: string) => {
      const { plan, error } = await planMove(path, into);
      if (!plan) {
        setLocalNotice(error ?? "that move could not be checked");
        return;
      }
      if (!plan.folder && !plan.leavesRepo) {
        onStructure({ type: "move", path, into });
        return;
      }
      const ok = await confirm({
        title: `Move “${plan.name}” into “${baseName(plan.into)}”?`,
        message: `${plan.docs === 1 ? "1 document" : `${plan.docs} documents`} moved on disk, from ${shortPath(plan.from, userHome, 2)} to ${shortPath(plan.into, userHome, 2)}.`,
        warning: plan.leavesRepo ? (
          <>
            This takes it <strong className="font-semibold">out of the git repository</strong>{" "}
            {plan.repo}. Git will see {plan.docs === 1 ? "the file" : "the files"} as deleted there
            until the move is committed.
          </>
        ) : undefined,
        confirmLabel: "Move",
        confirmClassName: "bg-rubric text-on-rubric hover:bg-rubric/90",
      });
      if (ok) onStructure({ type: "move", path, into });
    },
    [confirm, onStructure, planMove, userHome],
  );

  const shown = localNotice ?? notice ?? null;
  const dismiss = () => {
    if (localNotice) setLocalNotice(null);
    else onDismissNotice?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-edge py-1.5 pr-1.5 pl-3 text-xs text-ink-dim">
        <HomeIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
        <span className="shrink-0">Workspace</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={workspace}>
          {shortPath(workspace, userHome, 3)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setEditingWorkspace((v) => !v)}
          aria-label={editingWorkspace ? "Cancel changing the workspace" : "Change the workspace"}
          title={
            editingWorkspace
              ? "Cancel"
              : "Change the workspace — where dropped files are copied and new top-level documents are made"
          }
        >
          {editingWorkspace ? <XIcon /> : <SquarePenIcon />}
        </Button>
      </div>
      {editingWorkspace && (
        <AddPath
          key="workspace"
          listDir={listDir}
          placeholder="Set the workspace folder…"
          verb="sets"
          foldersOnly
          autoFocus
          initialValue={`${tildify(workspace, userHome)}/`}
          onAdd={(path) => {
            onStructure({ type: "workspace.set", path: expand(path, userHome) });
            setEditingWorkspace(false);
          }}
          onCancel={() => setEditingWorkspace(false)}
          className="border-t-0 border-b border-edge pt-0 pb-2"
          onPick={() => onPick("workspace")}
          openDown
        />
      )}
      {drilledEntry ? (
        <SetView
          entry={drilledEntry}
          activeRel={activeDoc?.entryId === drilledEntry.id ? activeDoc.rel : null}
          userHome={userHome}
          onBack={() => setDrilled(null)}
          onOpenDoc={(rel) => onOpenDoc(drilledEntry, rel)}
          onStructure={onStructure}
          onImportFiles={importFiles}
          moveTargetsFor={moveTargetsFor}
          renamePath={renamePath}
          onRenameStarted={renameStarted}
          onReveal={onReveal}
          onMove={requestMove}
          metaFor={metaFor}
          onShowMap={showMap}
        />
      ) : (
        <ListView
          entries={entries}
          activeDoc={activeDoc}
          userHome={userHome}
          workspace={workspace}
          onOpenDoc={onOpenDoc}
          onDrill={(e) => setDrilled(e.id)}
          onStructure={onStructure}
          onImportFiles={importFiles}
          moveTargetsFor={moveTargetsFor}
          renamePath={renamePath}
          onRenameStarted={renameStarted}
          onReveal={onReveal}
          onMove={requestMove}
          metaFor={metaFor}
          onShowMap={showMap}
        />
      )}
      {shown && (
        <div
          role="alert"
          className="mx-2 mb-1 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-ink"
        >
          <span className="min-w-0 flex-1 break-words">{shown}</span>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 text-ink-dim hover:text-ink"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
      <AddPath
        key="add"
        listDir={listDir}
        onAdd={onAddPath}
        onPick={(kind) => onPick(kind === "file" ? "context-file" : "context-folder")}
      />
      {dialog}
      <MapOverlay
        open={mapping !== null}
        onOpenChange={(next) => {
          if (!next) setMapping(null);
        }}
        label={mapping?.entry.label ?? ""}
        graph={mapping?.graph?.graph ?? null}
        onOpenDoc={onOpenPath}
      />
    </div>
  );
}

/** `~/x` → the home's `x`: the daemon takes absolute paths for structure ops. */
function expand(path: string, home: string | null): string {
  if (!home) return path;
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** A small icon button for a view's toolbar. */
function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onClick} aria-label={label} title={label}>
      {children}
    </Button>
  );
}

/** A name box for renaming a list row in place: Enter keeps, Escape or blur drops. */
function RenameBox({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      // biome-ignore lint/a11y/noAutofocus: the human asked to rename this row.
      autoFocus
      onFocus={(e) => {
        const dot = value.lastIndexOf(".");
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : value.length);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value.trim() && value !== initial ? value.trim() : null);
        else if (e.key === "Escape") onDone(null);
      }}
      onBlur={() => onDone(null)}
      aria-label={`Rename ${initial}`}
      spellCheck={false}
      className="h-6 min-w-0 flex-1 rounded-sm border border-ring/60 bg-bg px-1 text-sm text-ink outline-none"
    />
  );
}

function ListView({
  entries,
  activeDoc,
  userHome,
  workspace,
  onOpenDoc,
  onDrill,
  onStructure,
  onImportFiles,
  moveTargetsFor,
  renamePath,
  onRenameStarted,
  onReveal,
  onMove,
  metaFor,
  onShowMap,
}: {
  entries: readonly ContextEntry[];
  activeDoc: ContextSidebarProps["activeDoc"];
  userHome: string | null;
  workspace: string;
  onOpenDoc: ContextSidebarProps["onOpenDoc"];
  onDrill: (entry: ContextEntry) => void;
  onStructure: (op: StructureOp) => void;
  onImportFiles: (dt: DataTransfer, into: string) => void;
  moveTargetsFor: (path: string) => ReturnType<typeof moveTargets>;
  renamePath: string | null;
  onRenameStarted: () => void;
  onReveal: (path: string) => void;
  onMove: (path: string, into: string) => void;
  metaFor: (path: string) => DocSummary | undefined;
  onShowMap: (entry: ContextEntry) => void;
}) {
  const [menuFor, setMenuFor] = useState<ContextEntry | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The row (entry id) or the whole list ("") a drag is over. */
  const [dropOn, setDropOn] = useState<string | null>(null);

  // A new top-level document or set arrives in rename mode.
  useEffect(() => {
    if (!renamePath) return;
    if (entries.some((e) => entryPath(e) === renamePath)) {
      setRenaming(renamePath);
      onRenameStarted();
    }
  }, [renamePath, entries, onRenameStarted]);

  /** What a drop onto `into` does: files are copied in; a sidebar row is moved in. */
  const dropInto = (e: DragEvent, into: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropOn(null);
    if (carriesFiles(e.dataTransfer)) return onImportFiles(e.dataTransfer, into);
    const path = e.dataTransfer.getData(ROW_MIME);
    if (path && path !== into && dirOf(path) !== into) onMove(path, into);
  };
  const acceptsDrag = (e: DragEvent) =>
    carriesFiles(e.dataTransfer) || Array.from(e.dataTransfer.types).includes(ROW_MIME);

  const menu = (
    <ContextMenuContent>
      {menuFor && singleDoc(menuFor) ? (
        <>
          <ContextMenuItem onClick={() => onOpenDoc(menuFor, singleDoc(menuFor)?.rel as string)}>
            <FileTextIcon />
            Open
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setRenaming(entryPath(menuFor))}>
            <PencilIcon />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onStructure({ type: "set.make", path: entryPath(menuFor) })}
          >
            <FolderTreeIcon />
            Turn into a set
          </ContextMenuItem>
          <MoveToMenu
            targets={moveTargetsFor(entryPath(menuFor))}
            onMove={(into) => onMove(entryPath(menuFor), into)}
          />
        </>
      ) : menuFor ? (
        <>
          <ContextMenuItem onClick={() => onDrill(menuFor)}>
            <FolderTreeIcon />
            Open set
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onStructure({ type: "doc.create", dir: menuFor.root })}>
            <FilePlusIcon />
            New document in set
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setRenaming(menuFor.root)}>
            <PencilIcon />
            Rename
          </ContextMenuItem>
          <MoveToMenu
            targets={moveTargetsFor(menuFor.root)}
            onMove={(into) => onMove(menuFor.root, into)}
          />
          <ContextMenuItem onClick={() => onShowMap(menuFor)}>
            <NetworkIcon />
            Show the map of this set
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onStructure({ type: "workspace.set", path: menuFor.root })}
          >
            <HomeIcon />
            Use as workspace
          </ContextMenuItem>
          {(menuFor.hidden?.length ?? 0) > 0 && (
            <ContextMenuItem onClick={() => onStructure({ type: "unhide", entry: menuFor.id })}>
              <EyeIcon />
              Show {menuFor.hidden?.length} hidden
            </ContextMenuItem>
          )}
        </>
      ) : (
        <>
          <ContextMenuItem onClick={() => onStructure({ type: "doc.create", dir: workspace })}>
            <FilePlusIcon />
            New document
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onStructure({ type: "folder.create", dir: workspace })}>
            <FolderPlusIcon />
            New set
          </ContextMenuItem>
        </>
      )}
      <RevealItem onReveal={() => onReveal(menuFor ? entryPath(menuFor) : workspace)} />
      {menuFor && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => onStructure({ type: "hide", path: entryPath(menuFor) })}
          >
            <XIcon />
            Remove from Scriptorium
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) setMenuFor(null);
      }}
    >
      <ContextMenuTrigger
        render={
          // biome-ignore lint/a11y/noStaticElementInteractions: the list's drop zone (files from outside land in the workspace); the rows and toolbar are the keyboard path.
          <div
            onDragOver={(e) => {
              if (!acceptsDrag(e)) return;
              e.preventDefault();
              setDropOn("");
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
            }}
            onDrop={(e) => dropInto(e, workspace)}
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              dropOn === "" && "bg-rubric/8 ring-1 ring-rubric/40 ring-inset",
            )}
          />
        }
      >
        <div className="flex shrink-0 items-center gap-0.5 px-1.5 pt-1">
          <span className="flex-1 truncate px-1 text-[11px] text-ink-faint">
            Drop files here to copy them in
          </span>
          <ToolButton
            label="New document in the workspace"
            onClick={() => onStructure({ type: "doc.create", dir: workspace })}
          >
            <FilePlusIcon />
          </ToolButton>
          <ToolButton
            label="New set (a folder in the workspace)"
            onClick={() => onStructure({ type: "folder.create", dir: workspace })}
          >
            <FolderPlusIcon />
          </ToolButton>
        </div>
        {entries.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderTreeIcon />
              </EmptyMedia>
              <EmptyTitle>No context yet</EmptyTitle>
              <EmptyDescription>
                Add a markdown file or a folder by path below, drop files here to copy them into the
                workspace — or ask the agent to add one.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5"
            aria-label="Context"
          >
            {entries.map((entry) => {
              const only = singleDoc(entry);
              const holdsActive = activeDoc?.entryId === entry.id;
              const isActiveDoc = only !== null && holdsActive && activeDoc?.rel === only.rel;
              const count = only ? 1 : docsIn(entry.nodes).length;
              const full = entryPath(entry);
              // A single document's row names its FOLDER (the file name is the title);
              // a set's row names its root. Cut from the front; the tooltip is whole.
              const where = shortPath(entry.root, userHome);
              const name = only ? (only.rel.split("/").pop() as string) : entry.label;
              const mark = only ? statusMark(metaFor(full)) : null;
              const icon = only ? (
                <FileTextIcon
                  aria-hidden
                  className={cn("size-4 shrink-0", isActiveDoc ? "text-rubric" : "text-ink-faint")}
                />
              ) : (
                <FolderTreeIcon
                  aria-hidden
                  className={cn("size-4 shrink-0", holdsActive ? "text-rubric" : "text-ink-faint")}
                />
              );
              if (renaming === full) {
                return (
                  <li
                    key={entry.id}
                    className="flex items-center gap-2 rounded-md bg-surface-raised px-2 py-1.5"
                  >
                    {icon}
                    <RenameBox
                      initial={name}
                      onDone={(next) => {
                        setRenaming(null);
                        if (next) onStructure({ type: "rename", path: full, name: next });
                      }}
                    />
                  </li>
                );
              }
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(ROW_MIME, full);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    // Only a SET takes a drop; a document row passes it to the list.
                    onDragOver={(e) => {
                      if (only || !acceptsDrag(e)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDropOn(entry.id);
                    }}
                    onDrop={only ? undefined : (e) => dropInto(e, entry.root)}
                    onClick={() => (only ? onOpenDoc(entry, only.rel) : onDrill(entry))}
                    onContextMenu={() => setMenuFor(entry)}
                    onKeyDown={(e) => {
                      openMenuOnShiftF10(e);
                      if (e.key === "F2") {
                        e.preventDefault();
                        setRenaming(full);
                      }
                    }}
                    title={tildify(full, userHome)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none",
                      "hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60",
                      (isActiveDoc || (holdsActive && !only)) && "bg-rubric/12",
                      dropOn === entry.id && "bg-rubric/15 ring-1 ring-rubric/50 ring-inset",
                    )}
                  >
                    {icon}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cn(
                          "truncate text-sm",
                          isActiveDoc ? "font-medium text-ink" : "text-ink",
                        )}
                      >
                        {name}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-ink-dim">
                        {mark && (
                          <span
                            title={mark.title}
                            data-tone={mark.tone}
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              "data-[tone=draft]:bg-attention data-[tone=stale]:bg-attention/70",
                              "data-[tone=deprecated]:bg-danger data-[tone=unreadable]:bg-ink-faint",
                            )}
                          />
                        )}
                        {entry.truncated && <TruncatedBadge />}
                        <span className="truncate">
                          {only
                            ? where
                            : `${count} ${count === 1 ? "document" : "documents"} · ${where}`}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}

function SetView({
  entry,
  activeRel,
  userHome,
  onBack,
  onOpenDoc,
  onStructure,
  onImportFiles,
  moveTargetsFor,
  renamePath,
  onRenameStarted,
  onReveal,
  onMove,
  metaFor,
  onShowMap,
}: {
  entry: ContextEntry;
  activeRel: string | null;
  userHome: string | null;
  onBack: () => void;
  onOpenDoc: (rel: string) => void;
  onStructure: (op: StructureOp) => void;
  onImportFiles: (dt: DataTransfer, into: string) => void;
  moveTargetsFor: (path: string) => ReturnType<typeof moveTargets>;
  renamePath: string | null;
  onRenameStarted: () => void;
  onReveal: (path: string) => void;
  onMove: (path: string, into: string) => void;
  metaFor: (path: string) => DocSummary | undefined;
  onShowMap: (entry: ContextEntry) => void;
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
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-ink">{entry.label}</span>
          <span
            className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px] text-ink-dim"
            title={entry.root}
          >
            {entry.truncated && <TruncatedBadge />}
            {shortPath(entry.root, userHome)}
          </span>
        </div>
        <ToolButton
          label="New document in this set"
          onClick={() => onStructure({ type: "doc.create", dir: entry.root })}
        >
          <FilePlusIcon />
        </ToolButton>
        <ToolButton
          label="New folder in this set"
          onClick={() => onStructure({ type: "folder.create", dir: entry.root })}
        >
          <FolderPlusIcon />
        </ToolButton>
        <ToolButton label="Show the map of this set" onClick={() => onShowMap(entry)}>
          <NetworkIcon />
        </ToolButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-1">
        <EntryTree
          key={entry.id}
          entry={entry}
          activeRel={activeRel}
          onOpenDoc={onOpenDoc}
          onStructure={onStructure}
          onImportFiles={onImportFiles}
          moveTargetsFor={moveTargetsFor}
          renamePath={renamePath}
          onRenameStarted={onRenameStarted}
          onMenuKey={openMenuOnShiftF10}
          onReveal={onReveal}
          onMove={onMove}
          metaFor={metaFor}
        />
      </div>
    </div>
  );
}
