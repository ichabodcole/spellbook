// R4 Claim G1 (ratified, zero-engine-change) — the send-time ground bundle.
// Doc "selection" state does not exist; the honest mapping is: the OPEN doc
// IS the rail selection. So the bundle is the union of the board's selected
// node/proposal ids (bare ids — Contract 9 grammar: bare = node OR
// pending-proposal ref, no `proposal:` prefix minted) and the open doc as a
// `doc:<id>` ref, deduped, selection order preserved, doc ref last. Returns
// [] when nothing grounds the message — the caller (App's sendMessage)
// already normalizes [] → omitted, today's wire behavior unchanged. This is
// the single choke point's logic, pure and tested apart from React.

export function groundBundle(selectedIds: string[], openDocId: string | null): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push(id);
  }
  if (openDocId) refs.push(`doc:${openDocId}`);
  return refs;
}
