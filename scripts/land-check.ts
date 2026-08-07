#!/usr/bin/env bun
/**
 * land-check — is this branch safe to SQUASH, or must it be a NAMED MERGE?
 *
 * Mechanises the test in AGENTS.md § "Landing work" so it is RUN, not remembered.
 * Exits 0 when squashing is safe, 1 when it is not, so it can gate.
 *
 * Squashing is safe only when BOTH hold:
 *   1. nothing cites a sha from the branch (squashing breaks those references)
 *   2. there is one author       (squashing destroys per-seat attribution)
 *
 * Neither holds for agent-team work. Both hold for a solo chore branch. The
 * point of the check is that it discriminates rather than always saying no.
 *
 *   bun run land-check [base] [head]
 */
import { $ } from "bun";

const base = process.argv[2] ?? "develop";
const head = process.argv[3] ?? (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();

const shas = (await $`git log ${base}..${head} --format=%h`.text())
  .trim()
  .split("\n")
  .filter(Boolean);

if (shas.length === 0) {
  // NOT exit 0 — the skill decodes 0 as "squash-safe", and an empty range is not
  // a verdict. It usually means a stale local base, an already-merged branch, or
  // base === head. Exit 2 so it can never be read as an answer.
  console.log(`\n  ⚠ NO VERDICT — ${head} has no commits ${base} does not already have.`);
  console.log("     Likely: stale local base (git fetch), already merged, or base === head.");
  console.log(`     Nothing to decide. This is NOT 'squash-safe'.\n`);
  process.exit(2);
}

// TEST 1 — does any TRACKED file cite a sha from this branch?
//
// `git grep` (not a filesystem grep) is deliberate: it searches tracked content
// only. An earlier hand-run of this test used a filesystem grep, counted
// untracked scratch files, and reported 32 where the true figure was 10.
// ⚠ `git grep <sha>` alone searches the CURRENT CHECKOUT — so the answer would
// depend on which branch you happen to be standing on. Standing on `base` (where
// you must be to run `git merge`), a doc that exists only on the branch is not in
// the tree, the grep finds nothing, and an unmergeable branch reports SQUASH-SAFE.
// Passing the tree-ish pins the search to the branch's own content, so the verdict
// is a property of the branch and not of your cwd.
const cited: string[] = [];
for (const sha of shas) {
  const hit = await $`git grep -l ${sha} ${head}`.nothrow().quiet();
  if (hit.exitCode === 0 && hit.stdout.toString().trim()) cited.push(sha);
}

// TEST 2 — how many distinct authors? Seat trailers first, git authors as fallback.
const seats = [
  ...new Set(
    (await $`git log ${base}..${head} --format=%b`.text())
      .split("\n")
      .filter((l) => l.startsWith("Anthill-Seat:"))
      .map((l) => l.replace("Anthill-Seat:", "").trim()),
  ),
].sort();

const authors = [
  ...new Set(
    (await $`git log ${base}..${head} --format=%an`.text()).trim().split("\n").filter(Boolean),
  ),
];

// Seat trailers are the honest unit where they exist: git records the human as
// author of every seat's commit, so `%an` collapses a four-agent branch to one.
const distinct = seats.length > 0 ? seats.length : authors.length;
const who = seats.length > 0 ? `${seats.join(" ")} (seats)` : `${authors.join(" ")} (git authors)`;
// This proxy FAILS OPEN: git records the human as author of every seat's commit,
// so a multi-agent branch whose trailers were forgotten or malformed collapses to
// 1 and reports squash-safe — destroying the attribution the check protects.
const failsOpen = seats.length === 0;

const safe = cited.length === 0 && distinct <= 1;

console.log(`\n  branch      ${head}   (base ${base})`);
console.log(`  commits     ${shas.length}`);
console.log(
  `  cited shas  ${cited.length}${cited.length ? `   ← ${cited.slice(0, 6).join(" ")}${cited.length > 6 ? " …" : ""}` : ""}`,
);
console.log(`  authors     ${distinct}   ← ${who}`);
if (failsOpen) {
  console.log("              ⚠ no Anthill-Seat: trailers found, so this counts GIT authors —");
  console.log("                which collapses a multi-agent branch to 1. If you know more");
  console.log("                than one agent worked here, this number is WRONG and low.");
}
console.log("");

if (safe) {
  console.log("  ✅ SQUASH-SAFE — nothing cites a branch sha, single author.");
  console.log("     Squashing is PERMITTED, not required. Two ways to land:");
  console.log("");
  console.log(`     git merge --squash ${head}     # collapse to ONE commit`);
  console.log("     git commit                     # ⚠ --squash STAGES ONLY. It does not commit.");
  console.log("");
  console.log(
    `     git merge --ff-only ${head}    # KEEP the branch's ${shas.length} commit(s), linear`,
  );
  console.log("       ↑ fast-forward preserves every commit as-is. Prefer it when the");
  console.log("         commit messages carry reasoning worth keeping addressable.");
} else {
  console.log("  ⛔ DO NOT SQUASH — merge it, and NAME the merge.");
  if (cited.length) console.log(`     ${cited.length} sha citation(s) would break.`);
  if (distinct > 1) console.log(`     ${distinct} authors' attribution would be destroyed.`);
  console.log("");
  console.log("     Build ONE message file — subject, BLANK LINE, body — then:");
  console.log(`     git merge --no-ff ${head} -F <file>`);
  console.log("");
  console.log('     ⚠ NOT `-m "subject" -F body`. git concatenates them with no blank');
  console.log("       line, so the whole first paragraph becomes the subject. A real");
  console.log("       merge here produced a 251-character subject and broke the");
  console.log("       `git log --merges` view the naming exists for.");
}
console.log("");

process.exit(safe ? 0 : 1);
