// Round 7 (FILTER) — the faceted filter control: a Panel-perch button that
// opens a popover of Status / Tier / Tags facet chips. Multi-select, AND-across
// / OR-within (the pure rule lives in state/filter.ts). App owns the filter
// state (so map + grid share one control) and derives filteredMap terminal to
// the board chain; this is just the chrome. Semantic tokens only, both themes.
//
// drive7 #3 — ported from a hand-rolled `open` div to the vendored Popover
// (Base UI): outside-click + Escape dismiss for free (the exact bug Cole hit).
// A Popover, not a DropdownMenu, because the facet chips are STAY-OPEN toggles
// — a Menu.Item closes on click, the wrong grammar for a multi-select facet
// list.

import { Filter as FilterIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { TIER_LABEL } from "./GraphCanvas";
import {
  activeFilterCount,
  type FilterFacets,
  type MapFilter,
  type NodeStatus,
  toggleFacet,
} from "./state/filter";
import type { Tier } from "./types";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const STATUS_LABEL: Record<NodeStatus, string> = {
  ratified: "ratified",
  pending: "pending",
};

// A facet chip: filled at its own token when active, an outline plate when not.
function FacetChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
        active
          ? "border-ink bg-secondary text-ink"
          : "border-edge text-ink-dim hover:border-ink-faint hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

export function FilterControl({
  filter,
  facets,
  onFilter,
}: {
  filter: MapFilter;
  facets: FilterFacets;
  onFilter: (next: MapFilter) => void;
}) {
  const count = activeFilterCount(filter);
  // Nothing to filter (a single-node board with no tiers/tags variety) — hide
  // the control entirely rather than open an empty popover.
  const hasFacets = facets.statuses.length > 0 || facets.tiers.length > 0 || facets.tags.length > 0;
  if (!hasFacets) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="auto"
            className={`flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wide ${
              count > 0 ? "text-ink" : "text-ink-dim"
            }`}
            title="Filter the board by status, tier, or tag"
          >
            <FilterIcon size={11} aria-hidden />
            filter{count > 0 ? ` · ${count}` : ""}
          </Button>
        }
      />
      <PopoverContent className="w-56">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-ink-faint">filter</span>
          {count > 0 && (
            <button
              type="button"
              onClick={() => onFilter({ status: [], tier: [], tags: [] })}
              className="flex items-center gap-0.5 text-[10px] text-ink-dim hover:text-attention"
            >
              <X size={10} /> clear
            </button>
          )}
        </div>
        {facets.statuses.length > 0 && (
          <FacetGroup label="Status">
            {facets.statuses.map((s) => (
              <FacetChip
                key={s}
                label={STATUS_LABEL[s]}
                active={filter.status.includes(s)}
                onToggle={() => onFilter({ ...filter, status: toggleFacet(filter.status, s) })}
              />
            ))}
          </FacetGroup>
        )}
        {facets.tiers.length > 0 && (
          <FacetGroup label="Tier">
            {facets.tiers.map((t: Tier) => (
              <FacetChip
                key={t}
                label={TIER_LABEL[t]}
                active={filter.tier.includes(t)}
                onToggle={() => onFilter({ ...filter, tier: toggleFacet(filter.tier, t) })}
              />
            ))}
          </FacetGroup>
        )}
        {facets.tags.length > 0 && (
          <FacetGroup label="Tags">
            {facets.tags.map((t) => (
              <FacetChip
                key={t}
                label={t}
                active={filter.tags.includes(t)}
                onToggle={() => onFilter({ ...filter, tags: toggleFacet(filter.tags, t) })}
              />
            ))}
          </FacetGroup>
        )}
      </PopoverContent>
    </Popover>
  );
}

function FacetGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-[9px] uppercase tracking-widest text-ink-faint">{label}</div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}
