// P2.4 — pending overlay (plan/circe.md P2.4): the daemon never marks a
// ratified node/edge `pending` (only the proposals table holds staging
// data), so the overlay the spike hand-authored in stub data now has to be
// DERIVED — a proposal becomes a synthetic MapNode/MapEdge with `pending:
// true`, merged alongside the real ones. GraphCanvas's existing pending
// styling (border-dashed, the pending badge, animated/tinted edges) needs no
// change — only the data source does, per the plan.
//
// `draft` is opaque JSON to the daemon (Claim A: it doesn't validate the
// agent's extraction) — every field here is read defensively, never trusted.

import type { MapEdge, MapNode, NodeKind, Proposal, Tier } from "../types";

const NODE_KINDS: NodeKind[] = ["cast", "place", "concept", "thread"];
const TIERS: Tier[] = ["canon", "thread", "story-local", "background"];

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function pendingNodesFrom(proposals: Proposal[]): MapNode[] {
  return proposals
    .filter((p) => p.status === "pending" && p.kind === "node")
    .map((p) => {
      const d = p.draft;
      const kind = NODE_KINDS.includes(d.kind as NodeKind) ? (d.kind as NodeKind) : "concept";
      const tier = TIERS.includes(p.suggestedTier) ? p.suggestedTier : "thread";
      return {
        id: p.id,
        title: str(d.title, "untitled proposal"),
        kind,
        tier,
        synopsis: str(d.synopsis),
        pending: true,
        // PROC (R6): a pending author:"user" proposal is raw human input the
        // agent will curate — flag it so the canvas renders a distinct
        // "curating" state (client-only, off the wire's `author`; no schema
        // change). Absent on agent proposals (a normal pending sketch).
        processing: p.author === "user",
        // Claim E: evidence grounds in a doc OR a message (mutually
        // exclusive at intake) — either becomes the synthetic node's source.
        sources: p.evidence.docId
          ? [{ docId: p.evidence.docId, span: p.evidence.span ?? undefined }]
          : p.evidence.messageId
            ? [{ messageId: p.evidence.messageId, span: p.evidence.span ?? undefined }]
            : undefined,
        // TAGS (R7, finding #2): tags ride the proposal from creation, so the
        // synthetic pending node copies them straight from the snapshot — a
        // pending card shows its chips on first paint, not only after tags.set.
        // absent = none (#3): only a non-empty list lands.
        ...(p.tags && p.tags.length > 0 ? { tags: p.tags } : {}),
      };
    });
}

// EF (finding #8): a ratified node proposal carries its minted node id as
// `resultNodeId` (R5 wire). Build a proposalId→nodeId map so pendingEdgesFrom
// can re-point a still-pending edge that was drafted against the OLD proposal
// id — otherwise the instant the endpoint ratifies the edge names a non-node
// id, renders to nothing, and (its ids being non-empty) slips past the
// emptiness filter below: the edge silently dangles and vanishes.
export function resultNodeIdMap(proposals: Proposal[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of proposals) {
    if (p.resultNodeId) m.set(p.id, p.resultNodeId);
  }
  return m;
}

// An edge proposal whose draft omits a real source/target is unrenderable —
// dropped rather than shown as a dangling half-edge. `resolve` (EF) re-points
// each endpoint proposalId → minted nodeId BEFORE the drop-filter, so an edge
// keeps rendering (as a pending edge to the now-real node) once its endpoint
// node proposal ratifies. Omitted = no re-point (the zone view, where a zoned
// proposal can't ratify while zoned — Contract 9 R3 "promote first").
export function pendingEdgesFrom(proposals: Proposal[], resolve?: Map<string, string>): MapEdge[] {
  const repoint = (id: string) => resolve?.get(id) ?? id;
  return proposals
    .filter((p) => p.status === "pending" && p.kind === "edge")
    .map((p) => {
      const d = p.draft;
      return {
        id: p.id,
        source: repoint(str(d.source)),
        target: repoint(str(d.target)),
        label: str(d.label),
        provenance: "asserted" as const,
        pending: true,
      };
    })
    .filter((e) => e.source && e.target);
}
