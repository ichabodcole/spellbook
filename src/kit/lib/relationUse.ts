// How the world's typed links use each relation between kinds: what the link
// picker ranks relations by (`rankRelations` in `document/linkInsert.ts`), for
// a link written in a document, and what an app ranks them by for a link
// between two things it shows (Atlas's board connections). Pure, so the
// daemon builds it and a surface reads it.

/**
 * A relation as typed, made fit for `?rel=`: whitespace runs become one hyphen
 * (the vocabulary's own shape, `contrasts-with`), and anything outside the
 * characters a relation is read with (`lib/linkTarget.ts`, `RELATION`:
 * letters, combining marks, digits, `_`, `.`, `-`, starting with a letter or
 * digit) is dropped. Case is kept as typed: `?rel=` is case-folded on read.
 * A `(`, `)` or `'` would end or break the link it is written into. Empty when
 * nothing is left. The link picker writes a typed relation with it, and an app
 * makes a new relation's key from a label with it.
 */
export function normaliseRelation(typed: string): string {
  return typed
    .trim()
    .replace(/[\s,]+/gu, "-")
    .replace(/[^\p{L}\p{M}\p{N}_.-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[\p{M}_.-]+|[_.-]+$/gu, "");
}

/**
 * How many typed links carry relation `rel` from a document of kind `from`
 * (null: one with no kind) into a document of kind `kind`. One entry per
 * (from, kind, rel) seen.
 */
export type KindPairUse = { from: string | null; kind: string; rel: string; links: number };

/**
 * How the links into documents of one kind use one relation: `links` of them
 * in all, `fromKind` of those written in a document of one given kind. The
 * shape the link picker's ranking reads.
 */
export type KindUse = { kind: string; rel: string; links: number; fromKind: number };

/** Count one typed link into `pairs`, keyed by from kind, to kind and relation. */
export function countPair(
  pairs: Map<string, KindPairUse>,
  from: string | null,
  kind: string,
  rel: string,
): void {
  const key = JSON.stringify([from, kind, rel]);
  const had = pairs.get(key);
  if (had) had.links++;
  else pairs.set(key, { from, kind, rel, links: 1 });
}

/**
 * The pairs folded for a link written from a document of kind `fromKind` (null:
 * none): per target kind and relation, every link into that kind, and those
 * from `fromKind`. In the order each (kind, relation) is first seen.
 */
export function kindUseFrom(pairs: readonly KindPairUse[], fromKind: string | null): KindUse[] {
  const out = new Map<string, KindUse>();
  for (const p of pairs) {
    const key = `${p.kind}\0${p.rel}`;
    const had = out.get(key) ?? { kind: p.kind, rel: p.rel, links: 0, fromKind: 0 };
    had.links += p.links;
    if (fromKind !== null && p.from === fromKind) had.fromKind += p.links;
    out.set(key, had);
  }
  return [...out.values()];
}
