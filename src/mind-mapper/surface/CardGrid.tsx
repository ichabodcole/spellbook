// V1 — the card grid: the same board as plain HTML cards, grouped
// tier-then-kind (state/cardGrid.ts, pure + tested). Equal-capabilities by
// construction: it consumes the SAME visibleMap (lens already narrowed it)
// and the SAME matches (search dims here exactly as on the canvas), and
// pending proposals arrive pre-merged wearing their staging styling. The
// node-card vocabulary (TIER_CARD / KIND_ICON / TIER_LABEL) is imported
// from GraphCanvas, never duplicated — one lookup, two views. Card click =
// select (NodeDetail opens via the existing selection derivation); grid
// state is view-local, not board state.

import { KIND_ICON, TIER_CARD, TIER_LABEL } from "./GraphCanvas";
import { groupByTierKind } from "./state/cardGrid";
import type { StubMap } from "./types";

export function CardGrid({
  map,
  highlightIds,
  selectedIds,
  onSelect,
}: {
  map: StubMap;
  // Same contract as GraphCanvas: null = no search active; otherwise the ids
  // that match — everything else dims.
  highlightIds?: string[] | null;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
}) {
  const groups = groupByTierKind(map.nodes);
  const keep = highlightIds ? new Set(highlightIds) : null;

  if (groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-xs text-ink-faint">
        nothing on the board yet — the map view is where ideas land.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-bg p-4 pb-16">
      {groups.map((group) => (
        <section key={group.tier} className="mb-5">
          <h2 className="mb-2 text-[10px] uppercase tracking-widest text-ink-faint">
            {TIER_LABEL[group.tier]}
          </h2>
          {group.kinds.map((kindGroup) => {
            const Icon = KIND_ICON[kindGroup.kind];
            return (
              <div key={kindGroup.kind} className="mb-3">
                <h3 className="mb-1.5 flex items-center gap-1 text-[10px] text-ink-faint">
                  <Icon size={10} aria-hidden />
                  {kindGroup.kind}
                </h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
                  {kindGroup.nodes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => onSelect([n.id])}
                      className={`rounded-lg border bg-surface px-3 py-2 text-left shadow-lg transition-all ${TIER_CARD[n.tier]} ${
                        n.pending ? "border-dashed" : ""
                      } ${selectedIds.includes(n.id) ? "ring-2 ring-ink shadow-xl" : ""} ${
                        keep && !keep.has(n.id) ? "opacity-20" : ""
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest">
                        <span>{TIER_LABEL[n.tier]}</span>
                        {n.pending && (
                          <span className="ml-auto rounded-sm border border-dashed border-pending px-1 normal-case tracking-normal text-pending">
                            proposed
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-story text-[15px] leading-tight text-ink">
                        {n.title}
                      </div>
                      {n.synopsis && (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-dim">
                          {n.synopsis}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
