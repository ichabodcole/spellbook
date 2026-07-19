// Round 3 (Claim Z1) — the zone-delete confirm flow's pure half, mirroring
// deleteFlow.ts: the unforced DELETE /zones/:id either succeeds (200) or
// answers 409 {error:"zone-not-empty", proposals: n} via the engine's typed
// ZoneNotEmptyError; the SAME dialog escalates to a provenance stage
// rendering that count (deleting a populated zone discards its proposals
// wholesale — the disposable-sandbox property deserves a stated cost), and
// the confirmed retry re-issues with ?yes=1. This module owns the
// untrusted-body parse — the fetch glue stays in App.

export type ZoneNotEmpty = { proposals: number };

// Strict on the load-bearing fields, silent-null on anything else: a null
// return means "not a recognizable zone-not-empty 409" and the caller
// degrades to the generic error notice rather than rendering a fabricated
// count.
export function parseZoneNotEmptyBody(body: unknown): ZoneNotEmpty | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { error?: unknown; proposals?: unknown };
  if (b.error !== "zone-not-empty") return null;
  if (typeof b.proposals !== "number") return null;
  return { proposals: b.proposals };
}
