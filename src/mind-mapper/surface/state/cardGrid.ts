// V1 — the grid view's grouping rule, pure and tested: tier first (canon →
// background, the same top-down weight the map's visual hierarchy carries),
// then kind within (people before places before abstractions). Empty groups
// are omitted — the grid renders what exists, never scaffolding. Node order
// within a kind preserves input order (the wire's order is the story order).

import type { MapNode, NodeKind, Tier } from "../types";

export const TIER_ORDER: readonly Tier[] = ["canon", "thread", "story-local", "background"];
export const KIND_ORDER: readonly NodeKind[] = ["cast", "place", "concept", "thread"];

export type KindGroup = { kind: NodeKind; nodes: MapNode[] };
export type TierGroup = { tier: Tier; kinds: KindGroup[] };

export function groupByTierKind(nodes: MapNode[]): TierGroup[] {
  const out: TierGroup[] = [];
  for (const tier of TIER_ORDER) {
    const inTier = nodes.filter((n) => n.tier === tier);
    if (inTier.length === 0) continue;
    const kinds: KindGroup[] = [];
    for (const kind of KIND_ORDER) {
      const inKind = inTier.filter((n) => n.kind === kind);
      if (inKind.length > 0) kinds.push({ kind, nodes: inKind });
    }
    out.push({ tier, kinds });
  }
  return out;
}
