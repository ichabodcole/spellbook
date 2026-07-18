// V1.x Claim G — the ground-ref prefix grammar, ratified: `ground[]`
// entries are a prefixed vocabulary, opaque to the engine end-to-end
// (stored and returned verbatim). Bare id = node ref (today's behavior);
// `doc:<id>` = doc ref (strip the prefix, resolve against docs[]);
// anything unresolvable drops silently (today's .filter(Boolean) behavior,
// kept — a stale or unknown ref must never crash a bubble).

import type { DocMeta, MapNode } from "../types";

export type ResolvedGroundRef = { type: "node"; node: MapNode } | { type: "doc"; doc: DocMeta };

export function resolveGroundRef(
  ref: string,
  nodes: MapNode[],
  docs: DocMeta[],
): ResolvedGroundRef | null {
  if (ref.startsWith("doc:")) {
    const doc = docs.find((d) => d.id === ref.slice("doc:".length));
    return doc ? { type: "doc", doc } : null;
  }
  const node = nodes.find((n) => n.id === ref);
  return node ? { type: "node", node } : null;
}
