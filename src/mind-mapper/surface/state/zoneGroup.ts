// R5 IC-c (group-selected-into-a-zone) — the pure selection rule. Zones hold
// PROPOSALS ONLY (Contract 9 R3), so "group selected into a zone" scopes to the
// PENDING main-queue proposals in the current selection, never ratified nodes.
// The synthetic-node-id-IS-the-proposal-id convention (pendingOverlay) makes
// this a straight id membership test over the inclusive proposals store.

import type { Proposal } from "../types";

// The subset of selectedIds that name a pending, main-queue (un-zoned)
// proposal — the only things a "group into zone" move can carry. Already-zoned
// proposals are excluded (they're not on the main board the selection lives on).
export function selectedPendingProposalIds(proposals: Proposal[], selectedIds: string[]): string[] {
  const eligible = new Set(
    proposals.filter((p) => p.status === "pending" && p.zoneId === null).map((p) => p.id),
  );
  return selectedIds.filter((id) => eligible.has(id));
}
