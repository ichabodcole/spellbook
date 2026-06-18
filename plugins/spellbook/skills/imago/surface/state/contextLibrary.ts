import type { ContextEntry, ContextKind } from "./types";

// Resolve an ordered id list (a linked set) against the library, in set order,
// dropping ids that no longer resolve (deleted entries).
export function resolveSet(library: ContextEntry[], ids: string[]): ContextEntry[] {
  const byId = new Map(library.map((e) => [e.id, e]));
  return ids.map((id) => byId.get(id)).filter((e): e is ContextEntry => e !== undefined);
}

export function entriesByKind(library: ContextEntry[], kind: ContextKind): ContextEntry[] {
  return library.filter((e) => e.kind === kind);
}

export function isLinked(ids: string[], id: string): boolean {
  return ids.includes(id);
}
