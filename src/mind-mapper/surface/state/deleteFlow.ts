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

// Round 6 (DEL) — the NODE delete's cited-guard shape. Distinct from the doc
// delete above: a node's citing set is the edges touching it + the children
// anchored under it (docs.ts's CitedError precedent, different fields). Same
// discrimination discipline — a null return means "not a recognizable
// node-cited-409" so App degrades to the generic notice, never fabricated
// counts. On force, the edges are dropped and the children re-parented to
// top-level (they're real ratified knowledge — never recursively deleted).
export type NodeCitedBy = { edges: number; children: number };

export function parseNodeCitedBody(body: unknown): NodeCitedBy | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { error?: unknown; citedBy?: unknown };
  if (b.error !== "cited") return null;
  if (typeof b.citedBy !== "object" || b.citedBy === null) return null;
  const c = b.citedBy as { edges?: unknown; children?: unknown };
  if (typeof c.edges !== "number" || typeof c.children !== "number") return null;
  return { edges: c.edges, children: c.children };
}
