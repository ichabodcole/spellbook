// One set's tree, on @headless-tree/react. The library owns interaction state:
// focus, expansion, selection, the ARIA tree keyboard pattern, dragging, the
// rename box. It renders nothing; the rows here are ours. Data stays the
// daemon's: the loader reads a ref, and a changed entry rebuilds the tree rather
// than being copied into it.
//
// Every change the tree offers is a STRUCTURE OP sent to the daemon, which does
// the real thing on disk and sends the new tree back: the tree never edits its
// own data. Dragging is nesting only (`canReorder: false`), since order is a
// sort, never a position.
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  type ItemInstance,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import {
  BookmarkPlusIcon,
  ChevronRightIcon,
  CopyPlusIcon,
  FileBracesIcon,
  FileIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSymlinkIcon,
  ImageIcon,
  LibraryIcon,
  MessageSquareTextIcon,
  PackageIcon,
  PencilIcon,
  TextQuoteIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type BundleType,
  type BundleWarning,
  bundlePlace,
  bundleTypeOf,
  bundleTypes,
  isBundleMain,
} from "../lib/bundles.ts";
import { cn } from "../lib/cn.ts";
import { docFormat, isDocName, isImageName } from "../lib/docFormat.ts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "../ui/context-menu.tsx";
import type { ContextEntry, ContextNode, StructureOp } from "../workspace/protocol";
import type { MenuAction, MenuTarget } from "./menuActions.ts";
import { AppMenuItems, carriesFiles, DeleteItem, MoveToItem, RevealItem } from "./menus.tsx";
import {
  ancestorsOf,
  dirOf,
  docPathOf,
  indexTree,
  joinPath,
  nodeLabel,
  ROOT_ID,
  type TreeIndex,
  tildify,
} from "./model.ts";
import { encodeRowDrag, ROW_DRAG_MIME, rowKindOf } from "./rowDrag.ts";

const INDENT_PX = 14;

const NO_ROWS: readonly string[] = [];

type Node = ContextNode;

/**
 * The sync loader must never answer null or undefined (the library throws
 * "sync dataLoader returned undefined"). The synthetic root gets a real node,
 * and so does an id that left the index (a renamed or moved item) for the one
 * render before `rebuildTree` drops it; such a row renders as nothing.
 */
const ROOT_NODE: ContextNode = { kind: "group", rel: ROOT_ID, children: [] };
const staleNode = (id: string): ContextNode => ({ kind: "doc", rel: id });

/**
 * Select a name's stem, so typing replaces "Untitled", not ".md". A bundle's
 * name is its title, with no extension to keep: all of it.
 */
function selectStem(input: HTMLInputElement, whole = false) {
  const dot = whole ? -1 : input.value.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
}

/**
 * The "New …" items for each bundle type the app registered, beside New
 * document and New folder: "New canvas" makes an empty one in `dir`.
 */
export function NewBundleItems({
  dir,
  onStructure,
}: {
  dir: string;
  onStructure: (op: StructureOp) => void;
}) {
  return bundleTypes().map((t) => (
    <ContextMenuItem
      key={t.extension}
      onClick={() => onStructure({ op: "bundle.create", dir, extension: t.extension })}
    >
      <BundleIcon type={t} />
      New {t.label}
    </ContextMenuItem>
  ));
}

/** "Duplicate": a copy beside it, a bundle's whole folder with it. */
export function DuplicateItem({ onDuplicate }: { onDuplicate: () => void }) {
  return (
    <ContextMenuItem onClick={onDuplicate}>
      <CopyPlusIcon />
      Duplicate
    </ContextMenuItem>
  );
}

export function EntryTree({
  entry,
  activeRel,
  activeRaw = false,
  onOpenDoc,
  onStructure,
  onMove,
  onImportFiles,
  onAskMove,
  renamePath,
  onRenameStarted,
  onMenuKey,
  onReveal,
  badgeFor,
  folderBadgeFor,
  appActionsFor,
  onDelete,
  thumbFor,
  onAskDescribe,
  focusPath = null,
  onFocused,
  selected = NO_ROWS,
  onSelect,
  onAddRef,
  onOpenAsSet,
  onLinkDrop,
  userHome = null,
}: {
  /**
   * "Open as its own set" on a link's row (a folder link, shown and never
   * entered): adds the folder at that path as a set of its own. Absent, not
   * offered.
   */
  onOpenAsSet?: (path: string) => void;
  /**
   * Something dropped on a link's row: nothing goes into a link, so the drop
   * lands nowhere and this is told instead, to say so and offer the link as a
   * set of its own. Absent, a link's row takes no drop.
   */
  onLinkDrop?: (path: string, linkTo: string | undefined) => void;
  /** For `~` in a link's "a link to …"; null shows the path absolute. */
  userHome?: string | null;
  /**
   * The rows the human chose in the file tree (Cmd, Ctrl or Shift with a
   * click, or the keyboard's forms), by absolute path, across every set: the
   * tree's selection, held by the caller. A plain click opens a row and
   * chooses none. The documents and images chosen, other than the message's
   * subject, are its refs, read at send.
   */
  selected?: readonly string[];
  /**
   * The whole chosen selection after a click or a key here. A modified click
   * or key adds, toggles or extends it. A plain click that opens its row
   * chooses nothing and lets go of every row chosen, in every set; a plain
   * click that opens nothing (a folder expanding or shutting, a bundle's own
   * file) is not reported, and a drag's start is not either.
   */
  onSelect?: (rows: readonly string[]) => void;
  /** "Add as reference": a document, image or bundle row, by what to read and its name. */
  onAddRef?: (path: string, name: string) => void;
  /** An absolute path to give the keyboard focus once it is in the tree (a row just moved here). */
  focusPath?: string | null;
  onFocused?: () => void;
  entry: ContextEntry;
  /** The open document's rel within THIS entry, or null. */
  activeRel: string | null;
  /**
   * The open document is a bundle's main file opened from its own row inside
   * the expanded bundle (drawn raw): that row is the one marked open, not the
   * bundle's.
   */
  activeRaw?: boolean;
  onOpenDoc: (rel: string) => void;
  onStructure: (op: StructureOp) => void;
  onMove: (path: string, into: string) => void;
  /** Files dropped from outside the page, to be copied in (the daemon files them under the session). */
  /** Files from outside: copied into `into`, the folder they were dropped on. */
  onImportFiles: (files: DataTransfer, into: string) => void;
  /** Ask where to move a row's document or folder: opens "Move to…". */
  onAskMove: (path: string) => void;
  /** An absolute path to put into rename mode once it is in the tree (a new document or folder). */
  renamePath: string | null;
  onRenameStarted: () => void;
  onMenuKey: (e: KeyboardEvent<HTMLElement>) => void;
  onReveal: (path: string) => void;
  /** The per-document badge slot: what an app shows at the row's trailing edge, by absolute path. */
  badgeFor: (path: string) => ReactNode;
  /** The folder badge slot: what an app shows on a group row, by the folder's absolute path. */
  folderBadgeFor: (path: string) => ReactNode;
  /** The app's own menu actions for a target. */
  appActionsFor: (target: MenuTarget) => MenuAction[];
  /** Ask to move a row's document or folder to the Trash; absent, no Delete is offered. */
  onDelete?: (path: string) => void;
  /** Where an image's small thumbnail is served, by absolute path: the row's hover preview. */
  thumbFor?: (path: string) => string;
  /** "Ask the agent to describe" an image with no description: posts a chat message. Absent, not offered. */
  onAskDescribe?: (imagePath: string) => void;
}) {
  const index = useMemo(() => indexTree(entry.nodes), [entry.nodes]);
  // A description open as a document has no row of its own: its image's row is
  // the one marked open. So has a bundle's main file: its bundle's row is.
  // A main file opened raw from its own row inside its bundle is that row's.
  const shownRel =
    activeRel === null
      ? null
      : activeRaw && index.byId.get(activeRel)?.kind === "file"
        ? activeRel
        : (index.imageOf.get(activeRel) ?? index.bundleOf.get(activeRel) ?? activeRel);
  const indexRef = useRef<TreeIndex>(index);
  indexRef.current = index;
  const pathOf = (id: string) => (id === ROOT_ID ? entry.root : joinPath(entry.root, id));
  /** The folder an item id stands for as a destination: itself if a folder, else its parent. */
  const dirFor = (id: string) => {
    if (id === ROOT_ID) return entry.root;
    const node = indexRef.current.byId.get(id);
    return node ? dropDirOf(entry.root, node) : dirOf(joinPath(entry.root, id));
  };

  // The library's drop handler and the background's `onDrop` both see one drop
  // (the event bubbles); the first marks it so the second does not import again.
  const foreignHandled = useRef(false);

  // THE SELECTION IS THE CALLER'S. The library keeps it per tree, but a set
  // drilled out of and back into, or another set, must see the same one: it is
  // what the next message refers to. So the library is told what is selected,
  // and every change goes back up. A plain click is the only act that clears
  // the other sets' rows; a modified click, or Shift with an arrow, adds here.
  const selectedIds = useMemo(
    () =>
      selected
        .filter((p) => p.startsWith(`${entry.root}/`))
        .map((p) => p.slice(entry.root.length + 1))
        .filter((id) => index.byId.has(id)),
    [selected, entry.root, index],
  );
  const plainClick = useRef(false);
  const unreported = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const tree = useTree<Node>({
    rootItemId: ROOT_ID,
    state: { selectedItems: selectedIds },
    setSelectedItems: (next) => {
      // What the library selects that is no choice of the human's, so nothing
      // is reported: a row dragged that was not selected (selected for the drag
      // alone), and a plain click that opens nothing (a folder expanding or
      // collapsing chooses nothing and drops nothing).
      if (unreported.current) return;
      // A plain click opens its row; it does not choose it. What a plain
      // click selects is never a ref, and it lets go of every row chosen
      // before, in every set (the user, 2026-10-14).
      if (plainClick.current) {
        onSelect?.([]);
        return;
      }
      const ids = typeof next === "function" ? next(selectedIds) : next;
      const rows = ids.filter((id) => id !== ROOT_ID).map(pathOf);
      const others = selectedRef.current.filter((p) => !p.startsWith(`${entry.root}/`));
      onSelect?.([...others, ...rows]);
    },
    // Expand the open document's folders on first render, so it is visible.
    initialState: { expandedItems: shownRel ? ancestorsOf(shownRel) : [] },
    getItemName: (item) => (item.getId() === ROOT_ID ? entry.label : nodeLabel(item.getItemData())),
    // A group opens and shuts, and so does a bundle whose type expands (its
    // row's chevron, ArrowRight and ArrowLeft, "Show contents").
    isItemFolder: (item) => isFolderNode(item.getItemData()),
    // ArrowRight on a link's row stays put: it is a folder that never opens,
    // not a row to step past. Enter does nothing there, as on any row that
    // opens nothing; its menu is Shift+F10 or the context-menu key, as on any row.
    // A hotkey given here REPLACES the library's whole entry (not merged), so
    // it is the library's own `expandOrDown`, with the link's row left out.
    hotkeys: {
      expandOrDown: {
        hotkey: "ArrowRight",
        canRepeat: true,
        handler: (_e, t) => {
          const focused = t.getFocusedItem();
          if (isLinkNode(focused.getItemData())) return;
          if (focused.isExpanded() || !focused.isFolder()) {
            t.focusNextItem();
            t.updateDomFocus();
          } else focused.expand();
        },
      },
    },
    dataLoader: {
      getItem: (id) =>
        id === ROOT_ID ? ROOT_NODE : (indexRef.current.byId.get(id) ?? staleNode(id)),
      getChildren: (id) => indexRef.current.children.get(id) ?? [],
    },
    // Opening is the row's own click (below), which a <button> also fires on
    // Enter and Space. Opening here too would send `open` twice per keypress, so
    // the library's primary action is left to toggle groups only.
    indent: INDENT_PX,
    // Dragging: nesting only, every drop a real move. A bundle's own files and
    // folders stay where its type keeps them: they are not dragged.
    canReorder: false,
    canDrag: (items) => items.every((i) => !isOwnNode(entry.root, i.getItemData())),
    canDrop: (items, target) => {
      const into = target.item.getId();
      // Never into a bundle's own files or folders (`audio/`): the daemon
      // would refuse it, so it does not light up as a place to drop.
      if (isOwnTarget(entry.root, target.item.getItemData())) return false;
      // A link's row takes nothing; with `onLinkDrop` it lights up, and its
      // drop is answered there rather than sent.
      if (isLinkNode(target.item.getItemData()) && !onLinkDrop) return false;
      // Not into itself, and not into anything under itself.
      return !items.some((i) => into === i.getId() || into.startsWith(`${i.getId()}/`));
    },
    onDrop: (items, target) => {
      const on = target.item.getItemData();
      if (isLinkNode(on)) return onLinkDrop?.(pathOf(target.item.getId()), on.linkTo);
      const into = dirFor(target.item.getId());
      for (const i of items) {
        const path = pathOf(i.getId());
        if (dirOf(path) !== into) onMove(path, into);
      }
    },
    // Out of the tree: every drag also carries its rows under the kit's row type
    // (`rowDrag.ts`), for a document or a board to read, and for the sidebar's
    // own drops outside the tree: the set's way back and the list, which move
    // rows to the workspace. A move within the tree still comes from the
    // library's own drag state.
    createForeignDragObject: (items) => ({
      format: ROW_DRAG_MIME,
      data: encodeRowDrag(
        items.map((i) => ({
          entry: entry.id,
          path: pathOf(i.getId()),
          kind: rowKindOf(i.getItemData()),
        })),
      ),
    }),
    // Files from Finder: a copy into the folder they land on (a document row's own folder).
    canDragForeignDragObjectOver: (dt) => carriesFiles(dt),
    canDropForeignDragObject: (dt, target) =>
      carriesFiles(dt) &&
      !isOwnTarget(entry.root, target.item.getItemData()) &&
      (!isLinkNode(target.item.getItemData()) || onLinkDrop !== undefined),
    onDropForeignDragObject: (dt, target) => {
      foreignHandled.current = true;
      // A row's own drop stops the event before the background sees it, so the
      // mark must not outlive this drop: the bubble is synchronous, this is not.
      setTimeout(() => {
        foreignHandled.current = false;
      }, 0);
      const on = target.item.getItemData();
      if (isLinkNode(on)) return onLinkDrop?.(pathOf(target.item.getId()), on.linkTo);
      onImportFiles(dt, dirFor(target.item.getId()));
    },
    openOnDropDelay: 600,
    // Renaming: F2, the menu, or a new item; Enter keeps, Escape drops.
    canRename: (item) => item.getId() !== ROOT_ID && !isOwnNode(entry.root, item.getItemData()),
    onRename: (item, value) => {
      const name = value.trim();
      if (name && name !== item.getItemName())
        onStructure({ op: "rename", path: pathOf(item.getId()), name });
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      renamingFeature,
    ],
  });

  // The entry changed on disk (a move, a new file, an outside change): rebuild from the new index.
  // `index` is what changed; the effect reads it through the loader's ref, so the
  // linter cannot see that it is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` is the trigger.
  useEffect(() => {
    tree.rebuildTree();
  }, [index, tree]);

  // A row just moved here by "Move to…" takes the focus, its folders opened to
  // show it, so the keyboard carries on from where the thing now is.
  useEffect(() => {
    if (!focusPath?.startsWith(`${entry.root}/`)) return;
    const rel = focusPath.slice(entry.root.length + 1);
    if (!index.byId.has(rel)) return; // not in this snapshot yet: the next one
    for (const a of ancestorsOf(rel)) tree.getItemInstance(a)?.expand();
    tree.getItemInstance(rel)?.setFocused();
    tree.updateDomFocus();
    onFocused?.();
  }, [focusPath, index, entry.root, tree, onFocused]);

  // A new document or folder arrives in rename mode, its folders opened to show it.
  useEffect(() => {
    if (!renamePath?.startsWith(`${entry.root}/`)) return;
    const rel = renamePath.slice(entry.root.length + 1);
    if (!index.byId.has(rel)) return; // not in this snapshot yet: the next one
    for (const a of ancestorsOf(rel)) tree.getItemInstance(a)?.expand();
    tree.getItemInstance(rel)?.startRenaming();
    onRenameStarted();
  }, [renamePath, index, entry.root, tree, onRenameStarted]);

  // The open document changed by another route than its own row (a followed
  // link, a search result, the agent, a toast's Show): open the folders down to
  // it and bring its row into view, so the highlight is somewhere the human can
  // see. Only on the CHANGE of document: a folder the human shuts afterwards
  // stays shut, and nothing the human had open is collapsed. The first render
  // counts as a change too: `initialState` has opened the way, and a tree drilled
  // into for a followed link still has to bring a row below the fold into view.
  const revealed = useRef<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (shownRel === revealed.current) return;
    if (shownRel !== null && !index.byId.has(shownRel)) return; // not in this snapshot yet
    revealed.current = shownRel;
    if (shownRel === null) return;
    for (const a of ancestorsOf(shownRel)) {
      const folder = tree.getItemInstance(a);
      if (folder && !folder.isExpanded()) folder.expand();
    }
    setScrollTo(shownRel);
  }, [shownRel, index, tree]);
  // The scroll, once the row can take one. It waits for the opened folders to
  // render the row, and, with the column shut to its rail (kept mounted but
  // `hidden`, so with no layout), for the column to reopen: a scroll made on the
  // rail does nothing, and the row would come back just out of view. It scrolls
  // once, then clears; a newer reveal replaces it.
  useEffect(() => {
    if (scrollTo === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: MutationObserver | undefined;
    let tries = 0;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      watcher?.disconnect();
      const el = tree.getItemInstance(scrollTo)?.getElement();
      if (!el) {
        if (++tries < 50) timer = setTimeout(attempt, 20);
        else setScrollTo(null);
        return;
      }
      const shut = el.closest<HTMLElement>("[hidden]");
      if (shut) {
        watcher = new MutationObserver(() => {
          // Reopened: give the column a frame to lay out, then scroll.
          if (!shut.hidden) requestAnimationFrame(() => requestAnimationFrame(attempt));
        });
        watcher.observe(shut, { attributes: true, attributeFilter: ["hidden"] });
        return;
      }
      el.scrollIntoView?.({ block: "nearest" });
      setScrollTo(null);
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      watcher?.disconnect();
    };
  }, [scrollTo, tree]);

  // ONE context menu for the whole tree: a row's right-click names its node
  // first, then the event reaches the trigger; the background names none.
  const [menuFor, setMenuFor] = useState<ContextNode | null>(null);
  const [bgDrop, setBgDrop] = useState(false);

  const renameItem = (rel: string) => tree.getItemInstance(rel)?.startRenaming();

  // A drop on the empty space below the rows.
  const onBgDragOver = (e: DragEvent) => {
    if ((e.target as HTMLElement).closest('[role="treeitem"]')) return setBgDrop(false);
    if (!carriesFiles(e.dataTransfer) && !tree.getState().dnd?.draggedItems?.length) return;
    e.preventDefault();
    setBgDrop(true);
  };
  const onBgDrop = (e: DragEvent) => {
    setBgDrop(false);
    if (foreignHandled.current) {
      foreignHandled.current = false;
      return;
    }
    if ((e.target as HTMLElement).closest('[role="treeitem"]')) return;
    e.preventDefault();
    if (carriesFiles(e.dataTransfer)) return onImportFiles(e.dataTransfer, entry.root);
    for (const i of tree.getState().dnd?.draggedItems ?? []) {
      const path = pathOf(i.getId());
      if (dirOf(path) !== entry.root) onMove(path, entry.root);
    }
  };

  const items = tree.getItems();
  const menuPath = menuFor ? pathOf(menuFor.rel) : entry.root;
  const menuDir = menuFor?.kind === "group" ? menuPath : menuFor ? dirOf(menuPath) : entry.root;
  const menuKind = menuFor ? menuFor.kind : ("entry" as const);
  const menuSidecar = menuFor?.kind === "image" ? index.sidecars.get(menuFor.rel) : undefined;
  // Inside an expandable bundle: only a member's files and folders are acted
  // on; the member folder takes new documents; the rest is the type's own.
  const menuPlace = menuFor ? bundlePlace(menuPath) : null;
  const menuActs = menuPlace === null || menuPlace === "member";
  // A link's row makes nothing: what is made there would land where it leads.
  const menuLink = menuFor !== null && isLinkNode(menuFor);
  const menuMakes = !menuFor || (menuFor.kind === "group" && menuPlace !== "own" && !menuLink);
  const menuOpens =
    menuFor !== null &&
    menuFor.kind !== "group" &&
    (menuFor.kind !== "file" || isBundleMain(menuPath));
  const menuExpands = menuFor?.kind === "bundle" && menuFor.contents !== undefined;
  const menuItem = menuFor ? tree.getItemInstance(menuFor.rel) : undefined;

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) setMenuFor(null);
      }}
    >
      <ContextMenuTrigger
        render={
          // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone for the space below the rows; the rows are the keyboard path.
          <div
            onDragOver={onBgDragOver}
            onDragLeave={() => setBgDrop(false)}
            onDrop={onBgDrop}
            className={cn(
              "flex min-h-full flex-col rounded-md",
              bgDrop && "bg-brand/8 ring-1 ring-brand/40 ring-inset",
            )}
          />
        }
      >
        {items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-dim">
            This folder has no documents yet. Right-click to make one, or drop files here.
          </p>
        ) : (
          <div
            {...tree.getContainerProps(`${entry.label} documents`)}
            className="flex flex-col py-1 outline-none"
          >
            {items.map((item) => (
              <Row
                key={item.getId()}
                item={item}
                stale={!index.byId.has(item.getId())}
                badge={
                  item.getItemData().kind === "group"
                    ? folderBadgeFor(pathOf(item.getId()))
                    : item.getItemData().kind === "file"
                      ? null
                      : badgeFor(docPathOf(entry.root, item.getItemData()))
                }
                path={pathOf(item.getId())}
                activeRel={shownRel}
                described={index.sidecars.has(item.getId())}
                onOpenDoc={onOpenDoc}
                onMenu={setMenuFor}
                onMenuKey={onMenuKey}
                userHome={userHome}
                plainClick={plainClick}
                unreported={unreported}
                thumb={
                  thumbFor && item.getItemData().kind === "image"
                    ? thumbFor(pathOf(item.getId()))
                    : undefined
                }
              />
            ))}
          </div>
        )}
        <div className="min-h-8 flex-1" />
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuFor && menuOpens && (
          <ContextMenuItem onClick={() => onOpenDoc(menuFor.rel)}>
            {menuFor.kind === "image" ? (
              <ImageIcon />
            ) : menuFor.kind === "bundle" ? (
              <BundleIcon type={bundleTypeOf(menuFor.rel)} />
            ) : menuFor.kind === "file" ? (
              <FileBracesIcon />
            ) : (
              <FileTextIcon />
            )}
            Open
          </ContextMenuItem>
        )}
        {menuExpands && menuItem && (
          <ContextMenuItem
            onClick={() => (menuItem.isExpanded() ? menuItem.collapse() : menuItem.expand())}
          >
            <ChevronRightIcon className={cn(menuItem.isExpanded() && "rotate-90")} />
            {menuItem.isExpanded() ? "Hide contents" : "Show contents"}
          </ContextMenuItem>
        )}
        {menuFor && onAddRef && menuOpens && menuFor.kind !== "file" && (
          <AddRefItem onAdd={() => onAddRef(docPathOf(entry.root, menuFor), nodeLabel(menuFor))} />
        )}
        {menuFor?.kind === "image" && (
          <DescriptionItem
            sidecar={menuSidecar}
            onEdit={(rel) => onOpenDoc(rel)}
            onAsk={onAskDescribe ? () => onAskDescribe(menuPath) : undefined}
          />
        )}
        {menuLink && onOpenAsSet && (
          <ContextMenuItem onClick={() => onOpenAsSet(menuPath)}>
            <LibraryIcon />
            Open as its own set
          </ContextMenuItem>
        )}
        {menuMakes && (
          <>
            <ContextMenuItem onClick={() => onStructure({ op: "doc.create", dir: menuDir })}>
              <FilePlusIcon />
              New document
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onStructure({ op: "folder.create", dir: menuDir })}>
              <FolderPlusIcon />
              New folder
            </ContextMenuItem>
            {menuPlace === null && <NewBundleItems dir={menuDir} onStructure={onStructure} />}
          </>
        )}
        {menuFor && menuActs && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => renameItem(menuFor.rel)}>
              <PencilIcon />
              Rename
              <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
            {(menuFor.kind === "doc" || menuFor.kind === "bundle") && (
              <DuplicateItem onDuplicate={() => onStructure({ op: "duplicate", path: menuPath })} />
            )}
            <MoveToItem onAsk={() => onAskMove(menuPath)} />
          </>
        )}
        <RevealItem onReveal={() => onReveal(menuPath)} />
        {/* An app's folder actions ("Map of this folder") are not for a bundle's own folders. */}
        {!(menuFor?.kind === "group" && menuPlace === "own") && (
          <AppMenuItems actions={appActionsFor({ kind: menuKind, path: menuPath, entry })} />
        )}
        {menuFor && menuActs && onDelete && <DeleteItem onDelete={() => onDelete(menuPath)} />}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** "Add as reference": the row rides the next message as a ref, beside its subject. */
export function AddRefItem({ onAdd }: { onAdd: () => void }) {
  return (
    <ContextMenuItem onClick={onAdd}>
      <BookmarkPlusIcon />
      Add as reference
    </ContextMenuItem>
  );
}

/**
 * An image row's description item: "Edit description" opens its sidecar as the
 * document it is, where it is versioned like any other; with none, "Ask the
 * agent to describe" posts a chat message, when the app can.
 */
export function DescriptionItem({
  sidecar,
  onEdit,
  onAsk,
}: {
  /** The sidecar's rel or path, as `onEdit` takes it; absent, there is none yet. */
  sidecar: string | undefined;
  onEdit: (sidecar: string) => void;
  onAsk?: () => void;
}) {
  if (sidecar !== undefined)
    return (
      <ContextMenuItem onClick={() => onEdit(sidecar)}>
        <FilePenLineIcon />
        Edit description
      </ContextMenuItem>
    );
  if (!onAsk) return null;
  return (
    <ContextMenuItem onClick={onAsk}>
      <MessageSquareTextIcon />
      Ask the agent to describe
    </ContextMenuItem>
  );
}

/** The mark on an image's row that it has a description (its sidecar, folded into the row). */
export function DescribedMark() {
  return (
    <span
      data-slot="described-mark"
      title="Has a description"
      className="flex shrink-0 items-center text-ink-faint"
    >
      <TextQuoteIcon aria-hidden className="size-3" />
      <span className="sr-only">, has a description</span>
    </span>
  );
}

/**
 * A bundle type's icon, as its app registered it, at the size and colour the
 * row asks for (an icon that sets its own colour keeps it). A generic box for
 * a type registered without one, or an unknown one.
 */
export function BundleIcon({
  type,
  className,
}: {
  type: BundleType | null | undefined;
  className?: string;
}) {
  if (!type?.icon) return <PackageIcon aria-hidden data-format="bundle" className={className} />;
  return (
    <span
      aria-hidden
      data-format="bundle"
      data-bundle={type.type}
      className={cn("inline-flex items-center justify-center [&>svg]:size-full", className)}
    >
      {type.icon}
    </span>
  );
}

/**
 * A file's icon in the sidebar: a bundle's own, a picture for an image, braces
 * for JSON, a page for everything else.
 */
export function DocIcon({ name, className }: { name: string; className?: string }) {
  const bundle = bundleTypeOf(name);
  if (bundle) return <BundleIcon type={bundle} className={className} />;
  if (isImageName(name)) return <ImageIcon aria-hidden data-format="image" className={className} />;
  return docFormat(name) === "json" ? (
    <FileBracesIcon aria-hidden data-format="json" className={className} />
  ) : (
    <FileTextIcon aria-hidden className={className} />
  );
}

function Row({
  item,
  stale,
  badge,
  path,
  activeRel,
  described,
  onOpenDoc,
  onMenu,
  onMenuKey,
  thumb,
  plainClick,
  unreported,
  userHome,
}: {
  userHome: string | null;
  /**
   * Set while the library selects for an act that is no choice (a drag's
   * start, a plain click that opens nothing): what it selects is not reported.
   */
  unreported: { current: boolean };
  /** Set for the length of a click with no modifier key: the tree's selection then becomes this row alone. */
  plainClick: { current: boolean };
  item: ItemInstance<Node>;
  /** Gone from the index (renamed, moved): the next rebuild drops it. */
  stale: boolean;
  badge: ReactNode;
  /** The row's absolute path. */
  path: string;
  activeRel: string | null;
  /** An image with a description folded into its row. */
  described: boolean;
  onOpenDoc: (rel: string) => void;
  onMenu: (node: ContextNode) => void;
  onMenuKey: (e: KeyboardEvent<HTMLElement>) => void;
  /** An image row's thumbnail, for its hover preview. */
  thumb?: string;
}) {
  if (stale) return null;
  const node = item.getItemData();
  const level = item.getItemMeta().level;
  const isGroup = node.kind === "group";
  // A folder link: a row of its own look, never opened or shut.
  const link = isLinkNode(node);
  const linkTo = link && node.linkTo ? tildify(node.linkTo, userHome) : null;
  const linkTitle = link
    ? `A link to ${linkTo ?? "a folder"}: right-click to open it as its own set`
    : undefined;
  // Its accessible name says so: the library names a row by its label alone.
  const linkName = link
    ? `${item.getItemName()}, a link${linkTo ? ` to ${linkTo}` : ""}`
    : undefined;
  // A bundle whose type expands: its row opens it, its chevron shows what is inside.
  const expandable = node.kind === "bundle" && node.contents !== undefined;
  // One of a bundle's own files: only its main file opens (raw), from here.
  const isFile = node.kind === "file";
  const opens = !isGroup && (!isFile || isBundleMain(path));
  const isActive = !isGroup && node.rel === activeRel;
  const refSelected = !isGroup && !isFile && !isActive && item.isSelected();
  const props = item.getProps();
  // ONE BACKGROUND AND ONE TEXT COLOUR PER STATE. `cn` joins classes without
  // merging them, so two backgrounds on one row are decided by the stylesheet's
  // order, not this list's: a focused row (the one just Cmd-clicked) lost its
  // ref tint that way. The states are exclusive, strongest first.
  const tone = item.isDragTarget()
    ? "bg-brand/15 text-ink ring-1 ring-brand/50 ring-inset"
    : isActive
      ? "bg-selected/15 font-medium text-ink"
      : refSelected
        ? // Selected and not the open one: it rides the next message as a ref. A
          // brand tint unless a theme sets the two hooks (the tint, and a bar at
          // the row's left edge, unset and so unseen).
          "bg-[color:var(--color-ref-row,color-mix(in_oklab,var(--color-brand)_10%,transparent))] shadow-[inset_2px_0_0_var(--color-ref-row-bar,transparent)] text-ink"
        : item.isSelected()
          ? // A folder chosen with the others (no ref): selected, so a drag takes it.
            "bg-surface-raised text-ink"
          : cn(
              item.isFocused() && "bg-surface-raised/60",
              // The convention's files (the main file, `info.json`) step back.
              node.kind === "file" && node.convention ? "text-ink-faint" : "text-ink-dim",
            );
  const rowClass = cn(
    "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-sm outline-none",
    "hover:bg-surface-raised hover:text-ink",
    "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
    tone,
  );
  const toggle = () => (item.isExpanded() ? item.collapse() : item.expand());
  const icon = link ? (
    <>
      <span aria-hidden className="size-3.5 shrink-0" />
      <FolderSymlinkIcon
        aria-hidden
        data-slot="link-icon"
        className="size-4 shrink-0 text-ink-faint"
      />
    </>
  ) : isGroup ? (
    <>
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-ink-faint transition-transform",
          item.isExpanded() && "rotate-90",
        )}
      />
      {item.isExpanded() ? (
        <FolderOpenIcon aria-hidden className="size-4 shrink-0 text-ink-faint" />
      ) : (
        <FolderIcon aria-hidden className="size-4 shrink-0 text-ink-faint" />
      )}
    </>
  ) : (
    <>
      {expandable ? (
        // The pointer's way to show or hide what is inside; the keyboard's is
        // ArrowRight and ArrowLeft on the row, and the row's menu has both.
        // biome-ignore lint/a11y/useKeyWithClickEvents: the row's own keys expand and collapse it.
        // biome-ignore lint/a11y/noStaticElementInteractions: a chevron inside the row's button; the row is the control.
        <span
          data-slot="bundle-chevron"
          title={item.isExpanded() ? "Hide contents" : "Show contents"}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className="flex size-3.5 shrink-0 items-center justify-center rounded-sm hover:bg-surface-raised"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-ink-faint transition-transform",
              item.isExpanded() && "rotate-90",
            )}
          />
        </span>
      ) : (
        <span aria-hidden className="size-3.5 shrink-0" />
      )}
      {isFile && !isDocName(node.rel) ? (
        <FileIcon aria-hidden className="size-4 shrink-0 text-ink-faint" />
      ) : (
        <DocIcon
          name={node.rel}
          className={cn("size-4 shrink-0", isActive ? "text-selected" : "text-ink-faint")}
        />
      )}
    </>
  );
  const style = { paddingLeft: `${8 + level * INDENT_PX}px` };

  // Renaming: the row is a plain element holding the library's input. An input
  // inside a <button> would have its Space and clicks taken by the button.
  if (item.isRenaming()) {
    const input = item.getRenameInputProps();
    return (
      <div style={style} className={rowClass}>
        {icon}
        <input
          {...input}
          // biome-ignore lint/a11y/noAutofocus: the human asked to rename this row (F2, the menu, or a new item).
          autoFocus
          onFocus={(e) => selectStem(e.currentTarget, node.kind === "bundle")}
          aria-label={`Rename ${item.getItemName()}`}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-sm border border-ring/60 bg-bg px-1 font-sans text-sm text-ink outline-none"
        />
      </div>
    );
  }

  return (
    <button
      {...props}
      type="button"
      onClick={(e) => {
        // A click with Cmd, Ctrl or Shift selects (adds, toggles, extends) and
        // opens nothing: the open document stays the subject, and the rows
        // added are what the next message refers to besides.
        const modified = e.metaKey || e.ctrlKey || e.shiftKey;
        // Only a plain click that opens its row lets go of what was chosen; one
        // that opens nothing (a folder, a bundle's own file) leaves it be.
        plainClick.current = !modified && opens;
        unreported.current = !modified && !opens;
        try {
          if (expandable && !modified) {
            // The library's click would also open or shut it, as a folder: an
            // expandable bundle's row opens the bundle, and only its chevron
            // shows what is inside. Focus and selection as the library gives them.
            item.setFocused();
            item.getTree().setSelectedItems([item.getId()]);
          } else props.onClick?.(e);
        } finally {
          plainClick.current = false;
          unreported.current = false;
        }
        // A single click opens a document (a sidebar, not a file manager);
        // on a group the library's own click already toggled it.
        if (opens && !modified) onOpenDoc(node.rel);
      }}
      onDragStart={(e) => {
        unreported.current = true;
        try {
          props.onDragStart?.(e);
        } finally {
          unreported.current = false;
        }
      }}
      onContextMenu={() => {
        item.setFocused();
        onMenu(node);
      }}
      onKeyDown={(e) => {
        props.onKeyDown?.(e);
        onMenuKey(e);
      }}
      style={style}
      data-active={isActive || undefined}
      data-selected={refSelected || undefined}
      data-kind={node.kind}
      data-link={link || undefined}
      title={linkTitle}
      {...(linkName ? { "aria-label": linkName } : {})}
      data-convention={(node.kind === "file" && node.convention) || undefined}
      className={rowClass}
    >
      {icon}
      <span className="truncate">{item.getItemName()}</span>
      {described && <DescribedMark />}
      {node.kind === "bundle" && node.warnings && node.warnings.length > 0 && (
        <WarningsMark warnings={node.warnings} />
      )}
      {node.kind === "bundle" && node.truncated && <PartialMark />}
      {badge && <span className="ml-auto flex shrink-0 items-center">{badge}</span>}
      {!badge && node.kind === "file" && node.size !== undefined && (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
          {fileSize(node.size)}
        </span>
      )}
      {thumb && <ImagePeek src={thumb} />}
    </button>
  );
}

/**
 * The mark on a bundle's row that its type's `validate` found something
 * wrong: a count, with the warnings in its tooltip. The full list is the
 * app's to show (a stage's dashboard).
 */
export function WarningsMark({ warnings }: { warnings: readonly BundleWarning[] }) {
  const n = warnings.length;
  return (
    <span
      data-slot="bundle-warnings"
      title={warnings.map((w) => w.message).join("\n")}
      className="flex shrink-0 items-center gap-0.5 text-[11px] text-attention"
    >
      <TriangleAlertIcon aria-hidden className="size-3" />
      {n}
      <span className="sr-only">
        , {n} {n === 1 ? "warning" : "warnings"}
      </span>
    </span>
  );
}

/**
 * The mark on a bundle's row that its contents were read only in part: the
 * read stopped at a cap (its documents first, its own files after), so more
 * files are there than show.
 */
export function PartialMark() {
  return (
    <span
      data-slot="bundle-partial"
      title="This holds more files than the sidebar lists: the read stopped at its cap."
      className="shrink-0 rounded-sm bg-attention/15 px-1 font-sans text-[10px] font-medium text-attention"
    >
      partial
    </span>
  );
}

/** A file's size as a row shows it: `812 B`, `14 KB`, `3.8 MB`. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Whether a node is one of an expandable bundle's own (its main file,
 * `info.json`, `audio/…`) or a member folder itself: shown, and never
 * renamed, moved or dragged from the tree.
 */
function isOwnNode(root: string, node: ContextNode): boolean {
  const place = bundlePlace(joinPath(root, node.rel));
  return place === "own" || place === "member-folder";
}

/**
 * The folder a drop on a row lands in: a folder's own; an expandable
 * bundle's first member folder (its documents go in it, never beside the
 * bundle, and a member document dropped on its own bundle's row stays where
 * it is); anything else's folder.
 */
export function dropDirOf(root: string, node: ContextNode): string {
  const path = joinPath(root, node.rel);
  if (node.kind === "group") return path;
  if (node.kind === "bundle" && node.contents) {
    const member = bundleTypeOf(node.rel)?.expand?.members[0];
    if (member) return joinPath(path, member);
  }
  return dirOf(path);
}

/** Whether a drop on this row would land in a bundle's own files or folders (refused). */
export function isOwnTarget(root: string, node: ContextNode): boolean {
  if (node.kind === "bundle") return false;
  // A row that is a file drops into its folder: that folder decides.
  const path = joinPath(root, node.rel);
  const folder = node.kind === "group" ? path : dirOf(path);
  // The bundle's own folder (beside its main file and `info.json`) is its type's too.
  return bundlePlace(folder) === "own" || bundleTypeOf(folder) !== null;
}

/**
 * Whether a node opens and shuts in the tree: a group (not a link's, which is
 * never entered), or a bundle whose type expands.
 */
function isFolderNode(node: ContextNode): boolean {
  return (
    (node.kind === "group" && !node.link) || (node.kind === "bundle" && node.contents !== undefined)
  );
}

/** A folder link's row (`link` on a group): shown, never entered, takes nothing. */
export function isLinkNode(
  node: ContextNode,
): node is Extract<ContextNode, { kind: "group" }> & { link: true } {
  return node.kind === "group" && node.link === true;
}

/** How long a pointer rests on an image's row before its thumbnail shows. */
export const PEEK_DELAY_MS = 450;

/**
 * An image row's hover preview: its cached thumbnail beside the row, after the
 * pointer has rested on it a moment, gone when the pointer leaves, presses or
 * drags. Only then is the thumbnail asked for, so a folder of a hundred photos
 * costs nothing until one is looked at. It listens on the row it sits in.
 */
export function ImagePeek({ src }: { src: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // A new source (the file changed) may load where the last one failed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `src` is the trigger.
  useEffect(() => setFailed(false), [src]);
  useEffect(() => {
    const row = anchor.current?.parentElement;
    if (!row) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const r = row.getBoundingClientRect();
        setAt({ left: r.right + 8, top: r.top });
      }, PEEK_DELAY_MS);
    };
    const hide = () => {
      clearTimeout(timer);
      setAt(null);
    };
    row.addEventListener("pointerenter", show);
    row.addEventListener("pointerleave", hide);
    row.addEventListener("pointerdown", hide);
    row.addEventListener("dragstart", hide);
    return () => {
      hide();
      row.removeEventListener("pointerenter", show);
      row.removeEventListener("pointerleave", hide);
      row.removeEventListener("pointerdown", hide);
      row.removeEventListener("dragstart", hide);
    };
  }, []);
  return (
    <span ref={anchor} hidden>
      {at &&
        !failed &&
        createPortal(
          <div
            data-slot="image-peek"
            className="pointer-events-none fixed z-50 rounded-md border border-edge bg-surface p-1 shadow-lg"
            style={{ left: at.left, top: at.top }}
          >
            <img
              src={src}
              alt=""
              // No preview to show (a file that cannot be read): no empty box either.
              onError={() => setFailed(true)}
              className="block max-h-40 max-w-40 rounded-sm"
            />
          </div>,
          document.body,
        )}
    </span>
  );
}
