#!/usr/bin/env bun
/**
 * dist-check — is the COMMITTED `dist/` the faithful build of its COMMITTED source?
 *
 * Mechanises seams **Contract 18**: the shipped artifact is verified by
 * REPRODUCTION — rebuild at the canonical checkout root and require the tree to
 * be unchanged. Never by a proxy for its inputs (no stamp, no mtime, no recorded
 * sha — mtime records which action ran last, not what changed, and the former
 * check was inverted by exactly that), and never by regenerating the artifact in
 * CI (a GITHUB_TOKEN commit triggers no further workflow, so a CI-generated
 * artifact is the one thing in the repo nothing verifies).
 *
 *   bun scripts/dist-check.ts              # all three arms — what CI runs
 *   bun scripts/dist-check.ts --no-build   # ARMs 0+1 only; reads the tree, builds nothing
 *
 * Exit 0 = pass · 1 = a red arm · 3 = NO VERDICT.
 *
 * ⛔ **3 IS NOT A PASS.** It means the denominator was empty — the walk found no
 *    buildable spells — so there was nothing to have an opinion about. A check
 *    that examined zero things and printed a green is the failure mode this whole
 *    script exists because of (§3 of the spike: a globbed pathspec matched nothing
 *    and reported GREEN twice on a tree with three modified dists and a
 *    deliberately stale bundle). Callers must treat any non-zero exit as a stop.
 *
 * ⛔ **ARM 2 IS FOR CI, NOT FOR THE LOCAL GATE.** `bun run gate` builds first, so
 *    in a working tree any un-committed surface edit legitimately dirties `dist/`
 *    and ARM 2 would red on correct work-in-progress. In CI there is no work in
 *    progress: the runner checks out committed state, so dirt genuinely means
 *    "this commit shipped a stale artifact." ARMs 0+1 read the tree only and are
 *    safe in the suite — `grimoire/dist-roster-ward.test.ts` runs them there.
 */
import { join, relative } from "node:path";
import { buildableSpells } from "../src/build.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const DEPLOY_ROOT = join(REPO_ROOT, "plugins", "spellbook", "skills");

/** The deployed `dist/` for a spell, repo-relative (a git pathspec).
 *
 * ⛔ A LITERAL PATH, NEVER A GLOB. The spike's v1 pathspec put a `-star-` where
 * the spell name goes, under `plugins/spellbook/skills/`; git does not expand
 * that the way a shell would, it matched nothing, and the check reported GREEN on
 * a dirty tree. Build one literal pathspec per spell from the roster instead. */
export function distRoot(spell: string): string {
  return relative(REPO_ROOT, join(DEPLOY_ROOT, spell, "dist"));
}

type Git = { code: number; out: string; err: string };

/** git, via an explicit argv — no shell, so no quoting or word-splitting to get
 * wrong. (zsh does not word-split unquoted variables; a `$`-template that joined
 * a roster into one argument would silently examine one nonexistent path.) */
function git(args: string[]): Git {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  };
}

const lines = (s: string): string[] => s.split("\n").filter(Boolean);

/** TRACKED files under a spell's deployed `dist/` — the index, not the filesystem.
 *
 * `git ls-files` is deliberate: a file present on disk but not in the index does
 * not ship, because the marketplace clones the git-tracked subtree. `dist/` is
 * gitignored by a bare `dist` rule with a hand-kept un-ignore list, so a newly
 * relocated spell's `dist/` is silently skipped by `git add` **at exit 0** and
 * ships absent — which under Contract 1 falls to dev mode and dies importing a
 * `src/` tree the marketplace never copied. On disk it looks perfect. */
export function trackedDistFiles(spell: string): string[] {
  return lines(git(["ls-files", "--", distRoot(spell)]).out);
}

export type Roster = { spell: string; root: string; tracked: number }[];

/** ARM 0's denominator, derived the way `src/build.ts` derives it — by importing
 * the same function, so the two cannot drift. A hand-kept list here would be a
 * second roster, and a spell relocated into the build but not into this list
 * would be invisible to the check that exists to see it. */
export function roster(): Roster {
  return buildableSpells().map((spell) => ({
    spell,
    root: distRoot(spell),
    tracked: trackedDistFiles(spell).length,
  }));
}

function main(argv: string[]): number {
  const noBuild = argv.includes("--no-build");

  // ── ARM 0 · DENOMINATOR ───────────────────────────────────────────────────
  const rows = roster();
  const trackedTotal = rows.reduce((n, r) => n + r.tracked, 0);

  console.log("\n  ARM 0 · denominator   (derived from src/build.ts, not a list here)");
  console.log(`  buildable spells      ${rows.length}`);
  for (const r of rows) {
    console.log(`    ${r.spell.padEnd(14)} ${String(r.tracked).padStart(3)} tracked   ${r.root}`);
  }
  console.log(`  tracked files         ${trackedTotal}`);

  if (rows.length === 0) {
    console.log("\n  ⚠ NO VERDICT — the walk found no buildable spells under src/.");
    console.log("     A check with an empty denominator examined nothing. That is NOT a pass:");
    console.log("     it reads identically to a clean tree, which is how a broken filter hides.");
    console.log(
      "     Likely: run from outside the repo, or src/<spell>/{surface,backend}/ moved.\n",
    );
    return 3;
  }

  // ── ARM 1 · ROSTER ────────────────────────────────────────────────────────
  const absent = rows.filter((r) => r.tracked === 0);
  console.log("\n  ARM 1 · roster        every buildable spell ships ≥1 TRACKED file in dist/");
  if (absent.length > 0) {
    console.log(`  ⛔ FAIL — ${absent.length} of ${rows.length} spell(s) have NO tracked dist/:`);
    for (const r of absent) console.log(`     ${r.spell}   ${r.root}`);
    console.log("");
    console.log("     LIKELY CAUSE: `.gitignore`'s bare `dist` rule. It ignores every dist/ in");
    console.log("     the repo, and each relocated spell is un-ignored BY HAND. Without both");
    console.log("     lines the directory is invisible to `git add`, which then succeeds at");
    console.log("     exit 0 and stages nothing:");
    console.log("");
    for (const r of absent) {
      console.log(`       !${r.root}`);
      console.log(`       !${r.root}/**`);
    }
    console.log("");
    console.log("     A spell that ships without its dist/ falls to DEV mode (Contract 1) and");
    console.log("     dies importing a src/ tree the marketplace never copied.\n");
    return 1;
  }
  console.log(`  ✅ PASS — ${rows.length}/${rows.length} spells, ${trackedTotal} tracked files.`);

  if (noBuild) {
    console.log("\n  ARM 2 · reproduction  SKIPPED (--no-build).");
    console.log("     ARMs 0+1 read the tree; they say NOTHING about whether the committed");
    console.log("     artifact matches its committed source. That is ARM 2's question alone.\n");
    return 0;
  }

  // ── ARM 2 · REPRODUCTION ──────────────────────────────────────────────────
  console.log("\n  ARM 2 · reproduction  rebuild, then the dist roots must be clean");
  const build = Bun.spawnSync(["bun", "run", "build"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    console.log("  ⛔ FAIL — `bun run build` did not succeed; there is no artifact to compare.");
    process.stdout.write(build.stdout.toString());
    process.stderr.write(build.stderr.toString());
    console.log("");
    return 1;
  }

  const roots = rows.map((r) => r.root);
  // ⛔ `git status --porcelain`, NEVER `git diff`. Chunk filenames carry a
  // content hash, so a content change RENAMES the file: the new chunk is
  // UNTRACKED and `git diff` sees only a deletion. `status` sees both.
  const st = git(["status", "--porcelain", "--", ...roots]);
  const dirty = lines(st.out);

  // Print the size of the set that was examined. A clean tree and an empty
  // filter produce identical output otherwise — that ambiguity is what let the
  // v1 check report GREEN twice while three dists were modified.
  console.log(
    `  pathspec              ${roots.length} literal root(s), ${trackedTotal} tracked files`,
  );
  console.log(`  dirty paths           ${dirty.length}`);

  if (dirty.length > 0) {
    console.log("  ⛔ FAIL — the committed dist/ is NOT the build of the committed source.");
    for (const l of dirty.slice(0, 40)) console.log(`     ${l}`);
    if (dirty.length > 40) console.log(`     … and ${dirty.length - 40} more`);
    console.log("");
    console.log("     A rebuild changed the tree, so what is committed is STALE. Fix by");
    console.log("     rebuilding and committing the artifact — `bun run build` has already");
    console.log("     run, so the working tree now holds the correct dist/. Stage it:");
    console.log(`       git add ${roots.join(" ")}`);
    console.log("");
    console.log("     If NOTHING in the surface source changed, suspect the toolchain: an");
    console.log("     unpinned Bun whose bundler output differs goes red repo-wide with no");
    console.log("     source change. The pin is `.bun-version`.\n");
    return 1;
  }

  console.log("  ✅ PASS — rebuild is a git no-op across every dist root.\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
