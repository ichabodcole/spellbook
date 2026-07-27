// V1.x Claim G — the ground-ref prefix grammar, ratified: `ground[]`
// entries are a prefixed vocabulary, opaque to the engine end-to-end
// (stored and returned verbatim). Bare id = node ref (today's behavior);
// `doc:<id>` = doc ref (strip the prefix, resolve against docs[]);
// anything unresolvable drops silently (today's .filter(Boolean) behavior,
// kept — a stale or unknown ref must never crash a bubble).

// R11 SEAM 4 adds a THIRD prefix: `zone:<id>` = the board the human was
// looking at when they sent (the Z3 carry-over — see groundBundle.ts). It is
// still opaque to the engine; only this resolver and MessageBubble know it, and
// an unknown/deleted zone drops silently like every other stale ref.

import type { DocMeta, MapNode, Zone } from "../types";
import { ZONE_GROUND_PREFIX } from "./messageChannel";

export type ResolvedGroundRef =
  | { type: "node"; node: MapNode }
  | { type: "doc"; doc: DocMeta }
  | { type: "zone"; zone: Zone };

export function resolveGroundRef(
  ref: string,
  nodes: MapNode[],
  docs: DocMeta[],
  zones: Zone[] = [],
): ResolvedGroundRef | null {
  if (ref.startsWith("doc:")) {
    const doc = docs.find((d) => d.id === ref.slice("doc:".length));
    return doc ? { type: "doc", doc } : null;
  }
  if (ref.startsWith(ZONE_GROUND_PREFIX)) {
    const zone = zones.find((z) => z.id === ref.slice(ZONE_GROUND_PREFIX.length));
    return zone ? { type: "zone", zone } : null;
  }
  const node = nodes.find((n) => n.id === ref);
  return node ? { type: "node", node } : null;
}
