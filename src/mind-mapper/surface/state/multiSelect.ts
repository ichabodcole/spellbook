// drive7 #6A — the selection-aware context menu's pure logic. When ≥2 nodes are
// selected, right-clicking a node surfaces the MULTI-node actions (Cole: "actions
// near the nodes, not up in a list of buttons at the top"), and the right-clicked
// node is the DESIGNATED parent/anchor for the submap gestures — resolving them
// INLINE (no parent-pick modal). This derives, for a given clicked node, which
// multi-actions are valid with THAT node as the parent, over the current
// selection. Mirrors the existing top-bar gates (zoneGroup / submapGroup /
// submapAppend) but keyed per-clicked-node so the menu knows what to offer.

import type { MapNode, Proposal } from "../types";
import { pendingNodeProposalIds } from "./submapAppend";
import { ratifiedSelection } from "./submapGroup";
import { selectedPendingProposalIds } from "./zoneGroup";

export type MultiSelectActions = {
  // "Group under this as submap" — anchor the OTHER selected ratified nodes
  // under the clicked one (real-nodes-only, main board). Valid iff ≥2 ratified
  // nodes are selected AND the clicked node is one of them (a valid anchor).
  groupSubmap: boolean;
  // "Nest under this as submap ▸" (tier flyout) — ratify-batch the selected
  // pending node proposals into a submap under the clicked one. Valid iff ≥2
  // pending main-queue node proposals are selected AND the clicked one is among
  // them (the batch's parent).
  nestSubmap: boolean;
  // "Group selected into a zone…" — move the selected pending main-queue
  // proposals into a zone (opens the zone dialog; no parent needed, so the
  // clicked node need not be eligible — it just triggers). Valid iff ≥1 such
  // proposal is selected.
  groupZone: boolean;
};

// Returns the multi-actions valid for `clickedId` given the current selection,
// or null when none apply (so a renderer can skip the whole section). All
// submap gestures are main-board-only (a zone view holds proposals, not
// ratified nodes; a zoned proposal can't ratify while zoned).
export function multiSelectActions(
  clickedId: string,
  selectedIds: string[],
  nodes: MapNode[],
  proposals: Proposal[],
  activeZone: string | null,
): MultiSelectActions | null {
  if (selectedIds.length < 2) return null;
  if (activeZone !== null) return null;
  // The multi-menu surfaces on a node that is PART of the selection — right-
  // clicking an unrelated node keeps its single-node menu (Cole: actions near
  // the selected nodes). The clicked node designates the submap parent/anchor.
  if (!selectedIds.includes(clickedId)) return null;

  const ratified = ratifiedSelection(nodes, proposals, selectedIds);
  const pendingNodes = pendingNodeProposalIds(proposals, selectedIds);
  const pendingAny = selectedPendingProposalIds(proposals, selectedIds);

  const groupSubmap = ratified.length >= 2 && ratified.some((n) => n.id === clickedId);
  const nestSubmap = pendingNodes.length >= 2 && pendingNodes.includes(clickedId);
  const groupZone = pendingAny.length >= 1;

  if (!groupSubmap && !nestSubmap && !groupZone) return null;
  return { groupSubmap, nestSubmap, groupZone };
}
