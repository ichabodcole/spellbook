// R12 SEAM 6 (drive #10 F4) — orphan visibility.
//
// The finding: the agent proposed nodes AND edges, the human ratified only the
// nodes, the agent then deleted its stale pending proposals (the edges with
// them) and re-proposed without the edges. Five canon nodes sat completely
// disconnected and NOTHING said so — the human caught it by eye.
//
// CLIENT-SIDE, no wire change: `/state` already carries nodes, edges and the
// full proposal set (incl. `resultNodeId`, the R5/R6 field the EF re-point
// already leans on), so this is a degree check plus one join.
//
// The honesty rule — why this does NOT cry wolf during normal use. The
// ordinary flow is "ratify the nodes, then their edges a moment later", and an
// edge proposal CANNOT ratify before its endpoints (the daemon's
// "ratify node proposal <id> first" error). So a just-ratified node is
// routinely, briefly edge-less — and a naive degree check would fire on every
// single ratification. It doesn't here because a still-PENDING edge proposal
// naming the node (through the same proposalId→nodeId re-point pendingEdgesFrom
// uses) counts as connection INTENT. The marker therefore appears only when the
// intent is gone — which is exactly, and only, the drive-#10 failure shape.
//
// Two further quieting conditions, both deliberate:
//   - submap containment is connection (an anchored child, or a parent holding
//     children, is structurally placed — flagging it would be a second wolf);
//   - a board with fewer than two ratified nodes has no orphans (there is
//     nothing to be connected TO; the first node on a fresh map is not a
//     mistake).

import type { MapEdge, MapNode, Proposal } from "../types";
import { pendingEdgesFrom, resultNodeIdMap } from "./pendingOverlay";

// `nodes`/`edges` are the RAW wire entities (state.nodes / state.edges — real
// ratified rows), `proposals` the FULL inclusive proposal set. Zone-blind on
// purpose: a pending edge drafted inside a sandbox is still someone intending
// to connect this node, and this signal is a nudge, not an audit.
export function orphanNodeIds(
  nodes: MapNode[],
  edges: MapEdge[],
  proposals: Proposal[],
): Set<string> {
  const ratified = nodes.filter((n) => !n.pending);
  // Nothing to be connected to — an orphan is only meaningful in a graph.
  if (ratified.length < 2) return new Set();

  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }
  // Connection INTENT: a still-pending edge proposal, its endpoints re-pointed
  // proposalId → minted nodeId exactly as the canvas re-points them (EF).
  for (const e of pendingEdgesFrom(proposals, resultNodeIdMap(proposals))) {
    connected.add(e.source);
    connected.add(e.target);
  }

  const orphans = new Set<string>();
  for (const n of ratified) {
    if (connected.has(n.id)) continue;
    if (n.anchorNodeId) continue;
    if ((n.submapChildCount ?? 0) > 0) continue;
    orphans.add(n.id);
  }
  return orphans;
}
