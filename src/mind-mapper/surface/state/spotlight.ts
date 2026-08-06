// R5 SL (spotlight lens) — the pure derive. Given 2+ selected nodes, find the
// connections they SHARE: the depth-1 neighbors common to every selected node.
// The surface then dims everything except the lit set — the selected nodes,
// their shared neighbors, and the edges joining them — so a "who do these both
// know?" question answers itself visually.
//
// Distinct from the lens (which HIDES): the spotlight DIMS, on its own channel,
// and adds NEW edge-dim plumbing (GraphCanvas) that the lens never needed.
// Intersection only — heat mode and promote-to-overlap are out of scope.
//
// Lit edges = the subgraph INDUCED by the lit nodes (both endpoints lit). The
// joining selected→shared-neighbor edges are exactly this subset; computing the
// induced set means a bright node-pair never shows a dim edge between them.
// Returns null for <2 selected (nothing to intersect) so the caller can treat
// "no spotlight" as one falsy value.

import type { MapEdge } from "../types";
import { lensSet } from "./neighborhood";

export type Spotlight = { nodes: Set<string>; edges: Set<string> };

export function computeSpotlight(
  map: { edges: MapEdge[] },
  selectedIds: string[],
): Spotlight | null {
  if (selectedIds.length < 2) return null;

  // Each selected node's depth-1 neighbors (excluding itself).
  const neighborSets = selectedIds.map((id) => {
    const s = lensSet(map, id, 1);
    s.delete(id);
    return s;
  });
  // Shared = intersection of every selected node's neighbor set.
  let shared = new Set(neighborSets[0]);
  for (const ns of neighborSets.slice(1)) {
    shared = new Set([...shared].filter((x) => ns.has(x)));
  }

  const nodes = new Set<string>([...selectedIds, ...shared]);
  const edges = new Set<string>();
  for (const e of map.edges) {
    if (nodes.has(e.source) && nodes.has(e.target)) edges.add(e.id);
  }
  return { nodes, edges };
}
