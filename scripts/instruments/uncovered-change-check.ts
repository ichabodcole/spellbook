#!/usr/bin/env bun
// uncovered-change-check — did this commit change BEHAVIOUR and bring no CELL?
//
// ⛔ NOT a `.test.ts`. Run it explicitly:
//     bun scripts/instruments/uncovered-change-check.ts [<commit-ish>...]   # default: HEAD
//     bun scripts/instruments/uncovered-change-check.ts develop..HEAD
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// A gate answers "did anything BREAK". It never answers "did this change bring
// its own EVIDENCE". Two seats shipped uncovered changes in one session, both
// caught only by a human reading a delta afterwards:
//
//   daedalus b6  0c19304   the fix for ZERO SEMANTIC COVERAGE shipped with zero
//                          semantic coverage; suite stayed 1397 -> 1397
//   circe    b4s fbfe1d3   shipped with no test, and the proof was REPORTED AS
//                          REASSURANCE: 31/0 before, 31/0 after
//
// ⭐ THE DETECTION ASYMMETRY IS THE WHOLE POINT: a count that MOVES gets
// noticed; a count that DOES NOT MOVE reads as stability. The signal here is
// the ABSENCE of a delta, so this instrument has to make non-movement LOUD.
//
// ── WHY IT ASSERTS SETS, NOT A TOTAL ────────────────────────────────────────
// "Did the test count change?" is silent on SUBSTITUTION — one cell out, one
// in, total unchanged, coverage changed. This reports the SET of source paths
// that arrived without a sibling test change, and names them.
//
// ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────────
//   • It pins that a test file was TOUCHED, never that the test is GOOD, or
//     that it covers the change. A renamed variable in a test satisfies it.
//   • It cannot judge whether a change NEEDED a cell. A pure refactor with
//     existing coverage flags identically to an uncovered feature — this is a
//     PROMPT TO JUSTIFY, not a verdict. Say why, do not silence it.
//   • Docs-only and instrument-only commits are excluded by construction
//     (below); if that exclusion is wrong for your commit, it will read clean.

import { $ } from "bun";

// EVERY FILTER, as data, so it can be PRINTED rather than lurking in a comment.
// An unpublished filter makes a correct result unreproducible.
const FILTERS_APPLIED = [
  "BEHAVIOUR = changed paths under plugins/spellbook/skills/ or src/, excluding *.test.ts and *.md",
  "  -> deliberately includes .html/.py/.json: circe's instance (fbfe1d3) was `.html` ONLY, and a .ts-only filter misses it entirely",
  "EVIDENCE  = any changed path matching *.test.ts, ANYWHERE",
  "  -> matched by BEHAVIOUR not by directory: 5 spells keep tests in scripts/, 3 in tests/ (house-style's own 63-vs-37 scar)",
  "EXCLUDED  = scripts/instruments/ (these instruments), *.md, .anthill/ — none of them are shippable behaviour",
  "assertion delta = added-minus-removed lines containing `expect(` in *.test.ts diffs (a HINT, not the verdict)",
];

const SOURCE_ROOTS = ["plugins/spellbook/skills/", "src/"];
const isTest = (p: string) => /\.test\.ts$/.test(p);
const isExcluded = (p: string) =>
  p.startsWith("scripts/instruments/") || p.endsWith(".md") || p.startsWith(".anthill/");
const isBehaviour = (p: string) =>
  SOURCE_ROOTS.some((r) => p.startsWith(r)) && !isTest(p) && !isExcluded(p);

const args = process.argv.slice(2);
const revs = args.length ? args : ["HEAD"];

// Expand any range into individual shas so each commit is judged on its own.
const shas: string[] = [];
for (const r of revs) {
  const out = (await $`git rev-list --no-walk=unsorted ${r}`.nothrow().text()).trim();
  const list = out ? out.split("\n") : (await $`git rev-list -n 1 ${r}`.text()).trim().split("\n");
  for (const s of list) if (s) shas.push(s);
}

console.log(
  "FILTERS APPLIED (published — an unpublished filter makes a correct result unreproducible):",
);
for (const f of FILTERS_APPLIED) console.log(`  ${f}`);
console.log(`\nDENOMINATOR  commits examined: ${shas.length}`);
if (shas.length === 0) {
  console.error("PRECONDITION FAILED — zero commits resolved. Verdict withheld.");
  process.exit(1);
}

let flagged = 0;
for (const sha of shas) {
  const subject = (await $`git log -1 --format=%s ${sha}`.text()).trim();
  const files = (await $`git show --name-only --format= ${sha}`.text())
    .trim()
    .split("\n")
    .filter(Boolean);
  const behaviour = files.filter(isBehaviour);
  const evidence = files.filter(isTest);

  // Assertion delta — a HINT. A touched test file with no new expect() is a
  // weaker signal than an untouched one, and this is where it shows.
  let delta = 0;
  if (evidence.length) {
    const diff = await $`git show ${sha} -- ${evidence}`.nothrow().text();
    for (const line of diff.split("\n")) {
      if (/^\+/.test(line) && !/^\+\+\+/.test(line) && line.includes("expect(")) delta++;
      if (/^-/.test(line) && !/^---/.test(line) && line.includes("expect(")) delta--;
    }
  }

  const short = sha.slice(0, 7);
  if (behaviour.length > 0 && evidence.length === 0) {
    flagged++;
    console.log(`\n⛔ UNCOVERED  ${short}  ${subject.slice(0, 62)}`);
    console.log(`   behaviour changed, NO test file touched:`);
    for (const p of behaviour) console.log(`     - ${p}`);
  } else if (behaviour.length > 0 && delta <= 0) {
    flagged++;
    console.log(`\n⚠ NO NEW ASSERTIONS  ${short}  ${subject.slice(0, 62)}`);
    console.log(`   test files touched (${evidence.length}) but expect() delta = ${delta}`);
    for (const p of behaviour) console.log(`     - ${p}`);
  } else if (behaviour.length > 0) {
    console.log(`\n✅ COVERED  ${short}  ${subject.slice(0, 62)}   (+${delta} expect())`);
  } else {
    console.log(`\n·  no behaviour change  ${short}  ${subject.slice(0, 62)}`);
  }
}

console.log(`\nflagged ${flagged} of ${shas.length} commit(s)`);
process.exit(flagged === 0 ? 0 : 1);
