import { Archive, ArchiveRestore, Maximize2 } from "lucide-react";
import { itemsByKind, type MarkFilter, matchesMarks } from "../state/reduce";
import type { FocusScope, ItemKind, LibraryItem } from "../state/types";
import { LibraryTile } from "./LibraryTile";

export function LibraryGrid({
  library,
  facet,
  selectedIds,
  onSelect,
  onEnlarge,
  onArchive,
  scope,
  focusSet,
  showArchived = false,
  markFilter,
}: {
  library: LibraryItem[];
  facet: ItemKind | "all";
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onEnlarge: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  scope: FocusScope;
  focusSet: string[];
  showArchived?: boolean;
  markFilter?: MarkFilter;
}) {
  const liveItems =
    scope === "focus"
      ? library.filter((i) => focusSet.includes(i.id) && !i.archived)
      : itemsByKind(library, facet);

  const withArchived =
    showArchived && scope !== "focus"
      ? [
          ...liveItems,
          ...library.filter((i) => i.archived && (facet === "all" || i.kind === facet)),
        ]
      : liveItems;

  // Mark filters (liked/starred/pinned) compose as a union on top of facet +
  // archived; with none active, everything passes.
  const items = markFilter ? withArchived.filter((i) => matchesMarks(i, markFilter)) : withArchived;

  const click = (id: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      onSelect(
        selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
      );
    } else {
      onSelect(selectedIds.length === 1 && selectedIds[0] === id ? [] : [id]);
    }
  };

  if (items.length === 0)
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
        drop references or context files to begin
      </div>
    );

  const gridCols =
    scope === "focus" ? "grid-cols-2 gap-4" : "grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3";

  return (
    <div className={`grid flex-1 content-start overflow-y-auto p-5 ${gridCols}`}>
      {items.map((it) => (
        <div key={it.id} className={`group relative${it.archived ? " opacity-50" : ""}`}>
          <LibraryTile
            item={it}
            selected={selectedIds.includes(it.id)}
            onClick={(e) => click(it.id, e)}
          />
          <div className="absolute right-1 top-1 flex gap-1">
            {(it.kind === "gen" || it.kind === "ref") && !it.archived && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEnlarge(it.id);
                }}
                aria-label="enlarge"
                className="rounded bg-black/50 p-1 text-white/80 opacity-0 transition hover:bg-black/70 group-hover:opacity-100"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}
            {it.archived ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive(it.id, false);
                }}
                aria-label="unarchive"
                className="rounded bg-black/50 p-1 text-white/80 opacity-0 transition hover:bg-black/70 group-hover:opacity-100"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive(it.id, true);
                }}
                aria-label="archive"
                className="rounded bg-black/50 p-1 text-white/80 opacity-0 transition hover:bg-black/70 group-hover:opacity-100"
              >
                <Archive className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {it.kind === "gen" && (
            <div className="pointer-events-none absolute left-1 top-1 flex flex-col items-start gap-0.5">
              <span className="rounded-full bg-violet-600/80 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white">
                generated
              </span>
              {it.gen && (
                <span className="rounded-full bg-violet-900/70 px-1.5 py-0.5 text-[8px] text-violet-200">
                  round {it.gen.round}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
