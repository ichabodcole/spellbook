// Round 7 (SUBMAPPEND, finding #5) — the PENDING-group case: select ≥2 pending
// proposals, pick one as the parent (or an existing real node), and ratify the
// whole group into a submap in the surface's FIRST ratify-batch call (the R6
// endpoint). One top-level ruling — the human picks the group's tier ONCE,
// sidestepping the per-proposal-tier problem. anchors resolve pending-or-real
// via the batch's idMap. The "empty submap under a node" gesture is DEFERRED
// (the intent-composer path — the surface can't anchor a lone pending node).

import type { Proposal } from "../types";

// The ruling picked once for the whole group (reject is excluded — reject
// removes a proposal from the batch, it's not a group tier).
export type BatchRuling = "canon" | "thread" | "story-local";

// The pending, main-queue, NODE proposals in the selection — the ONLY things a
// ratify-batch-into-submap can carry: an edge proposal has no anchor, and a
// zoned proposal can't ratify while zoned (Contract 9 R3 "promote first"). The
// synthetic-node-id-IS-proposal-id convention makes this an id-membership test.
export function pendingNodeProposalIds(proposals: Proposal[], selectedIds: string[]): string[] {
  const eligible = new Set(
    proposals
      .filter((p) => p.status === "pending" && p.zoneId === null && p.kind === "node")
      .map((p) => p.id),
  );
  return selectedIds.filter((id) => eligible.has(id));
}

// The ratify-batch payload nesting the group under a parent. `ids` = ALL the
// pending node proposals (each ratified under the one top-level ruling);
// `anchors` = every NON-parent child under `parentRef`. Works whether the
// parent is one of the pending ids (idMap resolves it to its just-minted node)
// or an EXISTING real node id (resolveNodeRef passes it through) — in both cases
// the batch endpoint resolves anchors via idMap-then-real (Contract 9 R6).
export function buildSubmapAppend(
  pendingIds: string[],
  parentRef: string,
): { ids: string[]; anchors: { node: string; parent: string }[] } {
  const children = pendingIds.filter((id) => id !== parentRef);
  return {
    ids: pendingIds,
    anchors: children.map((node) => ({ node, parent: parentRef })),
  };
}
