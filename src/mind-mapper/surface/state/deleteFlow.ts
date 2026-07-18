// V1.x Claim A — the two-stage delete flow's pure half. The unforced DELETE
// either succeeds (200) or answers 409 {error:"cited", citedBy:{nodes,
// proposals}} via the engine's typed CitedError; the SAME dialog escalates
// to a provenance stage rendering those counts, and force re-issues. This
// module owns the untrusted-body parse — the fetch glue stays in App.

export type CitedBy = { nodes: number; proposals: number };

// Strict on the load-bearing fields, silent-null on anything else: a null
// return means "not a recognizable cited-409" and the caller degrades to
// the generic error notice rather than rendering fabricated counts.
export function parseCitedBody(body: unknown): CitedBy | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { error?: unknown; citedBy?: unknown };
  if (b.error !== "cited") return null;
  if (typeof b.citedBy !== "object" || b.citedBy === null) return null;
  const c = b.citedBy as { nodes?: unknown; proposals?: unknown };
  if (typeof c.nodes !== "number" || typeof c.proposals !== "number") return null;
  return { nodes: c.nodes, proposals: c.proposals };
}
