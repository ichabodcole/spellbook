// R5 SG2 (submap navigation) — the pure client-side derives. Ratified
// CLIENT-SIDE (circe falsified the server-scoped lean): the surface consumes
// the INCLUSIVE snapshot (every node tagged anchorNodeId, SG1) and derives
// both the submap view and the breadcrumb here — a server `?anchor=` scope
// would hide the ancestors the breadcrumb parent-walk needs.
//
// Slots between zone and lens in App's board chain
// (mapWithPending → zoneMapFrom → submapView → visibleMap): activeAnchor is
// view-local App state, parallel to activeZone.

import type { MapEdge, MapNode } from "../types";

// Synthetic pending nodes (pendingOverlay / zoneView) carry no anchor — they
// read as top-level (a proposal stays top-level until ratified, SG1).
const anchorOf = (n: MapNode): string | null => n.anchorNodeId ?? null;

// The submap view: activeAnchor null = the top-level board (nodes with no
// anchor); a node id = that node's submap (its direct children PLUS the anchor
// node itself as the submap's root/context). Edges keep the both-endpoints-
// visible rule zoneMapFrom and visibleMap already use.
export function submapView(
  map: { nodes: MapNode[]; edges: MapEdge[] },
  activeAnchor: string | null,
): { nodes: MapNode[]; edges: MapEdge[] } {
  const nodes =
    activeAnchor === null
      ? map.nodes.filter((n) => anchorOf(n) === null)
      : map.nodes.filter((n) => anchorOf(n) === activeAnchor || n.id === activeAnchor);
  const present = new Set(nodes.map((n) => n.id));
  const edges = map.edges.filter((e) => present.has(e.source) && present.has(e.target));
  return { nodes, edges };
}

// The breadcrumb: a client parent-walk up anchorNodeId from the active anchor
// to the root, returned ROOT-FIRST (root ▸ … ▸ anchor) for rendering. The
// engine's anchor.ts already forbids cycles, but a defensive `seen` guard
// keeps this honest if the wire ever lies. [] when top-level (no anchor). A
// missing ancestor (not in the loaded snapshot) simply ends the walk.
export function breadcrumbTrail(nodes: MapNode[], activeAnchor: string | null): MapNode[] {
  if (!activeAnchor) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trail: MapNode[] = [];
  const seen = new Set<string>();
  let cur: string | null = activeAnchor;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    trail.push(node);
    cur = anchorOf(node);
  }
  return trail.reverse();
}
