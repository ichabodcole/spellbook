// Round 7 (TAGS) — the surface-side tag vocabulary. The engine stores freeform
// strings (tags.ts) and validates only SHAPE; CURATION is ours (finding #4 —
// the reuse-suggest autocomplete has ZERO engine support and that's
// intentional): the existing-tag set is derived CLIENT-SIDE, the union of every
// node's and proposal's tags, because the engine keeps no tag registry.

import type { MapNode, Proposal } from "../types";

// One literal chip class — the KIND_BADGE @source discipline (Tailwind's scan
// sees only literal text, so a shared lookup is the reuse unit). Tags are
// freeform, so — unlike doc kinds — there's no per-value palette; every tag
// wears the one neutral plate (both themes via the semantic token).
export const TAG_CHIP = "bg-surface-raised text-ink-dim";

// The existing-tag set: the union of all nodes[].tags + proposals[].tags,
// deduped + sorted (finding #4). absent = none (#3 — an absent key contributes
// nothing, no empty-string bucket).
export function existingTags(nodes: MapNode[], proposals: Proposal[]): string[] {
  const set = new Set<string>();
  for (const n of nodes) for (const t of n.tags ?? []) set.add(t);
  for (const p of proposals) for (const t of p.tags ?? []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Reuse-suggestion autocomplete: the existing tags NOT already on the target,
// filtered by a case-insensitive substring of the query (empty query = every
// unused tag). The surface's curation nudge — reach for an existing tag before
// minting a near-duplicate.
export function tagSuggestions(existing: string[], current: string[], query: string): string[] {
  const have = new Set(current);
  const q = query.trim().toLowerCase();
  return existing.filter((t) => !have.has(t) && (q === "" || t.toLowerCase().includes(q)));
}

// The new tag list after adding one (a PUT replaces wholesale, so the caller
// sends the WHOLE list — this is the "what it should become" rule): trimmed, no
// empties, no dups. Returns the SAME array identity on a no-op (empty / already
// present) so a caller can skip a pointless PUT.
export function addTag(current: string[], tag: string): string[] {
  const t = tag.trim();
  if (!t || current.includes(t)) return current;
  return [...current, t];
}

// The new list after removing a tag (wholesale replace, same as add).
export function removeTag(current: string[], tag: string): string[] {
  return current.filter((t) => t !== tag);
}
