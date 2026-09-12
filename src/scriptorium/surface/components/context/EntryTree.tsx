// One set's tree, on @headless-tree/react (the tree study: prefer a
// well-supported library over a hand-built tree; E19 rules the dependency).
// The library owns interaction state — focus, expansion, selection, the ARIA
// tree keyboard pattern, dragging, the rename box — and renders nothing; the
// rows here are ours, styled with the spell's semantic tokens. Data stays the
// daemon's: the loader reads a ref, and a changed entry rebuilds the tree rather
// than being copied into it.
//
// Every change the tree offers is a STRUCTURE OP sent to the daemon (E24), which
// does the real thing on disk and sends the new tree back — the tree never
// edits its own data. Dragging is nesting only (E17: `canReorder: false`, since
// order is a sort, never a position).
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  type ItemInstance,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { cn } from "cn";
import {
  ChevronRightIcon,
  EyeIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HomeIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import type { ContextEntry, ContextNode, StructureOp } from "../../../backend/protocol";
import { carriesFiles, MoveToMenu, RevealItem } from "./menus";
import {
  ancestorsOf,
  baseName,
  dirOf,
  indexTree,
  joinPath,
  type MoveTarget,
  ROOT_ID,
  type TreeIndex,
} from "./model";

const INDENT_PX = 14;

type Node = ContextNode;

/**
 * The sync loader must never answer null or undefined (the library throws
 * "sync dataLoader returned undefined"). The synthetic root gets a real node,
 * and so does an id that left the index — a renamed or moved item — for the
 * one render before `rebuildTree` drops it; such a row renders as nothing.
 */
const ROOT_NODE: ContextNode = { kind: "group", rel: ROOT_ID, children: [] };
const staleNode = (id: string): ContextNode => ({ kind: "doc", rel: id });

/** Select a name's stem, so typing replaces "Untitled", not ".md". */
function selectStem(input: HTMLInputElement) {
  const dot = input.value.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
}

export function EntryTree({
  entry,
  activeRel,
  onOpenDoc,
  onStructure,
  onMove,
  onImportFiles,
  moveTargetsFor,
  renamePath,
  onRenameStarted,
  onMenuKey,
  onReveal,
}: {
  entry: ContextEntry;
  /** The open document's rel within THIS entry, or null. */
  activeRel: string | null;
  onOpenDoc: (rel: string) => void;
  onStructure: (op: StructureOp) => void;
  /** A move the human asked for — a FOLDER move is confirmed first (E26). */
  onMove: (path: string, into: string) => void;
  /** Files dropped from outside the page, to be COPIED into `intoDir` (E23). */
  onImportFiles: (files: DataTransfer, intoDir: string) => void;
  moveTargetsFor: (path: string) => MoveTarget[];
  /** An absolute path to put into rename mode once it is in the tree (a new document or folder). */
  renamePath: string | null;
  onRenameStarted: () => void;
  onMenuKey: (e: KeyboardEvent<HTMLElement>) => void;
  onReveal: (path: string) => void;
}) {
  const index = useMemo(() => indexTree(entry.nodes), [entry.nodes]);
  const indexRef = useRef<TreeIndex>(index);
  indexRef.current = index;
  const pathOf = (id: string) => (id === ROOT_ID ? entry.root : joinPath(entry.root, id));
  /** The folder an item id stands for as a destination: itself if a folder, else its parent. */
  const dirFor = (id: string) => {
    if (id === ROOT_ID) return entry.root;
    const node = indexRef.current.byId.get(id);
    return node?.kind === "group" ? joinPath(entry.root, id) : dirOf(joinPath(entry.root, id));
  };

  const tree = useTree<Node>({
    rootItemId: ROOT_ID,
    // Expand the open document's folders on first render, so it is visible.
    initialState: { expandedItems: activeRel ? ancestorsOf(activeRel) : [] },
    getItemName: (item) =>
      item.getId() === ROOT_ID ? entry.label : baseName(item.getItemData().rel),
    isItemFolder: (item) => item.getItemData().kind === "group",
    dataLoader: {
      getItem: (id) =>
        id === ROOT_ID ? ROOT_NODE : (indexRef.current.byId.get(id) ?? staleNode(id)),
      getChildren: (id) => indexRef.current.children.get(id) ?? [],
    },
    // Opening is the row's own click (below), which a <button> also fires on
    // Enter and Space. Opening here TOO sent `open` twice per keypress (verify
    // pass), so the library's primary action is left to toggle groups only.
    indent: INDENT_PX,
    // ── dragging: nesting only (E17), every drop a real move (E24) ──────────
    canReorder: false,
    canDrop: (items, target) => {
      const into = target.item.getId();
      // Not into itself, and not into anything under itself.
      return !items.some((i) => into === i.getId() || into.startsWith(`${i.getId()}/`));
    },
    onDrop: (items, target) => {
      const into = dirFor(target.item.getId());
      for (const i of items) {
        const path = pathOf(i.getId());
        if (dirOf(path) !== into) onMove(path, into);
      }
    },
    // Files from Finder: a COPY into the folder they were dropped on (E23).
    canDragForeignDragObjectOver: (dt) => carriesFiles(dt),
    canDropForeignDragObject: (dt) => carriesFiles(dt),
    onDropForeignDragObject: (dt, target) => onImportFiles(dt, dirFor(target.item.getId())),
    openOnDropDelay: 600,
    // ── renaming: F2, the menu, or a new item; Enter keeps, Escape drops ────
    canRename: (item) => item.getId() !== ROOT_ID,
    onRename: (item, value) => {
      const name = value.trim();
      if (name && name !== item.getItemName())
        onStructure({ type: "rename", path: pathOf(item.getId()), name });
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
  useEffect(() => {
    tree.rebuildTree();
  }, [index, tree]);

  // A new document or folder arrives in rename mode, its folders opened to show it.
  useEffect(() => {
    if (!renamePath?.startsWith(`${entry.root}/`)) return;
    const rel = renamePath.slice(entry.root.length + 1);
    if (!index.byId.has(rel)) return; // not in this snapshot yet — the next one
    for (const a of ancestorsOf(rel)) tree.getItemInstance(a)?.expand();
    tree.getItemInstance(rel)?.startRenaming();
    onRenameStarted();
  }, [renamePath, index, entry.root, tree, onRenameStarted]);

  // ONE context menu for the whole tree: a row's right-click names its node
  // first, then the event reaches the trigger; the background names none.
  const [menuFor, setMenuFor] = useState<ContextNode | null>(null);
  const [bgDrop, setBgDrop] = useState(false);

  const renameItem = (rel: string) => tree.getItemInstance(rel)?.startRenaming();
  const hiddenCount = entry.hidden?.length ?? 0;

  // A drop on the empty space below the rows lands at the set's top level.
  const onBgDragOver = (e: DragEvent) => {
    if ((e.target as HTMLElement).closest('[role="treeitem"]')) return setBgDrop(false);
    if (!carriesFiles(e.dataTransfer) && !tree.getState().dnd?.draggedItems?.length) return;
    e.preventDefault();
    setBgDrop(true);
  };
  const onBgDrop = (e: DragEvent) => {
    setBgDrop(false);
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
              bgDrop && "bg-rubric/8 ring-1 ring-rubric/40 ring-inset",
            )}
          />
        }
      >
        {items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-dim">
            This folder has no documents yet — right-click to make one, or drop files here.
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
                activeRel={activeRel}
                onOpenDoc={onOpenDoc}
                onMenu={setMenuFor}
                onMenuKey={onMenuKey}
              />
            ))}
          </div>
        )}
        <div className="min-h-8 flex-1" />
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuFor?.kind === "doc" && (
          <ContextMenuItem onClick={() => onOpenDoc(menuFor.rel)}>
            <FileTextIcon />
            Open
          </ContextMenuItem>
        )}
        {menuFor?.kind !== "doc" && (
          <>
            <ContextMenuItem onClick={() => onStructure({ type: "doc.create", dir: menuDir })}>
              <FilePlusIcon />
              New document
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onStructure({ type: "folder.create", dir: menuDir })}>
              <FolderPlusIcon />
              New folder
            </ContextMenuItem>
          </>
        )}
        {menuFor && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => renameItem(menuFor.rel)}>
              <PencilIcon />
              Rename
              <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
            <MoveToMenu
              targets={moveTargetsFor(menuPath)}
              onMove={(into) => onMove(menuPath, into)}
            />
          </>
        )}
        {menuFor?.kind !== "doc" && (
          <ContextMenuItem onClick={() => onStructure({ type: "workspace.set", path: menuDir })}>
            <HomeIcon />
            Use as workspace
          </ContextMenuItem>
        )}
        <RevealItem onReveal={() => onReveal(menuPath)} />
        {!menuFor && hiddenCount > 0 && (
          <ContextMenuItem onClick={() => onStructure({ type: "unhide", entry: entry.id })}>
            <EyeIcon />
            Show {hiddenCount} hidden {hiddenCount === 1 ? "item" : "items"}
          </ContextMenuItem>
        )}
        {menuFor && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onClick={() => onStructure({ type: "hide", path: menuPath })}
            >
              <XIcon />
              Remove from Scriptorium
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Row({
  item,
  stale,
  activeRel,
  onOpenDoc,
  onMenu,
  onMenuKey,
}: {
  item: ItemInstance<Node>;
  /** Gone from the index (renamed, moved) — the next rebuild drops it. */
  stale: boolean;
  activeRel: string | null;
  onOpenDoc: (rel: string) => void;
  onMenu: (node: ContextNode) => void;
  onMenuKey: (e: KeyboardEvent<HTMLElement>) => void;
}) {
  if (stale) return null;
  const node = item.getItemData();
  const level = item.getItemMeta().level;
  const isGroup = node.kind === "group";
  const isActive = !isGroup && node.rel === activeRel;
  const props = item.getProps();
  const rowClass = cn(
    "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-sm text-ink-dim outline-none",
    "hover:bg-surface-raised hover:text-ink",
    "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
    item.isFocused() && "bg-surface-raised/60",
    isActive && "bg-rubric/12 font-medium text-ink",
    item.isDragTarget() && "bg-rubric/15 text-ink ring-1 ring-rubric/50 ring-inset",
  );
  const icon = isGroup ? (
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
      <span aria-hidden className="size-3.5 shrink-0" />
      <FileTextIcon
        aria-hidden
        className={cn("size-4 shrink-0", isActive ? "text-rubric" : "text-ink-faint")}
      />
    </>
  );
  const style = { paddingLeft: `${8 + level * INDENT_PX}px` };

  // Renaming: the row is a plain element holding the library's input — an
  // input inside a <button> would have its Space and clicks taken by the button.
  if (item.isRenaming()) {
    const input = item.getRenameInputProps();
    return (
      <div style={style} className={rowClass}>
        {icon}
        <input
          {...input}
          // biome-ignore lint/a11y/noAutofocus: the human asked to rename this row (F2, the menu, or a new item).
          autoFocus
          onFocus={(e) => selectStem(e.currentTarget)}
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
        props.onClick?.(e);
        // A single click opens a document (a sidebar, not a file manager);
        // on a group the library's own click already toggled it.
        if (!isGroup) onOpenDoc(node.rel);
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
      className={rowClass}
    >
      {icon}
      <span className="truncate">{item.getItemName()}</span>
    </button>
  );
}
