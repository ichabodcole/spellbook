// THE CONTEXT SIDEBAR: props only. Entries, the open document, callbacks, and a
// `listDir` for the path box. No WebSocket, no fetch, no daemon beyond the wire's
// shapes, so it renders from a fixture as easily as from a daemon.
//
// Two views of ONE entry type:
//   - the LIST: every context entry. One holding a single document or image
//     shows as that file and opens it on click; any other entry shows as a set
//     and drills in on click. A file dropped on the list itself (not on a set)
//     is copied into the workspace folder and becomes such an entry. An app
//     with no workspace supplies `askLocation` instead: the list then offers
//     New document and New folder, and they and such a drop ask where to go.
//   - a SET, drilled into: its tree (EntryTree), with a way back to the list.
//
// Moving is one act wherever it starts: "Move to…" on any row opens one dialog
// (the workspace, then every set and folder, searchable), a row dragged onto a
// set or folder moves into it, and a row dragged onto the list itself, or onto
// a drilled-in set's way back, moves to the workspace folder.
//
// Organizing is menus and dragging here and CLI verbs for the agent; both send
// the same structure ops and the daemon does the real change on disk. "Remove
// from context" only stops showing something. Delete, in a row's menu, is the
// human's alone: it asks first (`onDelete`), and the daemon moves the path to the
// operating system's Trash, never unlinking it.
import {
  ArrowLeftIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  ImageIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { bundleOf, bundleTypeOf, bundleTypes, isBundleMain } from "../lib/bundles.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { useConfirm } from "../ui/ConfirmDialog.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty.tsx";
import type { ContextEntry, StructureOp, TrashPreview } from "../workspace/protocol";
import { AddPath } from "./AddPath.tsx";
import type { AskLocation } from "./AskLocation.tsx";
import type { AlreadyThere, Daemon, Listing } from "./daemonClient.ts";
import {
  AddRefItem,
  BundleIcon,
  DescribedMark,
  DescriptionItem,
  DocIcon,
  DuplicateItem,
  EntryTree,
  ImagePeek,
  NewBundleItems,
} from "./EntryTree.tsx";
import { MoveToDialog } from "./MoveToDialog.tsx";
import type { MenuAction, MenuTarget } from "./menuActions.ts";
import {
  AppMenuItems,
  carriesFiles,
  DeleteItem,
  dropNotice,
  droppedFiles,
  MoveToItem,
  RevealItem,
} from "./menus.tsx";
import {
  baseName,
  countEntry,
  countsInWords,
  dirOf,
  docPathOf,
  entryPath,
  foldListedSidecars,
  joinPath,
  moveTargets,
  nodeLabel,
  rowHolds,
  rowsShown,
  shortPath,
  singleFile,
  splitDropped,
  tildify,
} from "./model.ts";
import { askBeforeMove, type BeforeMove, type UncheckedMoveNote } from "./preMove.ts";
import { carriesRows, type DraggedRow, readRowDrag, rowKindOf, writeRowDrag } from "./rowDrag.ts";
import { TRASH_CONFIRM_CLASS, trashDialog } from "./trashDialog.ts";

/** How long a row dragged over a set's way back waits before the list opens under it. */
const SPRING_MS = 600;

/** Said up front, not ellipsed away at the end of a subtitle. */
function TruncatedBadge() {
  return (
    <span
      className="shrink-0 rounded-sm bg-attention/15 px-1 font-sans text-[10px] font-medium text-attention"
      title="This folder has more files than the sidebar lists: the scan stopped at its cap."
    >
      partial
    </span>
  );
}

export type ContextSidebarProps = {
  entries: readonly ContextEntry[];
  /**
   * The open document, located by its entry and rel, or null. `raw`: a
   * bundle's main file opened from its own row inside the expanded bundle,
   * which is the row marked open.
   */
  activeDoc: { entryId: string; rel: string; raw?: boolean } | null;
  /** For `~` abbreviation of paths; null shows them absolute. */
  userHome: string | null;
  onOpenDoc: (entry: ContextEntry, rel: string) => void;
  onAddPath: (path: string) => void;
  /** Every organizing change: the daemon does it on disk. */
  onStructure: (op: StructureOp) => void;
  /** Stop showing an entry. Deletes nothing. */
  onRemoveEntry: (id: string) => void;
  /** Show a path in the OS file manager. */
  onReveal: (path: string) => void;
  /** Open the OS's own picker and add what comes back. */
  onPick: (want: "context-file" | "context-folder") => void;
  /**
   * The workspace folder: where dropped files and new top-level documents land.
   * Absent, the sidebar shows no workspace row.
   */
  workspace?: string | null;
  /** Point the workspace at another folder (a path as typed: absolute or `~`). */
  onSetWorkspace?: (path: string) => void;
  /**
   * For an app with no workspace: ask the human where something goes (see
   * `./AskLocation.tsx`, whose `useAskLocation` answers it). Given, and with no
   * `workspace`, the list offers New document and New folder, which ask, and a
   * file dropped on the list itself asks before it is copied; every op then
   * names the place chosen, and backing out sends nothing. Absent, nothing asks.
   */
  askLocation?: AskLocation;
  listDir: (path: string) => Promise<Listing>;
  /** The per-document badge slot: what an app shows at a row's trailing edge, by absolute path. */
  badgeFor?: (path: string) => ReactNode;
  /**
   * A mark at the trailing edge of any tree row, open or not: a document, an
   * image or a bundle, by the row's own absolute path (a bundle's folder, not
   * its main file). After the row's badge. Held on the sidebar, so an app shell
   * that composes the sidebar passes it through, and an app with no shell can
   * mark rows too.
   */
  rowMarker?: (path: string) => ReactNode;
  /** The folder badge slot: what an app shows on a set's row and on each folder inside it, by absolute path. */
  folderBadgeFor?: (path: string) => ReactNode;
  /** The app's own menu actions for a target. */
  appActionsFor?: (target: MenuTarget) => MenuAction[];
  /** A new document or folder this viewer just made: shown in rename mode. `seq` makes a repeat new. */
  created?: { path: string; seq: number } | null;
  /**
   * A move this viewer made that the daemon carried out: where the row is now.
   * Only a success arrives here, so a refused move never moves the focus.
   */
  moved?: { path: string; seq: number } | null;
  /** A refusal to show the human (a path that could not be added, and so on), or null. */
  notice?: string | null;
  onDismissNotice?: () => void;
  /**
   * What moving a path to the Trash would take (the daemon's `trash.preview`):
   * asked before the dialog, so it can name what goes. Rejects with the refusal.
   * With `onTrash`, a row's menu offers Delete; without both, it does not.
   */
  trashPreview?: (path: string) => Promise<TrashPreview>;
  /** Move a path to the Trash, once the human has confirmed. */
  onTrash?: (path: string) => void;
  /**
   * Send a dropped image to the daemon to be written as a plain file (the
   * daemon client's `importImage`). Absent, a dropped image is refused like any
   * file the workspace does not show.
   */
  importImage?: Daemon["importImage"];
  /**
   * What is already at the path a dropped file would be copied to (the
   * daemon's `fs.same`, `fileAlreadyAt` in the daemon client). Given, a copy
   * into a chosen set or folder asks first when the name is taken: the same
   * file is offered instead of a second copy, and a different one is said
   * before anything is written. Absent, a copy is written as before.
   */
  fileAt?: (dir: string, file: File) => Promise<AlreadyThere>;
  /** Where an image's small thumbnail is served, for its row's hover preview. Absent, no preview. */
  thumbFor?: (path: string) => string;
  /**
   * "Ask the agent to describe" an image that has no description yet: post a
   * chat message naming it. Absent, an image's menu does not offer it.
   */
  onAskDescribe?: (imagePath: string) => void;
  /**
   * The file tree's selection, by absolute row path, held by the caller so it
   * outlives a set drilled out of. The documents and images among them, other
   * than the message's subject, are the next message's refs (read at send,
   * never cleared by it).
   */
  selected?: readonly string[];
  onSelect?: (rows: readonly string[]) => void;
  /** "Add as reference" on a document or image row: what to read, and its name. Absent, not offered. */
  onAddRef?: (path: string, name: string) => void;
  /**
   * The pre-move slot (`./preMove.ts`): asked before every move the sidebar
   * makes, it answers with a confirm dialog's words (the move waits for the
   * human), a refusal, or nothing (the move goes at once). Absent, every move
   * is sent at once, as without it.
   */
  beforeMove?: BeforeMove;
  /** How long a move waits for `beforeMove` before asking the human without it. Default 5 s. */
  beforeMoveTimeoutMs?: number;
  /**
   * When `beforeMove` fails or does not answer in time, the human is still
   * asked ("Move anyway"); this names what went unchecked, as the dialog's
   * warning. Absent, the dialog says only that the move was not checked.
   */
  uncheckedMoveNote?: UncheckedMoveNote;
};

const NO_ACTIONS: MenuAction[] = [];
const noActions = () => NO_ACTIONS;
const noBadge = () => null;

/**
 * A row's badge with the app's row mark after it. The badge is asked by the
 * row's document path (a bundle's main file); the mark by the row's own path,
 * so a bundle's by its folder. Exported for an app shell that composes the
 * sidebar and builds its own `badgeFor`.
 */
export function withRowMarker(
  badgeFor: (path: string) => ReactNode,
  rowMarker: (path: string) => ReactNode,
): (path: string) => ReactNode {
  return (path) => {
    const badge = badgeFor(path);
    const bundle = isBundleMain(path) ? bundleOf(path) : null;
    const mark = rowMarker(bundle ? bundle.root : path);
    if (!mark) return badge;
    if (!badge) return mark;
    return (
      <span className="flex items-center gap-1">
        {badge}
        {mark}
      </span>
    );
  };
}

/** macOS has no native key for a context menu, so Shift+F10 is synthesised. */
export function openMenuOnShiftF10(e: KeyboardEvent<HTMLElement>) {
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
  onStructure,
  onRemoveEntry,
  onReveal,
  onPick,
  workspace,
  onSetWorkspace,
  askLocation,
  listDir,
  badgeFor: appBadgeFor = noBadge,
  rowMarker,
  folderBadgeFor = noBadge,
  appActionsFor = noActions,
  created,
  moved,
  notice,
  onDismissNotice,
  trashPreview,
  onTrash,
  importImage,
  fileAt,
  thumbFor,
  onAskDescribe,
  selected,
  onSelect,
  onAddRef,
  beforeMove,
  beforeMoveTimeoutMs,
  uncheckedMoveNote,
}: ContextSidebarProps) {
  const badgeFor = useMemo(
    () => (rowMarker ? withRowMarker(appBadgeFor, rowMarker) : appBadgeFor),
    [appBadgeFor, rowMarker],
  );
  const [drilled, setDrilled] = useState<string | null>(null);
  const drilledEntry = drilled ? entries.find((e) => e.id === drilled) : undefined;
  const [renamePath, setRenamePath] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  // A drilled entry that was removed returns the view to the list.
  useEffect(() => {
    if (drilled && !drilledEntry) setDrilled(null);
  }, [drilled, drilledEntry]);

  // Something this viewer just made arrives in rename mode, in the view that
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

  // The open document changed (a followed link, a search result, the agent)
  // while the list is showing: drill into the set that holds it, so its tree can
  // reveal the row. Only from the list, and only on a change: a set the human
  // drilled into is never switched away from, and a single document already
  // shows in the list.
  const lastActive = useRef(activeDoc ? `${activeDoc.entryId}/${activeDoc.rel}` : null);
  useEffect(() => {
    const key = activeDoc ? `${activeDoc.entryId}/${activeDoc.rel}` : null;
    if (key === lastActive.current) return;
    lastActive.current = key;
    if (!activeDoc || drilled !== null) return;
    const holder = entriesRef.current.find((e) => e.id === activeDoc.entryId);
    if (holder?.membership === "mirrored") setDrilled(holder.id);
  }, [activeDoc, drilled]);

  // "Move to…": the row being moved, while its dialog is open.
  const [moving, setMoving] = useState<string | null>(null);
  const onAskMove = useCallback((path: string) => setMoving(path), []);
  // Where a "Move to…" put the row: once it shows there, the view goes to it
  // (the list, or the set that holds it) and the row takes the focus.
  // The target is set only from the daemon's success (`moved`): a refused move
  // (a name already there) must not open the destination and focus the file
  // that was already there under that name.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const focused = useCallback(() => setFocusPath(null), []);
  const expectMove = useRef<string | null>(null);
  useEffect(() => {
    if (!moved || moved.path !== expectMove.current) return;
    expectMove.current = null;
    setFocusPath(moved.path);
  }, [moved]);
  useEffect(() => {
    if (!focusPath) return;
    if (entries.some((e) => entryPath(e) === focusPath)) return setDrilled(null);
    const holder = entries.find(
      (e) => e.membership === "mirrored" && focusPath.startsWith(`${e.root}/`),
    );
    if (holder) setDrilled(holder.id);
  }, [focusPath, entries]);
  // Delete, an image's taken name and the pre-move slot ask through one dialog.
  const { confirm, dialog } = useConfirm();
  // Moves with a pre-move slot are asked one at a time, in the order made, so
  // a drag of several rows asks about each in turn (a second ask while one is
  // open would answer the first with Cancel). Without a slot a move is sent at
  // once, as it always was, and true says so.
  const moves = useRef<Promise<unknown>>(Promise.resolve());
  const move = useCallback(
    (path: string, into: string): true | Promise<boolean> => {
      if (!beforeMove) {
        onStructure({ op: "move", path, into });
        return true;
      }
      const asked = moves.current.then(async () => {
        const v = await askBeforeMove(
          { path, into },
          beforeMove,
          confirm,
          beforeMoveTimeoutMs,
          uncheckedMoveNote,
        );
        if (v.go) onStructure({ op: "move", path, into });
        else if (v.notice) setLocalNotice(v.notice);
        return v.go;
      });
      moves.current = asked.catch(() => {});
      return asked;
    },
    [onStructure, beforeMove, beforeMoveTimeoutMs, uncheckedMoveNote, confirm],
  );
  // A drop on the list itself, or on a set's way back: each row from INSIDE a
  // set to the workspace folder, unless it is there already. A list row (a whole
  // set, or a document listed on its own) is never moved this way: a short slip
  // of the mouse would carry a set's folder, or a file from anywhere on disk,
  // into the workspace. Those move only by an explicit "Move to…".
  const moveToWorkspace = useCallback(
    (rows: readonly DraggedRow[]) => {
      if (!workspace) return;
      for (const r of rows) {
        const from = entriesRef.current.find((e) => e.id === r.entry);
        if (r.kind === "set" || from?.membership !== "mirrored" || r.path === from.root) continue;
        if (r.path !== workspace && dirOf(r.path) !== workspace) move(r.path, workspace);
      }
    },
    [workspace, move],
  );

  /**
   * A drop is a COPY: each document's text is read here and written by the
   * daemon under a free name, so a drop never replaces a file: into the set or
   * folder it was dropped on, else the workspace. A dropped folder is refused,
   * with the way that works.
   */

  /**
   * One dropped image: its bytes sent as they are (never read as text), written
   * by the daemon as a plain file where it was dropped. A name already there is
   * put to the human: replace it, which sends the old file to the Trash, or keep
   * both, which gives the new one a free name. Backing out keeps both, so
   * nothing is lost by a stray Escape.
   */
  const importOneImage = useCallback(
    async (f: File, into?: string): Promise<string | null> => {
      if (!importImage) return `${f.name}: this app does not take images.`;
      const dir = into ? { dir: into } : {};
      let r = await importImage(f, { ...dir, onTaken: "ask" });
      if (!r.ok && r.taken) {
        // The daemon names the file that would be written, which the import
        // settings may have changed (`photo.jpg` written as `photo.webp`).
        const taken = r.takenName ?? f.name;
        const as = taken === f.name ? "" : ` would be written as ${taken}, and ${taken}`;
        const replace = await confirm({
          title: `Replace ${taken}?`,
          message: `${f.name}${as} is already in this folder. Replace it, and the old file goes to the Trash; or keep both, and the new one gets a new name.`,
          confirmLabel: "Replace",
          cancelLabel: "Keep both",
        });
        r = await importImage(f, { ...dir, onTaken: replace ? "replace" : "keep-both" });
      }
      if (r.ok) return r.kept && r.note ? `${f.name} was ${r.note}.` : null;
      return `${f.name} was not brought in: ${r.error}`;
    },
    [importImage, confirm],
  );

  /**
   * A file where it lives, into the context: one a set already shows is
   * selected rather than listed a second time; any other is listed on its own.
   */
  const addWhereItLives = useCallback(
    (path: string) => {
      if (rowsShown(entriesRef.current, [path]).length > 0) onSelect?.([path]);
      else onAddPath(path);
    },
    [onAddPath, onSelect],
  );

  /**
   * Before a dropped file is copied into `into`: is its name taken there? The
   * same bytes are offered instead of a second copy (`added`: nothing is
   * written); a different document of that name is said first, and copied
   * under a free name only if the human says so. A different image goes on to
   * the import's own ask (replace, or keep both). With no `fileAt`, or when it
   * cannot say, the copy goes ahead as before.
   */
  const beforeCopy = useCallback(
    async (f: File, into: string, image: boolean): Promise<"copy" | "skip"> => {
      if (!fileAt) return "copy";
      const there = joinPath(into, f.name);
      let at: AlreadyThere;
      try {
        at = await fileAt(into, f);
      } catch {
        return "copy";
      }
      if (!at.exists) return "copy";
      const place = tildify(into, userHome);
      if (at.same) {
        const use = await confirm({
          title: `${f.name} is already in ${place}`,
          message: `The file there is this same file. Add that one instead of copying it again?`,
          confirmLabel: "Add the one there",
          cancelLabel: "Don't copy",
        });
        if (use) addWhereItLives(there);
        return "skip";
      }
      if (image) return "copy";
      const copy = await confirm({
        title: `A different ${f.name} is in ${place}`,
        message: `A file of that name is already there, and it is not this one. Copy this one in under a new name?`,
        confirmLabel: "Copy under a new name",
        cancelLabel: "Don't copy",
      });
      return copy ? "copy" : "skip";
    },
    [fileAt, userHome, confirm, addWhereItLives],
  );

  const importDropped = useCallback(
    ({ files, folders }: { files: File[]; folders: string[] }, into?: string) => {
      const { docs, images, svg, skipped } = splitDropped(files);
      setLocalNotice(dropNotice(skipped, folders, svg));
      // One at a time, so two taken names ask one after the other.
      void (async () => {
        for (const i of docs) {
          const f = files[i] as File;
          if (into && (await beforeCopy(f, into, false)) === "skip") continue;
          f.text().then(
            (text) =>
              onStructure({ op: "import", name: f.name, text, ...(into ? { dir: into } : {}) }),
            () => setLocalNotice(`Could not read ${f.name}.`),
          );
        }
        const refused: string[] = [];
        for (const i of images) {
          const f = files[i] as File;
          if (into && (await beforeCopy(f, into, true)) === "skip") continue;
          const why = await importOneImage(f, into);
          if (why) refused.push(why);
        }
        if (refused.length) setLocalNotice(refused.join(" "));
      })();
    },
    [onStructure, importOneImage, beforeCopy],
  );
  const importFiles = useCallback(
    (dt: DataTransfer, into?: string) => importDropped(droppedFiles(dt), into),
    [importDropped],
  );

  // With no workspace, what has no place under it asks for one (`askLocation`).
  const asks = !workspace && askLocation ? askLocation : undefined;
  const askAndCreate = useCallback(
    async (what: "document" | "folder" | "bundle", extension?: string, label?: string) => {
      if (!asks) return;
      const name = what === "bundle" ? (label ?? "bundle") : what;
      const dir = await asks({ what, title: `Where should the new ${name} go?` });
      if (!dir) return;
      if (what === "document") onStructure({ op: "doc.create", dir });
      else if (what === "folder") onStructure({ op: "folder.create", dir });
      else onStructure({ op: "bundle.create", dir, ...(extension ? { extension } : {}) });
    },
    [asks, onStructure],
  );
  // A drop on the list itself. The files are read off the drop now: the
  // browser empties a drop's data once its event is over.
  const importOnList = useCallback(
    (dt: DataTransfer, into?: string) => {
      if (into || !asks) return importFiles(dt, into);
      const dropped = droppedFiles(dt);
      const { docs, images } = splitDropped(dropped.files);
      const n = docs.length + images.length;
      // Nothing that would be copied: only the notice, with no ask.
      if (n === 0) return importDropped(dropped);
      const one = dropped.files[(docs[0] ?? images[0]) as number] as File;
      const title =
        n === 1
          ? `Where should ${one.name} be copied?`
          : `Where should these ${n} files be copied?`;
      // The other way in: the original file, where it lives (the dialog
      // offers it where the OS has a picker).
      const original = { files: n, add: (paths: string[]) => paths.forEach(addWhereItLives) };
      void asks({ what: "files", title, original }).then((dir) => {
        if (dir) importDropped(dropped, dir);
      });
    },
    [asks, importFiles, importDropped, addWhereItLives],
  );
  // Delete: ask the daemon what would go, name it in a dialog, and only then
  // move it to the Trash. A refusal (a whole set, a path that is gone) is the
  // notice, so the human reads why.
  const askDelete = useCallback(
    async (path: string) => {
      if (!trashPreview || !onTrash) return;
      let pre: TrashPreview;
      try {
        pre = await trashPreview(path);
      } catch (e) {
        setLocalNotice(e instanceof Error ? e.message : String(e));
        return;
      }
      const d = trashDialog(pre);
      const ok = await confirm({
        title: d.title,
        message: d.message,
        warning: d.warning,
        confirmLabel: d.confirmLabel,
        confirmClassName: TRASH_CONFIRM_CLASS,
      });
      if (ok) onTrash(pre.path);
    },
    [trashPreview, onTrash, confirm],
  );
  const onDelete = trashPreview && onTrash ? askDelete : undefined;

  const shown = localNotice ?? notice ?? null;
  const dismiss = () => {
    if (localNotice) setLocalNotice(null);
    else onDismissNotice?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {drilledEntry ? (
        <SetView
          entry={drilledEntry}
          activeRel={activeDoc?.entryId === drilledEntry.id ? activeDoc.rel : null}
          activeRaw={activeDoc?.raw === true}
          userHome={userHome}
          onBack={() => setDrilled(null)}
          onOpenDoc={(rel) => onOpenDoc(drilledEntry, rel)}
          onStructure={onStructure}
          onImportFiles={importFiles}
          onAskMove={onAskMove}
          focusPath={focusPath}
          onFocused={focused}
          renamePath={renamePath}
          onRenameStarted={renameStarted}
          onReveal={onReveal}
          onMove={move}
          onMoveToWorkspace={workspace ? moveToWorkspace : undefined}
          badgeFor={badgeFor}
          folderBadgeFor={folderBadgeFor}
          appActionsFor={appActionsFor}
          onDelete={onDelete}
          thumbFor={thumbFor}
          onAskDescribe={onAskDescribe}
          selected={selected}
          onSelect={onSelect}
          onAddRef={onAddRef}
        />
      ) : (
        <ListView
          entries={entries}
          activeDoc={activeDoc}
          userHome={userHome}
          onOpenDoc={onOpenDoc}
          onDrill={(e) => setDrilled(e.id)}
          onStructure={onStructure}
          onRemoveEntry={onRemoveEntry}
          onImportFiles={importOnList}
          onAskCreate={asks ? askAndCreate : undefined}
          onAskMove={onAskMove}
          focusPath={focusPath}
          onFocused={focused}
          renamePath={renamePath}
          onRenameStarted={renameStarted}
          onReveal={onReveal}
          onPick={onPick}
          workspace={workspace ?? null}
          onSetWorkspace={onSetWorkspace}
          listDir={listDir}
          onMove={move}
          onMoveToWorkspace={moveToWorkspace}
          badgeFor={badgeFor}
          folderBadgeFor={folderBadgeFor}
          appActionsFor={appActionsFor}
          onDelete={onDelete}
          thumbFor={thumbFor}
          onAskDescribe={onAskDescribe}
          onAddRef={onAddRef}
        />
      )}
      {dialog}
      {moving && (
        <MoveToDialog
          path={moving}
          targets={moveTargets(entries, moving, workspace ?? null)}
          userHome={userHome}
          onMove={(into) => {
            const to = joinPath(into, baseName(moving));
            expectMove.current = to;
            // A move the human cancelled at the slot's dialog expects nothing.
            void Promise.resolve(move(moving, into)).then((went) => {
              if (!went && expectMove.current === to) expectMove.current = null;
            });
          }}
          onClose={() => setMoving(null)}
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
    </div>
  );
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

/**
 * A header's "New …" button for each bundle type the app registered, after
 * New document and New folder: "New canvas" makes an empty one in `dir`, and
 * its name arrives in rename mode as a new document's does.
 */
function NewBundleButtons({
  dir,
  where,
  onStructure,
}: {
  dir: string;
  /** Said after the label, as the other buttons say it: " in this set". */
  where?: string;
  onStructure: (op: StructureOp) => void;
}) {
  return bundleTypes().map((t) => (
    <ToolButton
      key={t.extension}
      label={`New ${t.label}${where ?? ""}`}
      onClick={() => onStructure({ op: "bundle.create", dir, extension: t.extension })}
    >
      <BundleIcon type={t} />
    </ToolButton>
  ));
}

/**
 * The top of the list: the workspace folder, shortened (the whole path is the
 * tooltip), with a pencil that turns the row into a path field with completion.
 * Enter sets it; Escape or leaving the box keeps what it was. Beside it, the
 * buttons that make a document or a set IN the workspace, the way a drilled-in
 * set's header makes a document or a folder in that set. (A folder made here
 * gets its own entry, so the button says "New set"; inside a set it says
 * "New folder".)
 */
function WorkspaceRow({
  workspace,
  userHome,
  listDir,
  onSetWorkspace,
  onStructure,
}: {
  workspace: string;
  userHome: string | null;
  listDir: ContextSidebarProps["listDir"];
  onSetWorkspace: ContextSidebarProps["onSetWorkspace"];
  onStructure: (op: StructureOp) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="shrink-0 border-b border-edge px-1.5 py-1">
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 flex-col px-1" title={workspace}>
          <span className="text-[11px] text-ink-faint">Workspace</span>
          <span className="truncate font-mono text-[11px] text-ink-dim">
            {shortPath(workspace, userHome)}
          </span>
        </div>
        {onSetWorkspace && (
          <ToolButton label="Change the workspace folder" onClick={() => setEditing((v) => !v)}>
            <PencilIcon />
          </ToolButton>
        )}
        <ToolButton
          label="New document"
          onClick={() => onStructure({ op: "doc.create", dir: workspace })}
        >
          <FilePlusIcon />
        </ToolButton>
        <ToolButton
          label="New set"
          onClick={() => onStructure({ op: "folder.create", dir: workspace })}
        >
          <FolderPlusIcon />
        </ToolButton>
        <NewBundleButtons dir={workspace} onStructure={onStructure} />
      </div>
      {editing && onSetWorkspace && (
        <AddPath
          listDir={listDir}
          foldersOnly
          autoFocus
          openDown
          verb="sets"
          initialValue={tildify(workspace, userHome)}
          placeholder="Workspace folder…"
          onAdd={(path) => {
            onSetWorkspace(path);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          className="border-t-0 p-0 pt-1"
        />
      )}
    </div>
  );
}

/** A name box for renaming a list row in place: Enter keeps, Escape or leaving the box drops. */
function RenameBox({
  initial,
  whole = false,
  onDone,
}: {
  initial: string;
  /** Select the whole name, not its stem: a bundle's name is its title, with no extension. */
  whole?: boolean;
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
        const dot = whole ? -1 : value.lastIndexOf(".");
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
  onOpenDoc,
  onDrill,
  onStructure,
  onRemoveEntry,
  onImportFiles,
  onAskMove,
  renamePath,
  onRenameStarted,
  onReveal,
  onPick,
  workspace,
  onSetWorkspace,
  listDir,
  onMove,
  onMoveToWorkspace,
  badgeFor,
  folderBadgeFor,
  appActionsFor,
  onDelete,
  thumbFor,
  onAskDescribe,
  onAddRef,
  focusPath,
  onFocused,
  onAskCreate,
}: {
  onAddRef?: ContextSidebarProps["onAddRef"];
  /** No workspace, and the app asks where: New document and New folder ask, then make it there. */
  onAskCreate?: (
    what: "document" | "folder" | "bundle",
    extension?: string,
    label?: string,
  ) => void;
  entries: readonly ContextEntry[];
  activeDoc: ContextSidebarProps["activeDoc"];
  userHome: string | null;
  onOpenDoc: ContextSidebarProps["onOpenDoc"];
  onDrill: (entry: ContextEntry) => void;
  onStructure: (op: StructureOp) => void;
  onRemoveEntry: (id: string) => void;
  onImportFiles: (dt: DataTransfer, into?: string) => void;
  onAskMove: (path: string) => void;
  renamePath: string | null;
  onRenameStarted: () => void;
  onReveal: (path: string) => void;
  onPick: ContextSidebarProps["onPick"];
  workspace: string | null;
  onSetWorkspace: ContextSidebarProps["onSetWorkspace"];
  listDir: ContextSidebarProps["listDir"];
  onMove: (path: string, into: string) => void;
  /** Rows dropped on the list itself: each to the workspace folder. */
  onMoveToWorkspace: (rows: readonly DraggedRow[]) => void;
  badgeFor: (path: string) => ReactNode;
  folderBadgeFor: (path: string) => ReactNode;
  appActionsFor: (target: MenuTarget) => MenuAction[];
  /** Ask to move a single document or image to the Trash. A set is not offered: Remove from context. */
  onDelete?: (path: string) => void;
  /** Where a loose image's small thumbnail is served, for its row's hover preview. */
  thumbFor?: (path: string) => string;
  onAskDescribe?: (imagePath: string) => void;
  /** A row to give the focus once it shows in the list (a row just moved here). */
  focusPath: string | null;
  onFocused: () => void;
}) {
  const [menuFor, setMenuFor] = useState<ContextEntry | null>(null);
  // A loose image's description, listed beside it, is no row of its own.
  const { entries: rows, described } = foldListedSidecars(entries);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The row (entry id) or the whole list ("") a drag is over. */
  const [dropOn, setDropOn] = useState<string | null>(null);
  // A row just moved to the top of the context takes the focus once it shows.
  const listRef = useRef<HTMLUListElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `entries` is the trigger: the row arrives with a new snapshot.
  useEffect(() => {
    if (!focusPath) return;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row-path]") ?? [])].find(
      (b) => b.dataset.rowPath === focusPath,
    );
    if (!row) return; // not in this snapshot yet: the next one
    row.focus();
    onFocused();
  }, [focusPath, entries, onFocused]);

  // A new top-level document or set arrives in rename mode.
  useEffect(() => {
    if (!renamePath) return;
    if (entries.some((e) => entryPath(e) === renamePath)) {
      setRenaming(renamePath);
      onRenameStarted();
    }
  }, [renamePath, entries, onRenameStarted]);

  /** What a drop onto `into` does: files are copied in; a sidebar row is moved in. */
  const dropInto = (e: DragEvent, into: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropOn(null);
    if (carriesFiles(e.dataTransfer)) return onImportFiles(e.dataTransfer, into ?? undefined);
    const rows = readRowDrag(e.dataTransfer) ?? [];
    // Onto the list itself: out to the workspace folder (out of a set, when the
    // drag began in one and the list opened under it).
    if (!into) return onMoveToWorkspace(rows);
    for (const { path } of rows) if (path !== into && dirOf(path) !== into) onMove(path, into);
  };
  const acceptsDrag = (e: DragEvent) => carriesFiles(e.dataTransfer) || carriesRows(e.dataTransfer);

  const single = menuFor ? singleFile(menuFor) : null;
  const menuPath = menuFor ? entryPath(menuFor) : "";
  const menuSidecar = menuFor ? described.get(menuFor.id) : undefined;
  const menu = (
    <ContextMenuContent>
      {menuFor && single ? (
        <>
          <ContextMenuItem onClick={() => onOpenDoc(menuFor, single.rel)}>
            {single.kind === "image" ? (
              <ImageIcon />
            ) : single.kind === "bundle" ? (
              <BundleIcon type={bundleTypeOf(single.rel)} />
            ) : (
              <FileTextIcon />
            )}
            Open
          </ContextMenuItem>
          {onAddRef && (
            <AddRefItem
              onAdd={() => onAddRef(docPathOf(menuFor.root, single), nodeLabel(single))}
            />
          )}
          {single.kind === "image" && (
            <DescriptionItem
              sidecar={menuSidecar?.id}
              onEdit={() => {
                const doc = menuSidecar ? singleFile(menuSidecar) : null;
                if (menuSidecar && doc) onOpenDoc(menuSidecar, doc.rel);
              }}
              onAsk={onAskDescribe ? () => onAskDescribe(menuPath) : undefined}
            />
          )}
          <ContextMenuItem onClick={() => setRenaming(menuPath)}>
            <PencilIcon />
            Rename
          </ContextMenuItem>
          {(single.kind === "doc" || single.kind === "bundle") && (
            <DuplicateItem onDuplicate={() => onStructure({ op: "duplicate", path: menuPath })} />
          )}
          <MoveToItem onAsk={() => onAskMove(menuPath)} />
        </>
      ) : menuFor ? (
        <>
          <ContextMenuItem onClick={() => onDrill(menuFor)}>
            <FolderTreeIcon />
            Open set
          </ContextMenuItem>
          {menuFor.membership === "mirrored" && (
            <>
              <ContextMenuItem onClick={() => onStructure({ op: "doc.create", dir: menuFor.root })}>
                <FilePlusIcon />
                New document
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => onStructure({ op: "folder.create", dir: menuFor.root })}
              >
                <FolderPlusIcon />
                New folder
              </ContextMenuItem>
              <NewBundleItems dir={menuFor.root} onStructure={onStructure} />
            </>
          )}
          <ContextMenuItem onClick={() => setRenaming(menuPath)}>
            <PencilIcon />
            Rename
          </ContextMenuItem>
          <MoveToItem onAsk={() => onAskMove(menuPath)} />
        </>
      ) : (
        <>
          {onAskCreate && (
            <>
              <ContextMenuItem onClick={() => onAskCreate("document")}>
                <FilePlusIcon />
                New document…
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onAskCreate("folder")}>
                <FolderPlusIcon />
                New folder…
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={() => onPick("context-file")}>
            <FilePlusIcon />
            Add documents…
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onPick("context-folder")}>
            <FolderPlusIcon />
            Add a folder…
          </ContextMenuItem>
        </>
      )}
      {menuFor && <RevealItem onReveal={() => onReveal(menuPath)} />}
      <AppMenuItems
        actions={appActionsFor(
          menuFor
            ? { kind: "entry", path: menuPath, entry: menuFor }
            : { kind: "background", path: "" },
        )}
      />
      {menuFor && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => onRemoveEntry(menuFor.id)}>
            <XIcon />
            Remove from context
          </ContextMenuItem>
        </>
      )}
      {menuFor && single && onDelete && <DeleteItem onDelete={() => onDelete(menuPath)} />}
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
          // biome-ignore lint/a11y/noStaticElementInteractions: the list's drop zone (files from outside are copied in); the rows and toolbar are the keyboard path.
          <div
            onDragOver={(e) => {
              if (!acceptsDrag(e)) return;
              e.preventDefault();
              setDropOn("");
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
            }}
            onDrop={(e) => dropInto(e, null)}
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              dropOn === "" && "bg-brand/8 ring-1 ring-brand/40 ring-inset",
            )}
          />
        }
      >
        {workspace !== null && (
          <WorkspaceRow
            workspace={workspace}
            userHome={userHome}
            listDir={listDir}
            onSetWorkspace={onSetWorkspace}
            onStructure={onStructure}
          />
        )}
        <div className="flex shrink-0 items-center gap-0.5 px-1.5 pt-1">
          <span className="flex-1 truncate px-1 text-[11px] text-ink-faint">
            {workspace !== null
              ? "Drop documents or images here to copy them into the workspace"
              : onAskCreate
                ? "Drop files, then choose where they go"
                : "Drop documents or images here to copy them in"}
          </span>
          {onAskCreate && (
            <>
              <ToolButton label="New document…" onClick={() => onAskCreate("document")}>
                <FilePlusIcon />
              </ToolButton>
              <ToolButton label="New folder…" onClick={() => onAskCreate("folder")}>
                <FolderPlusIcon />
              </ToolButton>
              {bundleTypes().map((t) => (
                <ToolButton
                  key={t.extension}
                  label={`New ${t.label}…`}
                  onClick={() => onAskCreate("bundle", t.extension, t.label)}
                >
                  <BundleIcon type={t} />
                </ToolButton>
              ))}
            </>
          )}
        </div>
        {rows.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderTreeIcon />
              </EmptyMedia>
              <EmptyTitle>No context yet</EmptyTitle>
              <EmptyDescription>
                {onAskCreate
                  ? "Add a markdown file, an image or a folder by path below, or ask the agent to add one. A document or image dropped here is copied into a set you choose."
                  : "Add a markdown file, an image or a folder by path below, drop documents or images here to copy them in, or ask the agent to add one."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5"
            aria-label="Context"
          >
            {rows.map((entry) => {
              const only = singleFile(entry);
              const sidecar = described.get(entry.id);
              // The description open as a document marks its image's row.
              const holdsActive =
                activeDoc?.entryId === entry.id ||
                (sidecar !== undefined && activeDoc?.entryId === sidecar.id);
              const isActiveDoc =
                only !== null &&
                holdsActive &&
                (rowHolds(only, activeDoc?.rel ?? null) || activeDoc?.entryId === sidecar?.id);
              // A set's counts fold each description into its image.
              const counts = only ? null : countEntry(entry.nodes);
              const docCount = counts ? counts.docs : 1;
              const imageCount = counts ? counts.images : 0;
              const full = entryPath(entry);
              // A single document's row names its FOLDER (the file name is the title);
              // a set's row names its root. Cut from the front; the tooltip is whole.
              const where = shortPath(entry.root, userHome);
              const name = only ? nodeLabel(only) : entry.label;
              const badge = only
                ? badgeFor(docPathOf(entry.root, only))
                : folderBadgeFor(entryPath(entry));
              const icon = only ? (
                <DocIcon
                  name={only.rel}
                  className={cn(
                    "size-4 shrink-0",
                    isActiveDoc ? "text-selected" : "text-ink-faint",
                  )}
                />
              ) : (
                <FolderTreeIcon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0",
                    holdsActive ? "text-selected" : "text-ink-faint",
                  )}
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
                      whole={only?.kind === "bundle"}
                      onDone={(next) => {
                        setRenaming(null);
                        if (next) onStructure({ op: "rename", path: full, name: next });
                      }}
                    />
                  </li>
                );
              }
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    data-row-path={full}
                    draggable
                    onDragStart={(e) => {
                      // Out of the sidebar: the row's kit payload, for a document or a board.
                      writeRowDrag(e.dataTransfer, [
                        {
                          entry: entry.id,
                          path: full,
                          kind: only ? rowKindOf(only) : "set",
                        },
                      ]);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    // Only a set takes a drop; a document row passes it to the list.
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
                      (isActiveDoc || (holdsActive && !only)) && "bg-selected/15",
                      dropOn === entry.id && "bg-brand/15 ring-1 ring-brand/50 ring-inset",
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
                        {sidecar && <DescribedMark />}
                        {entry.truncated && <TruncatedBadge />}
                        {!only && (
                          // What a set holds, by kind: an icon and a count each, images only
                          // when there are any. The words are for screen readers and in the title.
                          <span
                            data-slot="set-counts"
                            title={countsInWords(docCount, imageCount)}
                            className="flex shrink-0 items-center gap-1.5"
                          >
                            <span className="sr-only">{countsInWords(docCount, imageCount)}</span>
                            <span aria-hidden className="flex items-center gap-0.5">
                              <FileTextIcon aria-hidden className="size-3" />
                              {docCount}
                            </span>
                            {imageCount > 0 && (
                              <span aria-hidden className="flex items-center gap-0.5">
                                <ImageIcon aria-hidden className="size-3" />
                                {imageCount}
                              </span>
                            )}
                            <span aria-hidden>·</span>
                          </span>
                        )}
                        <span className="truncate">{where}</span>
                      </span>
                    </span>
                    {badge && <span className="flex shrink-0 items-center">{badge}</span>}
                    {only?.kind === "image" && thumbFor && <ImagePeek src={thumbFor(full)} />}
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
  activeRaw,
  userHome,
  onBack,
  onOpenDoc,
  onStructure,
  onImportFiles,
  onAskMove,
  renamePath,
  onRenameStarted,
  onReveal,
  onMove,
  onMoveToWorkspace,
  badgeFor,
  folderBadgeFor,
  appActionsFor,
  onDelete,
  thumbFor,
  onAskDescribe,
  focusPath,
  onFocused,
  selected,
  onSelect,
  onAddRef,
}: {
  selected?: readonly string[];
  onSelect?: ContextSidebarProps["onSelect"];
  onAddRef?: ContextSidebarProps["onAddRef"];
  entry: ContextEntry;
  activeRel: string | null;
  activeRaw: boolean;
  userHome: string | null;
  onBack: () => void;
  thumbFor?: (path: string) => string;
  onAskDescribe?: (imagePath: string) => void;
  focusPath: string | null;
  onFocused: () => void;
  onOpenDoc: (rel: string) => void;
  onStructure: (op: StructureOp) => void;
  onImportFiles: (dt: DataTransfer, into?: string) => void;
  onAskMove: (path: string) => void;
  renamePath: string | null;
  onRenameStarted: () => void;
  onReveal: (path: string) => void;
  onMove: (path: string, into: string) => void;
  /** Rows dropped on the way back: each out to the workspace folder. Absent, no workspace. */
  onMoveToWorkspace?: (rows: readonly DraggedRow[]) => void;
  badgeFor: (path: string) => ReactNode;
  folderBadgeFor: (path: string) => ReactNode;
  appActionsFor: (target: MenuTarget) => MenuAction[];
  onDelete?: (path: string) => void;
}) {
  // A row dragged onto the way back moves out to the workspace when dropped
  // there; held there a moment, the list opens under it, to drop on the list
  // (the workspace) or on another set.
  const [backDrop, setBackDrop] = useState(false);
  const spring = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unspring = () => {
    if (spring.current) clearTimeout(spring.current);
    spring.current = null;
  };
  useEffect(
    () => () => {
      if (spring.current) clearTimeout(spring.current);
    },
    [],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-1.5 py-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="Back to the context list"
          title={
            onMoveToWorkspace
              ? "Back to the context list (drop a row here to move it to the workspace)"
              : "Back to the context list"
          }
          onDragOver={(e) => {
            if (!onMoveToWorkspace || !carriesRows(e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            setBackDrop(true);
            if (!spring.current) spring.current = setTimeout(onBack, SPRING_MS);
          }}
          onDragLeave={() => {
            setBackDrop(false);
            unspring();
          }}
          onDrop={(e) => {
            if (!onMoveToWorkspace || !carriesRows(e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            setBackDrop(false);
            unspring();
            onMoveToWorkspace(readRowDrag(e.dataTransfer) ?? []);
          }}
          className={cn(backDrop && "bg-brand/15 ring-1 ring-brand/50 ring-inset")}
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
        {folderBadgeFor(entryPath(entry))}
        <ToolButton
          label="New document in this set"
          onClick={() => onStructure({ op: "doc.create", dir: entry.root })}
        >
          <FilePlusIcon />
        </ToolButton>
        <ToolButton
          label="New folder in this set"
          onClick={() => onStructure({ op: "folder.create", dir: entry.root })}
        >
          <FolderPlusIcon />
        </ToolButton>
        <NewBundleButtons dir={entry.root} where=" in this set" onStructure={onStructure} />
        {appActionsFor({ kind: "entry", path: entryPath(entry), entry })
          .filter((a) => a.header && a.icon)
          .map((a) => (
            <Button
              key={a.id}
              variant="ghost"
              size="icon-sm"
              data-action={a.id}
              disabled={a.disabled}
              onClick={a.onSelect}
              aria-label={a.label}
              title={a.label}
            >
              {a.icon}
            </Button>
          ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-1">
        <EntryTree
          key={entry.id}
          entry={entry}
          activeRel={activeRel}
          activeRaw={activeRaw}
          onOpenDoc={onOpenDoc}
          onStructure={onStructure}
          onImportFiles={onImportFiles}
          onAskMove={onAskMove}
          focusPath={focusPath}
          onFocused={onFocused}
          renamePath={renamePath}
          onRenameStarted={onRenameStarted}
          onMenuKey={openMenuOnShiftF10}
          onReveal={onReveal}
          onMove={onMove}
          badgeFor={badgeFor}
          folderBadgeFor={folderBadgeFor}
          appActionsFor={appActionsFor}
          onDelete={onDelete}
          thumbFor={thumbFor}
          onAskDescribe={onAskDescribe}
          selected={selected}
          onSelect={onSelect}
          onAddRef={onAddRef}
        />
      </div>
    </div>
  );
}
