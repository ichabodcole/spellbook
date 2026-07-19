// Round 3 (Claim Z3) — the zone view's pure half, and the main view's
// segregation rule. The store is INCLUSIVE (every proposal present, tagged
// with zoneId — Claim Z1 as ruled), so snapshot merge and event upsert obey
// ONE rule and this module is where views diverge: the main board consumes
// `mainProposals` (zoneId == null), a zone view consumes `zoneMapFrom` (that
// zone's proposals only). Because BOTH ingestion points feed the same store,
// this single filter IS the both-ingestion-points segregation — there is no
// second place for a zoned row to leak into the main view from.

import type { MapEdge, MapNode, Proposal } from "../types";
import { pendingEdgesFrom, pendingNodesFrom } from "./pendingOverlay";

// The main board's slice of the inclusive store: main-queue rows only.
// Everything main-view — pending overlay, review queue, review badge count —
// derives from THIS, never from state.proposals directly.
export function mainProposals(proposals: Proposal[]): Proposal[] {
  return proposals.filter((p) => p.zoneId === null);
}

// A zone view is the SAME canvas fed that zone's proposals, rendered
// UN-DASHED (ruled: staging styling exists to mark not-yet-canon against
// ratified neighbors; inside a zone everything is staging, so the mark
// carries no information). Suppression happens HERE, at derivation — a data
// overlay, not a render special-case: the canvas keeps one rendering rule.
//
// A zoned edge proposal may reference real (ratified) nodes as endpoints —
// those endpoints are pulled into the view so the claim is renderable
// (they keep their full-strength styling; they're not zone contents, just
// context). An edge whose endpoint resolves to nothing in the view is
// dropped, same as the main overlay's dangling-half-edge rule.
export function zoneMapFrom(
  proposals: Proposal[],
  zoneId: string,
  realNodes: MapNode[],
): { nodes: MapNode[]; edges: MapEdge[] } {
  const zoned = proposals.filter((p) => p.zoneId === zoneId);
  const nodes = pendingNodesFrom(zoned).map((n) => ({ ...n, pending: false }));
  const present = new Set(nodes.map((n) => n.id));

  const edges = pendingEdgesFrom(zoned).map((e) => ({ ...e, pending: false }));
  const context: MapNode[] = [];
  for (const e of edges) {
    for (const end of [e.source, e.target]) {
      if (present.has(end)) continue;
      const real = realNodes.find((n) => n.id === end);
      if (real) {
        context.push(real);
        present.add(end);
      }
    }
  }

  return {
    nodes: [...nodes, ...context],
    edges: edges.filter((e) => present.has(e.source) && present.has(e.target)),
  };
}

// The zone an id belongs to, if the id names a PENDING proposal in the
// inclusive store: `undefined` = not a proposal (a real node — no view
// switch to make), `null` = main-queue proposal, a string = its zone. This
// is the agent-follow rule's lookup (lens.set / look.here / search hits
// targeting a zoned element switch to its zone before focusing — co-presence
// over view-stickiness).
export function zoneOf(proposals: Proposal[], id: string): string | null | undefined {
  const p = proposals.find((x) => x.id === id && x.status === "pending");
  return p ? p.zoneId : undefined;
}
