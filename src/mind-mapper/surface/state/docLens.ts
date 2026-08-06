// Round 3 (Claim V2) — the doc lens's pure half: which nodes a doc admits.
// A node is in the lens iff it carries a SOURCE grounded in that doc
// (isDocSource — message-grounded sources never match a doc lens); edges
// follow at the caller (among admitted nodes only, same rule the node lens
// uses). Marks-but-no-nodes is an honestly EMPTY set — a doc the agent read
// and marked but never extracted from shows nothing, not everything.

import { isDocSource, type MapNode } from "../types";

export function docLensNodeIds(nodes: MapNode[], docId: string): Set<string> {
  const keep = new Set<string>();
  for (const n of nodes) {
    if (n.sources?.some((s) => isDocSource(s) && s.docId === docId)) keep.add(n.id);
  }
  return keep;
}
