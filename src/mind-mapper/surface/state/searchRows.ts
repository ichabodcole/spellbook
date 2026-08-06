// Round 3 (Claim S1) — the palette's pure half: server hits resolve into
// renderable rows WITHOUT losing their kind (the old memo flattened
// everything to MapNode and threw proposal/doc/message hits away — kinds
// must survive the memo, ratified). A row always carries a full node shape
// (the palette renders tier/title off it): node hits resolve against the
// ratified nodes, proposal hits against the pending synthetic nodes the
// overlay already derives — the proposal id IS the synthetic node id, which
// is what lets the existing focusRequest path land on a pending element
// unchanged. Doc/message hits don't render as rows (the palette's contract
// is find-a-map-element) but they COUNT: the no-results state names them
// instead of pretending the search found nothing at all.

import type { MapNode, SearchHit } from "../types";

export type PaletteRow = {
  kind: "node" | "proposal";
  node: MapNode;
  // Proposal rows only: null = main queue, a string = the zone the palette
  // must switch to before focusing. Always null on node rows.
  zoneId: string | null;
};

export type OffBoardCounts = { docs: number; messages: number };

export function paletteRows(
  hits: SearchHit[],
  nodes: MapNode[],
  pendingNodes: MapNode[],
): { rows: PaletteRow[]; offBoard: OffBoardCounts } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pendingById = new Map(pendingNodes.map((n) => [n.id, n]));
  const rows: PaletteRow[] = [];
  const offBoard: OffBoardCounts = { docs: 0, messages: 0 };
  for (const hit of hits) {
    if (hit.kind === "node") {
      const node = byId.get(hit.id);
      if (node) rows.push({ kind: "node", node, zoneId: null });
    } else if (hit.kind === "proposal") {
      // Unresolvable proposal hits drop silently: an edge proposal (no
      // synthetic node) or a hit that raced a ruling — a row that can't
      // focus anything would be a dead button.
      const node = pendingById.get(hit.id);
      if (node) rows.push({ kind: "proposal", node, zoneId: hit.zoneId ?? null });
    } else if (hit.kind === "doc") {
      offBoard.docs += 1;
    } else if (hit.kind === "message") {
      offBoard.messages += 1;
    }
    // Unknown kinds (the reserved "vector", anything newer): ignored, never
    // a crash — same tolerance the reducer gives unknown event kinds.
  }
  return { rows, offBoard };
}
