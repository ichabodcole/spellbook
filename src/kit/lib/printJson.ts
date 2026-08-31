/**
 * The house's one-line JSON emitter — ONE implementation, imported by every
 * spell that speaks the agent wire.
 *
 * ⛔ THIS FILE IS `src/kit/`'s FIRST INHABITANT, and that is load-bearing beyond
 * the sharing it does. Ward 2 ("the kit is a leaf") has been green by
 * CONSTRUCTION since Phase 0 — it had nothing to walk, and said so on every
 * run. This module is the first thing it actually guards, which is why the
 * ward's zero-guard cell distinguishes an ABSENT kit from an EMPTY one.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/` — not a spell,
 * not a surface, not a backend. That is ward 2's assertion, not a convention,
 * and it is what makes the kit safe to inline into any spell's bundle.
 *
 * Deliberately dependency-free and deliberately dull: it is bundled INTO each
 * spell's emitted CLI (Contract 4's built-backend amendment), so anything it
 * reached for would become a dependency of two shipped artifacts at once.
 *
 * The wire contract it encodes: exactly one JSON document, one trailing
 * newline, nothing else on stdout. A caller reading our stdout with a
 * line-delimited parser depends on that newline; a caller reading to EOF
 * depends on there being no second document.
 */
export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}
