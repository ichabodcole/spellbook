#!/usr/bin/env bun
/**
 * Coverage counter for `behaviour-inventory.md`, DERIVED BY COMMAND.
 *
 * Playbook R8: "Count the Driven column BY COMMAND. Take every table row, read
 * the last cell, classify on its first token, report unparsed cells and
 * duplicate ids." Bounty's hand-count was wrong in three of four columns, and
 * the one it got most wrong was `not:` — the number a reader uses to judge how
 * much is unverified.
 *
 *     bun docs/projects/digestify-conversion/inventory-coverage.ts
 *
 * Exit 0 = every row parsed. Exit 1 = an unparsed cell or a duplicate id, both
 * of which make the totals below a lie.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(import.meta.dir, "behaviour-inventory.md");

type Row = { id: string; verdict: string; raw: string };

/** A table row is `| ID | … | Driven |`. The id column is the first cell and
 *  matches `<letter><digits>`; that shape is what separates a data row from the
 *  header and the `| --- |` rule without depending on their position. */
const ID_RE = /^[A-Z]{1,2}\d{1,3}$/;

function rows(md: string): Row[] {
  const out: Row[] = [];
  for (const line of md.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    const id = (cells[0] ?? "").trim();
    if (!ID_RE.test(id)) continue;
    const last = (cells.at(-1) ?? "").trim();
    out.push({ id, verdict: classify(last), raw: last });
  }
  return out;
}

/** Classify on the FIRST TOKEN of the cell, so a cell that goes on to say
 *  "release — … · test — …" is counted once, by what it leads with. */
function classify(cell: string): string {
  if (cell === "") return "EMPTY";
  const first = cell.toLowerCase().split(/[\s—·:,]/)[0] ?? "";
  if (first === "not") return "not";
  if (["dev", "release", "both", "test"].includes(first)) return first;
  return "UNPARSED";
}

function main(): number {
  const md = readFileSync(FILE, "utf8");
  const all = rows(md);
  const counts = new Map<string, number>();
  for (const r of all) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);

  const seen = new Map<string, number>();
  for (const r of all) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);

  console.log(`rows            ${all.length}`);
  for (const key of ["release", "dev", "both", "test", "not", "EMPTY", "UNPARSED"]) {
    const n = counts.get(key) ?? 0;
    if (n > 0) console.log(`  ${key.padEnd(12)} ${String(n).padStart(3)}`);
  }
  const driven = all.filter((r) => ["dev", "release", "both"].includes(r.verdict)).length;
  const test = counts.get("test") ?? 0;
  const not = counts.get("not") ?? 0;
  console.log(`driven in a browser  ${driven}`);
  console.log(`covered by a cell    ${test}`);
  console.log(`not driven           ${not}`);

  let bad = 0;
  for (const r of all.filter((r) => r.verdict === "UNPARSED")) {
    console.log(`  ⛔ UNPARSED ${r.id}: ${r.raw.slice(0, 80)}`);
    bad++;
  }
  for (const r of all.filter((r) => r.verdict === "EMPTY")) {
    console.log(`  ⚠ EMPTY ${r.id}`);
  }
  for (const id of dupes) {
    console.log(`  ⛔ DUPLICATE ID ${id}`);
    bad++;
  }
  // A zero-guard: an empty table and a fully-driven one print the same totals.
  if (all.length === 0) {
    console.log("  ⛔ NO VERDICT — zero rows parsed. The table shape changed.");
    return 1;
  }
  return bad > 0 ? 1 : 0;
}

process.exit(main());
