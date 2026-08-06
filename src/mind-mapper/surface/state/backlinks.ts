// BACKLINKS (finding #6) — the inverse of the node→doc source jump: given a
// doc, which nodes/proposals cite it? Ruled CLIENT-DERIVE (zero engine): the
// forward links already ride /state (`nodes[].sources[].docId`,
// `proposals[].evidence.docId`), so backlinks are a pure derivation —
// auto-maintained by construction, no stored/duplicated field.
//
// Ratified and pending are kept DISTINCT: a ratified node cites via a real
// `sources[]` DocSourceRef; a pending proposal cites via its evidence. A
// ratified proposal has already become a node (counted via sources), and a
// rejected one is gone — so only PENDING proposals count on the proposal side.

import type { MapNode, Proposal } from "../types";
import { isDocSource } from "../types";

export type Backlink = { id: string; title: string };
export type Backlinks = { ratified: Backlink[]; pending: Backlink[] };

export function backlinksFor(docId: string, nodes: MapNode[], proposals: Proposal[]): Backlinks {
  const ratified = nodes
    .filter((n) => (n.sources ?? []).some((s) => isDocSource(s) && s.docId === docId))
    .map((n) => ({ id: n.id, title: n.title }));
  const pending = proposals
    .filter((p) => p.status === "pending" && p.evidence.docId === docId)
    .map((p) => ({
      id: p.id,
      title: typeof p.draft.title === "string" ? p.draft.title : "(untitled)",
    }));
  return { ratified, pending };
}
