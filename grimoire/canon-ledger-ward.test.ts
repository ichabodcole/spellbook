// enforces: none in house-style — decay-ledger.md's "How it works": every house-style rule has a ledger row
//
// canon-ledger-ward — does every house-style.md rule have a decay-ledger row, and
// does every row name a rule?
//
// ⭐ MOVED INTO `bun test` ON 2026-09-27 (sprint 06 phase 2), from
// `scripts/instruments/canon-ledger-ward.ts`, where it ran under nothing: not the
// suite, not the gate, not CI (docs/items/canon-ledger-ward-runs-under-nothing.md).
// It had been kept out on purpose — a `.test.ts` is collected the moment it
// exists, so an in-progress ward reds a peer's gate — but "run it by hand" had no
// owner and no occasion, and it passed over a real defect once while unrun.
//
// ⭐ KEYED ON THE LEDGER'S `Rule id` COLUMN, NOT ON TITLES. The instrument paired
// headings to rows by fuzzy token overlap, injectively, because the ledger's
// first column is a hand-abbreviated paraphrase (exact title matches were 0 of
// 17). That matcher once reported a perfect pairing over a stale row: a rule's id
// changed, its row did not, and the new heading still shared the word `build`
// with the dead row. The ledger now carries each rule's id, and rule-id.test.ts
// guarantees the ids on the other side, so the pairing is exact and injective by
// construction: a row either names a rule's id or it does not.
//
// ── WHAT THIS WARD CANNOT SEE ───────────────────────────────────────────────
//   · It pins the PAIRING, not the CONTENT. A row whose "last reinforced" date
//     is a lie, or whose paraphrase no longer matches its rule, reads green.
//   · It cannot check that a rule has a CHECK. That is rule-check-link.test.ts.
//   · `####` clauses are NOT rules here, deliberately: the ledger keys rows on
//     TOP-LEVEL rules and covers clauses through their parent. A row keyed on a
//     clause id fails, because it would be a second row for one parent. Correct
//     for THIS question and wrong for a rules-vs-checks ward, which counts them.
//   · Only the table whose header carries a `Rule id` cell is read. A reworded
//     header yields zero rows, which the denominator guard reds.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { must } from "./lib/must.ts";

const HOUSE_STYLE = join(import.meta.dir, "house-style.md");
const LEDGER = join(import.meta.dir, "decay-ledger.md");

type Heading = { line: number; depth: number; id: string };

// rule-id.test.ts's predicate: a `###`/`####` heading with its id in the next
// three lines. A heading with no id is rule-id's failure, not this ward's.
function headings(): Heading[] {
  const lines = readFileSync(HOUSE_STYLE, "utf8").split("\n");
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = must(lines[i], `lines[${i}] absent inside 0..${lines.length}`);
    const m = /^(#{3,4}) .+$/.exec(line);
    if (!m) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const ahead = must(lines[j], `lines[${j}] absent inside 0..${lines.length}`);
      const idm = /^<!-- rule-id: (.+?) -->$/.exec(ahead.trim());
      if (idm) {
        out.push({
          line: i + 1,
          depth: must(m[1], "heading matcher matched without its hashes group").length,
          id: must(idm[1], "rule-id matcher matched without its id group"),
        });
        break;
      }
      if (/^#{1,6} /.test(ahead)) break;
    }
  }
  return out;
}

type Row = { line: number; cell: string; id: string | null };

// The rows of the ONE table whose header carries a `Rule id` cell, read by that
// column's position. A cell that is not a single backticked id is kept with
// `id: null`, so a malformed row is reported rather than dropped.
function ledgerRows(): Row[] {
  const lines = readFileSync(LEDGER, "utf8").split("\n");
  const cells = (l: string) =>
    l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
  const start = lines.findIndex((l) => l.startsWith("|") && cells(l).includes("Rule id"));
  if (start === -1) return [];
  const col = cells(must(lines[start], "header line")).indexOf("Rule id");
  const out: Row[] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = must(lines[i], `lines[${i}] absent inside 0..${lines.length}`);
    if (!line.startsWith("|")) break;
    const cell = cells(line)[col] ?? "";
    const m = /^`([^`]+)`$/.exec(cell);
    out.push({ line: i + 1, cell, id: m ? must(m[1], "id cell matched without its group") : null });
  }
  return out;
}

describe("canon ↔ decay ledger", () => {
  const all = headings();
  const rules = all.filter((h) => h.depth === 3);
  const clauses = new Set(all.filter((h) => h.depth === 4).map((h) => h.id));
  const rows = ledgerRows();

  // ZERO-DENOMINATOR GUARD, BOTH SIDES. A parse returning [] on either side
  // would otherwise report a perfect pairing of nothing.
  test("both populations are non-empty", () => {
    console.log(`  canon-ledger: ${rules.length} top-level rule(s), ${rows.length} ledger row(s)`);
    expect(rules.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
  });

  test("every ledger row carries exactly one backticked rule id", () => {
    const bad = rows.filter((r) => r.id === null).map((r) => `L${r.line} «${r.cell}»`);
    expect(bad).toEqual([]);
  });

  test("every top-level rule has exactly one ledger row", () => {
    const problems: string[] = [];
    for (const r of rules) {
      const n = rows.filter((row) => row.id === r.id).length;
      if (n !== 1) problems.push(`L${r.line} ${r.id}: ${n} ledger rows, want 1`);
    }
    expect(problems).toEqual([]);
  });

  test("every ledger row names a top-level rule (not a clause, not a stale id)", () => {
    const ids = new Set(rules.map((r) => r.id));
    const orphans = rows
      .filter((row) => row.id !== null && !ids.has(row.id))
      .map(
        (row) =>
          `L${row.line} ${row.id}${clauses.has(row.id ?? "") ? " (a clause id)" : " (no rule)"}`,
      );
    expect(orphans).toEqual([]);
  });
});
