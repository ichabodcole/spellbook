// Round 7 (FILTER, finding #8) — a faceted filter that HIDES non-matching nodes
// (distinct from spotlight's DIM). Pure over the wire, no new endpoint: Status
// derives from n.pending (there's NO literal status field, and rejected never
// renders on canvas so there's no "rejected" facet); Tier = n.tier; Tags = the
// R7 wire. Semantics: AND across facets, OR within a facet. Empty filter =
// everything. Terminal to the board chain (App: … → visibleMap → filteredMap),
// so it rides R6 mergeLayout (a filter change is a map change → positions +
// selection preserved).

import type { StubMap, Tier } from "../types";

// The two statuses a rendered node can be (rejected never reaches the canvas).
// pending = a synthetic proposal node; ratified = a real node (no pending flag).
export type NodeStatus = "ratified" | "pending";

// R12 SEAM 6 — the orphan facet. A one-value axis (there is no useful
// "connected" filter), present-only: the group renders ONLY while the board
// actually holds an unconnected node, so the chip doubles as the glanceable
// count and the R11 convention's present-only corollary holds. Orphan-ness is
// a property of the WHOLE graph, so the set is computed upstream
// (state/orphans.ts) and passed IN — never re-derived from the view slice,
// where a cross-slice edge would look like no edge at all.
export type ConnectionFacet = "unconnected";

export type MapFilter = {
  status: NodeStatus[];
  tier: Tier[];
  tags: string[];
  connection: ConnectionFacet[];
};

export const EMPTY_FILTER: MapFilter = { status: [], tier: [], tags: [], connection: [] };

export function isEmptyFilter(f: MapFilter): boolean {
  return (
    f.status.length === 0 && f.tier.length === 0 && f.tags.length === 0 && f.connection.length === 0
  );
}

export function activeFilterCount(f: MapFilter): number {
  return f.status.length + f.tier.length + f.tags.length + f.connection.length;
}

// No literal status field on the wire — a synthetic pending node carries
// pending:true; a real ratified node doesn't.
export function statusOf(node: { pending?: boolean }): NodeStatus {
  return node.pending ? "pending" : "ratified";
}

// AND across facets (a node must satisfy every non-empty facet), OR within a
// facet (any listed value passes). An empty facet is no constraint. Edges are
// kept iff BOTH endpoints survive (a filtered-out endpoint drops its edges).
export function filterMap(map: StubMap, f: MapFilter, orphanIds?: ReadonlySet<string>): StubMap {
  if (isEmptyFilter(f)) return map;
  const statusSet = new Set(f.status);
  const tierSet = new Set(f.tier);
  const tagSet = new Set(f.tags);
  const orphansOnly = f.connection.includes("unconnected");
  const nodes = map.nodes.filter((n) => {
    if (statusSet.size > 0 && !statusSet.has(statusOf(n))) return false;
    if (tierSet.size > 0 && !tierSet.has(n.tier)) return false;
    if (tagSet.size > 0 && !(n.tags ?? []).some((t) => tagSet.has(t))) return false;
    if (orphansOnly && !orphanIds?.has(n.id)) return false;
    return true;
  });
  const keep = new Set(nodes.map((n) => n.id));
  const edges = map.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  return { ...map, nodes, edges };
}

// The facet OPTIONS the control offers — only values PRESENT on the (pre-filter)
// map, so no empty bucket is ever shown (finding #3's spirit): statuses in a
// fixed order, tiers in the canonical tier order, tags sorted.
const STATUS_ORDER: NodeStatus[] = ["ratified", "pending"];
const TIER_ORDER: Tier[] = ["canon", "thread", "story-local", "background"];

export type FilterFacets = {
  statuses: NodeStatus[];
  tiers: Tier[];
  tags: string[];
  // How many of THESE nodes are unconnected — 0 hides the facet entirely
  // (present-only), and the number is the glanceable count itself.
  unconnected: number;
};

export function filterFacets(map: StubMap, orphanIds?: ReadonlySet<string>): FilterFacets {
  const statusesPresent = new Set(map.nodes.map(statusOf));
  const tiersPresent = new Set(map.nodes.map((n) => n.tier));
  const tags = new Set<string>();
  for (const n of map.nodes) for (const t of n.tags ?? []) tags.add(t);
  return {
    statuses: STATUS_ORDER.filter((s) => statusesPresent.has(s)),
    tiers: TIER_ORDER.filter((t) => tiersPresent.has(t)),
    tags: [...tags].sort((a, b) => a.localeCompare(b)),
    unconnected: orphanIds ? map.nodes.filter((n) => orphanIds.has(n.id)).length : 0,
  };
}

// Toggle one value in a facet array (add if absent, remove if present) — the
// pure state transition the control's chips drive.
export function toggleFacet<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
