// Round 5 (SG1) — node-anchored submaps. A node's `anchor_node_id` is its
// parent in a strict containment tree (null = top-level). Anchor is
// REAL-NODES-ONLY: proposals stay top-level until ratified, `ratify()` is
// UNCHANGED, and anchoring is a separate post-ratify act (the `node anchor`
// verb). Orthogonal to zone_id. The daemon stays dumb (Contract 8): this is a
// storage move guarded against cycles, nothing more.
//
// The guard is an ancestor-walk from the PROPOSED parent: if walking parent
// links ever reaches `nodeId`, the anchor would make nodeId its own ancestor
// (a cycle). A defensive `seen` set breaks out of any pre-existing cycle so a
// corrupt store can't spin the walk forever. Rejects: self-anchor, direct
// cycle, deep cycle, unknown parent, unknown node. `parentId === null` (clear)
// is always safe.

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";

// A typed error so the server can map anchor failures to 400 without
// string-matching (the CitedError/ZonedError family).
class AnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorError";
  }
}

function anchorGuard(db: Database, nodeId: string, parentId: string | null): void {
  if (!db.query("SELECT 1 FROM nodes WHERE id = ?").get(nodeId)) {
    throw new AnchorError(`unknown node: ${nodeId}`);
  }
  if (parentId === null) return; // clear is always safe
  if (parentId === nodeId) throw new AnchorError("a node cannot anchor to itself");
  if (!db.query("SELECT 1 FROM nodes WHERE id = ?").get(parentId)) {
    throw new AnchorError(`unknown anchor target: ${parentId}`);
  }
  // Walk ancestors of the proposed parent; hitting nodeId means this anchor
  // would close a cycle.
  let cur: string | null = parentId;
  const seen = new Set<string>();
  while (cur !== null) {
    if (cur === nodeId) {
      throw new AnchorError(`cycle: ${nodeId} is already an ancestor of ${parentId}`);
    }
    if (seen.has(cur)) break; // defensive: a pre-existing cycle can't loop us
    seen.add(cur);
    const row = db.query("SELECT anchor_node_id FROM nodes WHERE id = ?").get(cur) as {
      anchor_node_id: string | null;
    } | null;
    cur = row?.anchor_node_id ?? null;
  }
}

// Returns the {nodeId, anchorNodeId} it wrote (the event payload shape). Throws
// AnchorError on any guard failure. Emits `node.anchored` (thin — consumers
// flip the node's anchorNodeId locally, then may refetch derived counts).
function anchorNode(
  db: Database,
  bus: EventBus,
  nodeId: string,
  parentId: string | null,
): { nodeId: string; anchorNodeId: string | null } {
  anchorGuard(db, nodeId, parentId);
  db.run("UPDATE nodes SET anchor_node_id = ? WHERE id = ?", [parentId, nodeId]);
  bus.emit("node.anchored", { nodeId, anchorNodeId: parentId });
  return { nodeId, anchorNodeId: parentId };
}

export { AnchorError, anchorGuard, anchorNode };
