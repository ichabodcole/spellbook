// The neighborhood a lens / select-connected admits: BFS over edges
// (undirected) from a focus node, out to `depth` hops. Extracted from App.tsx
// (R5) so the pure depth-1 derive is unit-testable and shared — visibleMap
// (the node lens), select-connected (SC), and the spotlight intersection (SL)
// all reuse this one adjacency. Takes only `{ edges }` so any board-shaped
// object (state, boardMap, visibleMap) passes.

import type { MapEdge } from "../types";

export function lensSet(map: { edges: MapEdge[] }, nodeId: string, depth: number): Set<string> {
  const adjacent = new Map<string, string[]>();
  for (const e of map.edges) {
    adjacent.set(e.source, [...(adjacent.get(e.source) ?? []), e.target]);
    adjacent.set(e.target, [...(adjacent.get(e.target) ?? []), e.source]);
  }
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adjacent.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

// DIRSELECT (finding #2) — directed depth-1 siblings, distinct from the
// undirected lensSet above: "children" = OUTGOING (edge.source === id →
// target), "parents" = INCOMING (edge.target === id → source). Ruling: a
// `direction:"both"` edge counts for BOTH — a mutual claim makes the neighbor
// a child AND a parent. Always includes the node itself (a select op, like
// select-connected). Depth-1 only.
export function directedSet(
  map: { edges: MapEdge[] },
  nodeId: string,
  dir: "children" | "parents",
): Set<string> {
  const result = new Set([nodeId]);
  for (const e of map.edges) {
    const both = e.direction === "both";
    if (dir === "children") {
      if (e.source === nodeId) result.add(e.target);
      if (both && e.target === nodeId) result.add(e.source);
    } else {
      if (e.target === nodeId) result.add(e.source);
      if (both && e.source === nodeId) result.add(e.target);
    }
  }
  return result;
}
