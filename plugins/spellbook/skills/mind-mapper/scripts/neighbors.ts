// P3 — `neighbors <nodeId> [--depth 1]` backing: depth-bounded BFS over
// edges in both directions (edges are directed claims; "neighbors" means
// anything connected, not just outgoing per plan.md). Skeleton-shaped
// response (id/title/edge reason) — no synopsis, context-budgeting.

import type { Database } from "bun:sqlite";

interface NeighborEdgeRef {
  edgeId: string;
  label: string;
  direction: "outgoing" | "incoming";
}

interface Neighbor {
  id: string;
  title: string;
  depth: number;
  via: NeighborEdgeRef;
}

function neighbors(db: Database, nodeId: string, depth: number): Neighbor[] {
  const allEdges = db.query("SELECT id, source, target, label FROM edges").all() as Array<{
    id: string;
    source: string;
    target: string;
    label: string;
  }>;
  const titleById = new Map(
    (db.query("SELECT id, title FROM nodes").all() as Array<{ id: string; title: string }>).map(
      (n) => [n.id, n.title],
    ),
  );

  const visited = new Map<string, Neighbor>();
  let frontier = [nodeId];
  const seen = new Set([nodeId]);

  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of allEdges) {
        let neighborId: string | null = null;
        let direction: "outgoing" | "incoming" | null = null;
        if (edge.source === current) {
          neighborId = edge.target;
          direction = "outgoing";
        } else if (edge.target === current) {
          neighborId = edge.source;
          direction = "incoming";
        }
        if (!neighborId || seen.has(neighborId)) continue;
        seen.add(neighborId);
        next.push(neighborId);
        visited.set(neighborId, {
          id: neighborId,
          title: titleById.get(neighborId) ?? neighborId,
          depth: d,
          via: {
            edgeId: edge.id,
            label: edge.label,
            direction: direction as "outgoing" | "incoming",
          },
        });
      }
    }
    frontier = next;
  }

  return [...visited.values()];
}

export type { Neighbor, NeighborEdgeRef };
export { neighbors };
