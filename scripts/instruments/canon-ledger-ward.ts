#!/usr/bin/env bun
// canon-ledger-ward — does every house-style.md rule have a decay-ledger row?
//
// ⛔ DELIBERATELY NOT A `.test.ts`. A test file is COLLECTED by `bun test` the
// moment it exists, so an in-progress or mis-pathed ward turns a PEER's live
// gate red. Run it explicitly:
//
//     bun scripts/instruments/canon-ledger-ward.ts            # exits 1 on violation
//     CANON_DIR=/some/fixture bun scripts/instruments/canon-ledger-ward.ts
//
// ── WHY THE MATCHER IS TOLERANT, AND WHY IT MUST ALSO BE INJECTIVE ──────────
// Measured: EXACT matches of rule-heading against ledger-row are 0 of 17. The
// ledger's first column is a hand-abbreviated paraphrase BY DESIGN. So a
// byte-exact ward fails all 17 rows of a CORRECT ledger — an inverted control,
// dispatching someone to "fix" working canon.
//
// But tolerance alone is DECORATION, and this was measured too: with an
// INDEPENDENT best-match per rule, deleting a real ledger row left the ward
// GREEN, because a tolerant matcher always finds SOME row sharing a token.
// Pairing must CONSUME the row. 17 rules against 16 rows then leaves exactly
// one rule unpaired, which is the defect.
//
// Exactness and injectivity are SEPARATE properties. A stable rule key (a4)
// buys the first only; this ward still needs the second.
//
// ── WHAT THIS WARD CANNOT SEE ───────────────────────────────────────────────
//   • It pins the PAIRING, not the CONTENT. A row whose "last reinforced" date
//     is a lie reads green.
//   • It cannot check that a rule has a CHECK — criterion 2's other half, and
//     r5 ruled intent-bearing rules unmechanizable as written.
//   • The `####` clauses are NOT counted as rules here, deliberately: the
//     ledger keys rows on TOP-LEVEL rules and covers clauses via their parent.
//     That is correct for THIS question and wrong for a rules-vs-checks ward.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CANON = process.env.CANON_DIR ?? join(import.meta.dir, "..", "..", "grimoire");
const STOP = new Set([
  "with",
  "that",
  "this",
  "from",
  "your",
  "their",
  "never",
  "only",
  "than",
  "into",
  "when",
]);

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));

// EVERY FILTER THIS INSTRUMENT APPLIES, declared as data so it can be PRINTED
// rather than living in a comment. An unpublished filter makes a correct result
// unreproducible: a reader re-running the raw scan gets a different number and
// nothing explains the gap.
const FILTERS = [
  "rules: `^### ` headings only — `####` clauses are covered by their parent's row (see header)",
  "ledger rows: first table column, minus the header row and the `---` separator",
  "tokens: lowercased, non-alphanumerics stripped, words <=3 chars and a 11-word stoplist dropped",
  "pairing: INJECTIVE — each ledger row is consumed by at most one rule",
];

function rules(): string[] {
  const src = readFileSync(join(CANON, "house-style.md"), "utf8");
  return [...src.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
}

function ledgerRows(): string[] {
  const src = readFileSync(join(CANON, "decay-ledger.md"), "utf8");
  return [...src.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
    .map((m) => m[1].trim())
    .filter((r) => r && !/^-+$/.test(r) && !/^Rule\b/.test(r));
}

const rs = rules();
const rows = ledgerRows();

console.log(`canon dir: ${CANON}`);
console.log(
  "FILTERS APPLIED (published because an unpublished filter makes a correct result unreproducible):",
);
for (const f of FILTERS) console.log(`  - ${f}`);
console.log(`\nDENOMINATOR  rules=${rs.length}  ledgerRows=${rows.length}`);

// ZERO-DENOMINATOR GUARD, BOTH SIDES. A two-sided diff has two denominators;
// guarding one feels like guarding the check. A parse returning [] would
// otherwise report a perfect pairing of nothing.
if (rs.length === 0 || rows.length === 0) {
  console.error("PRECONDITION FAILED — a side parsed zero. Verdict withheld.");
  process.exit(1);
}

const pool = rows.map((w) => ({ w, t: new Set(tokens(w)), used: false }));
const unmatched: string[] = [];
const ambiguous: string[] = [];

const ranked = rs
  .map((r) => {
    const rt = tokens(r);
    return { r, best: Math.max(0, ...pool.map((p) => rt.filter((t) => p.t.has(t)).length)) };
  })
  .sort((a, b) => b.best - a.best);

for (const { r } of ranked) {
  const rt = tokens(r);
  const scored = pool
    .filter((p) => !p.used)
    .map((p) => ({ p, ov: rt.filter((t) => p.t.has(t)).length }))
    .sort((a, b) => b.ov - a.ov);
  if (!scored.length || scored[0].ov === 0) {
    unmatched.push(r);
    continue;
  }
  if (scored[1] && scored[0].ov === scored[1].ov) {
    ambiguous.push(`${r}  ->  «${scored[0].p.w}» vs «${scored[1].p.w}»`);
  }
  scored[0].p.used = true;
}
const orphanRows = pool.filter((p) => !p.used).map((p) => p.w);

// Report the SETS, never a total — a count is silent on SUBSTITUTION (one out,
// one in, total unchanged, membership changed).
const bad = unmatched.length + ambiguous.length + orphanRows.length;
console.log(
  `\nunmatched rules : ${unmatched.length}${unmatched.map((x) => `\n  - ${x}`).join("")}`,
);
console.log(`ambiguous pairs : ${ambiguous.length}${ambiguous.map((x) => `\n  - ${x}`).join("")}`);
console.log(
  `orphan rows     : ${orphanRows.length}${orphanRows.map((x) => `\n  - ${x}`).join("")}`,
);
console.log(bad === 0 ? "\nPASS" : "\nFAIL");
process.exit(bad === 0 ? 0 : 1);
