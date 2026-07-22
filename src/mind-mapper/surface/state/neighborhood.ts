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
