// R4 Claim G1 (ratified, zero-engine-change) — the send-time ground bundle.
// Doc "selection" state does not exist; the honest mapping is: the OPEN doc
// IS the rail selection. So the bundle is the union of the board's selected
// node/proposal ids (bare ids — Contract 9 grammar: bare = node OR
// pending-proposal ref, no `proposal:` prefix minted) and the open doc as a
// `doc:<id>` ref, deduped, selection order preserved, doc ref last. Returns
// [] when nothing grounds the message — the caller (App's sendMessage)
// already normalizes [] → omitted, today's wire behavior unchanged. This is
// the single choke point's logic, pure and tested apart from React.

import { ZONE_GROUND_PREFIX } from "./messageChannel";

// R11 SEAM 4 — the zone carry. A canvas ramble made while a zone board is
// showing used to land IN that zone (Z3 placement honesty); a MESSAGE has no
// zone, so rather than drop that meaning silently it rides as a `zone:<id>`
// ground ref. Contract 9's ground grammar is a prefixed vocabulary the engine
// stores VERBATIM and consumers tolerate-and-drop when unknown — so this is
// zero engine change and degrades to invisible everywhere that doesn't know
// it. It is CONTEXT ("I was working in this sandbox"), never a placement
// command: the agent still decides where anything it proposes lands (L2).
export function groundBundle(
  selectedIds: string[],
  openDocId: string | null,
  zoneId: string | null = null,
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push(id);
  }
  if (openDocId) refs.push(`doc:${openDocId}`);
  if (zoneId) refs.push(`${ZONE_GROUND_PREFIX}${zoneId}`);
  return refs;
}
