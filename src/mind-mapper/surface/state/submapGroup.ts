// R6 SUBMAP-CREATE — the pure selection + grouping rules for "group ratified
// nodes under one of them as a submap". The MIRROR IMAGE of group-into-zone
// (zoneGroup.ts): zones hold PROPOSALS ONLY, so that gesture scopes to pending
// synthetics; a submap anchor is REAL-NODES-ONLY (Contract 9 R5 SG1 — anchor is
// a post-ratify act), so THIS gesture scopes to ratified nodes and refuses the
// pending synthetics. The two never overlap (a node is pending XOR ratified).

import type { MapNode, Proposal } from "../types";

// The subset of selectedIds that name a REAL ratified node (present in the
// board's node list AND not a pending synthetic — the synthetic-node-id-IS-
// proposal-id convention means a pending id also appears in `proposals`, so
// we exclude any id that names a pending proposal). Selection order preserved.
// The list the modal shows to pick a parent from; ≥2 gates the affordance
// (one node under itself is not a submap).
export function ratifiedSelection(
  nodes: MapNode[],
  proposals: Proposal[],
  selectedIds: string[],
): MapNode[] {
  const pending = new Set(proposals.filter((p) => p.status === "pending").map((p) => p.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: MapNode[] = [];
  for (const id of selectedIds) {
    if (pending.has(id)) continue;
    const node = byId.get(id);
    if (node && !node.pending) out.push(node);
  }
  return out;
}

// The children to anchor under a chosen parent: every selected node EXCEPT the
// parent itself (a node can't be its own submap root — the engine's anchorGuard
// rejects self-anchor anyway, but never offer a call the daemon refuses).
export function submapChildTargets(selectedNodeIds: string[], parentId: string): string[] {
  return selectedNodeIds.filter((id) => id !== parentId);
}
