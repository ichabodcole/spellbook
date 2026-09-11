// One context entry's tree, on @headless-tree/react (the tree study: prefer a
// well-supported library over a hand-built tree; E19 rules the dependency).
// The library owns interaction state — focus, expansion, selection, the ARIA
// tree keyboard pattern — and renders nothing; the rows here are ours, styled
// with the spell's semantic tokens. Data stays the daemon's: the loader reads a
// ref, and a changed entry rebuilds the tree rather than being copied into it.
//
// ⚠ Deliberately NOT here yet, and the reason is sequencing, not an oversight:
// drag-and-drop between groups, rename, and new document / new group. The
// library carries all three (`dragAndDropFeature` with `canReorder: false` per
// E17, `renamingFeature`); they arrive with the daemon verbs that make them real
// filesystem moves.
import { hotkeysCoreFeature, selectionFeature, syncDataLoaderFeature } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { cn } from "cn";
import { ChevronRightIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { ContextEntry, ContextNode } from "../../../backend/protocol";
import { ancestorsOf, baseName, indexTree, ROOT_ID, type TreeIndex } from "./model";

const INDENT_PX = 14;

export function EntryTree({
  entry,
  activeRel,
  onOpenDoc,
}: {
  entry: ContextEntry;
  /** The open document's rel within THIS entry, or null. */
  activeRel: string | null;
  onOpenDoc: (rel: string) => void;
}) {
  const index = useMemo(() => indexTree(entry.nodes), [entry.nodes]);
  const indexRef = useRef<TreeIndex>(index);
  indexRef.current = index;
  const openRef = useRef(onOpenDoc);
  openRef.current = onOpenDoc;

  const tree = useTree<ContextNode | null>({
    rootItemId: ROOT_ID,
    // Expand the open document's folders on first render, so it is visible.
    initialState: { expandedItems: activeRel ? ancestorsOf(activeRel) : [] },
    getItemName: (item) => {
      const node = item.getItemData();
      return node ? baseName(node.rel) : entry.label;
    },
    isItemFolder: (item) => {
      const node = item.getItemData();
      return node === null || node.kind === "group";
    },
    dataLoader: {
      getItem: (id) => (id === ROOT_ID ? null : (indexRef.current.byId.get(id) ?? null)),
      getChildren: (id) => indexRef.current.children.get(id) ?? [],
    },
    // Enter / double-click on a document opens it; on a group it toggles.
    onPrimaryAction: (item) => {
      const node = item.getItemData();
      if (node?.kind === "doc") openRef.current(node.rel);
    },
    indent: INDENT_PX,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  // The entry changed on disk (a mirrored folder gained a file): rebuild from the new index.
  useEffect(() => {
    tree.rebuildTree();
  }, [index, tree]);

  const items = tree.getItems();
  if (items.length === 0) {
    return <p className="px-3 py-4 text-xs text-ink-faint">This folder has no documents yet.</p>;
  }

  return (
    <div
      {...tree.getContainerProps(`${entry.label} documents`)}
      className="flex flex-col py-1 outline-none"
    >
      {items.map((item) => {
        const node = item.getItemData();
        if (!node) return null;
        const level = item.getItemMeta().level;
        const isGroup = node.kind === "group";
        const isActive = !isGroup && node.rel === activeRel;
        const props = item.getProps();
        return (
          <button
            {...props}
            key={item.getId()}
            type="button"
            onClick={(e) => {
              props.onClick?.(e);
              // A single click opens a document (a sidebar, not a file manager);
              // on a group the library's own click already toggled it.
              if (!isGroup) onOpenDoc(node.rel);
            }}
            style={{ paddingLeft: `${8 + level * INDENT_PX}px` }}
            data-active={isActive || undefined}
            className={cn(
              "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-sm text-ink-dim outline-none",
              "hover:bg-surface-raised hover:text-ink",
              "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
              item.isFocused() && "bg-surface-raised/60",
              isActive && "bg-surface-raised font-medium text-ink",
            )}
          >
            {isGroup ? (
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
            )}
            <span className="truncate">{item.getItemName()}</span>
          </button>
        );
      })}
    </div>
  );
}
