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
        // Claim E: evidence grounds in a doc OR a message (mutually
        // exclusive at intake) — either becomes the synthetic node's source.
        sources: p.evidence.docId
          ? [{ docId: p.evidence.docId, span: p.evidence.span ?? undefined }]
          : p.evidence.messageId
            ? [{ messageId: p.evidence.messageId, span: p.evidence.span ?? undefined }]
            : undefined,
      };
    });
}

// An edge proposal whose draft omits a real source/target is unrenderable —
// dropped rather than shown as a dangling half-edge.
export function pendingEdgesFrom(proposals: Proposal[]): MapEdge[] {
  return proposals
    .filter((p) => p.status === "pending" && p.kind === "edge")
    .map((p) => {
      const d = p.draft;
      return {
        id: p.id,
        source: str(d.source),
        target: str(d.target),
        label: str(d.label),
        provenance: "asserted" as const,
        pending: true,
      };
    })
    .filter((e) => e.source && e.target);
}
