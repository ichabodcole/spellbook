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
 *
 * ⛔ **ARM 1 COUNTS THE INDEX; ARM 1b COMPARES IT TO THE DISK (D42).** "≥1
 *    tracked file in dist/" is satisfied by a spell's SURFACE chunks alone, and
 *    it was: with imago's two backend artifacts unstaged this printed
 *    `imago 3 tracked` and PASSED. A derived denominator counted from the index
 *    cannot notice what the build left beside it. Every row now prints
 *    `tracked / on disk`, and a BACKEND artifact on disk that the index does not
 *    have is FATAL — see `isBackendArtifact` for why that clause is narrow
 *    enough not to red on ordinary work in progress.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isBackendArtifact as classifyBackendArtifact } from "../grimoire/lib/dist-artifacts.ts";
import { backendEntryNames, buildableSpells } from "../src/build.ts";

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
function git(args: string[], cwd: string = REPO_ROOT): Git {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
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

/** TRACKED files under a set of root-relative pathspecs — the index, not the
 * disk, for the same reason as `trackedDistFiles`. `root` defaults to this repo;
 * a control passes a throwaway git repo so the PREDICATE below can be driven
 * against a tree whose contents the control chose. */
export function trackedFiles(pathspecs: string[], root: string = REPO_ROOT): string[] {
  return lines(git(["ls-files", "--", ...pathspecs], root).out);
}

/** S3 clause 1 / seams Contract 4: a buildable spell's deployed folder ships NO
 * build-input source — no path under `surface/` and no `bunfig.toml`. Source-free
 * by the FILE LIST (Contract 20), asserted over the tracked subtree, because a
 * successor present at `src/<spell>/` is only HALF a check: a copy-not-move
 * passes both halves (`docs/backlog/2026-09-02-nothing-can-tell-a-move-from-a-copy.md`).
 * Returns the offending tracked paths, named, so the remedy is per-path.
 *
 * ⛔ THE CONTROL FOR THIS FUNCTION MUST GO THROUGH THIS FUNCTION. A control that
 * only proves `git ls-files` can see a tracked path stays green when these two
 * pathspecs are typo'd — measured by cassandra (comms #1160, route R4): a real
 * leak in the tree, 5 pass / 0 fail. Hence `root`: the ward's control mints a
 * git repo with a known leak and asserts this function NAMES it. */
export function trackedBuildInputs(spell: string, root: string = REPO_ROOT): string[] {
  const base = relative(root, join(root, "plugins", "spellbook", "skills", spell));
  return trackedFiles([`${base}/surface`, `${base}/bunfig.toml`], root);
}

/** Files under a spell's deployed `dist/` **ON DISK**, repo-relative — the other
 *  half of the measurement, and the one this script did not take until D42.
 *
 *  ⛔ ARM 1's PREDICATE WAS "≥1 TRACKED FILE" AND THAT IS A DERIVED DENOMINATOR
 *  WITH AN UNCOVERED NUMERATOR. Driven: with imago's two backend artifacts left
 *  unstaged, ARM 1 printed `imago 3 tracked` and PASSED **on its surface chunks
 *  alone** — a green that named the spell and said nothing about the two files
 *  that were the whole reason to look. A count of what is in the index cannot
 *  notice what is beside it on the disk. */
export function diskDistFiles(spell: string, root: string = REPO_ROOT): string[] {
  const dir = join(root, distRoot(spell));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => `${distRoot(spell)}/${f}`)
    .sort();
}

/** The BACKEND artifacts the build DECLARES for a spell, repo-relative — the
 *  other direction of ARM 1b, and the one that was missing until 2026-09-10.
 *
 *  ⛔ THE OLD CLAUSE CONVICTED ONLY A TOTALLY EMPTY `dist/`. It was
 *  `r.tracked > 0 && r.disk === 0`, so removing ONE of astrolabe's five
 *  artifacts printed `astrolabe:5/4` in the ward's own output and reddened
 *  nothing (type-debt Phase 1, T13 #2). A partial loss is the likelier loss: it
 *  is what a failed or interrupted per-aspect emit leaves behind.
 *
 *  ⚠ THE DECLARATION IS `src/build.ts`'s OWN, IMPORTED, NEVER A NAME TEST. The
 *  expected set is `backendEntryNames` — a backend module with a paired
 *  launcher — so this cannot become the fourth copy of the `endsWith("/cli.js")`
 *  hard-coding D43 removed from the build, D44 from the spawn-path ward and
 *  2026-09-09 from `isBackendArtifact`.
 *
 *  ⚠ AND IT ASKS THE QUESTION IN THE ONLY DIRECTION THAT IS SAFE IN THE SUITE.
 *  "Tracked but not on disk" would red on ordinary work in progress: `dist/` is
 *  rm'd before every build (`src/build.ts:308`), so a rebuilt surface renames
 *  its hashed chunk and the previously tracked name is legitimately gone until
 *  it is staged — ARM 2's question, CI-only by Cole's 2026-09-01 ruling. A
 *  DECLARED BACKEND ENTRY missing from the disk carries no such innocent
 *  reading: the build either emitted it or did not. */
export function expectedBackendArtifacts(spell: string): string[] {
  return backendEntryNames(spell).map((name) => `${distRoot(spell)}/${name}.js`);
}

/** Declared by the build and NOT ON THE DISK. Named per path: the remedy is
 *  `bun run build`, or finding out why that entry emitted nothing. */
export function absentBackendArtifacts(spell: string): string[] {
  const onDisk = new Set(diskDistFiles(spell));
  return expectedBackendArtifacts(spell).filter((f) => !onDisk.has(f));
}

/** On the disk and not in the index — emitted, and not shipping. */
export function untrackedDistFiles(spell: string, root: string = REPO_ROOT): string[] {
  const tracked = new Set(trackedFiles([distRoot(spell)], root));
  return diskDistFiles(spell, root).filter((f) => !tracked.has(f));
}

/** A backend artifact has a STABLE emitted name (`src/build.ts` names entries
 *  `[dir]/[name].[ext]`); a surface chunk carries a content hash and is RENAMED
 *  by every content change.
 *
 *  ⛔ THAT ASYMMETRY IS WHAT MAKES THE FATAL CLAUSE BELOW DISCRIMINATING RATHER
 *  THAN A FALSE ALARM. An untracked `index-<hash>.js` is ordinary work in
 *  progress — a rebuilt surface whose new chunk name is not staged yet — and the
 *  ruling that keeps ARM 2 out of the local suite (Cole, 2026-09-01) is the same
 *  ruling that keeps it non-fatal here. An untracked backend artifact cannot
 *  mean that: a rebuild of a tracked one leaves it MODIFIED, not untracked.
 *  Untracked at a stable name means this spell's backend has never been staged —
 *  the first-emit window, which is exactly the defect, and which all four
 *  remaining ports pass through.
 *
 *  ⛔ ⛔ AND UNTIL 2026-09-09 THIS WAS `endsWith("/cli.js") || endsWith("/server.js")`
 *  — THE THIRD SURVIVING COPY OF THE HARD-CODING D43 REMOVED FROM `src/build.ts`
 *  AND D44 REMOVED FROM `spawn-path-ward.test.ts`, sitting inside the arm built
 *  for D42. Found by DRIVING it, not by reading it: `git rm --cached` on
 *  bounty's freshly emitted `dist/join.js` — the exact first-emit shape ARM 1b
 *  exists for — produced **exit 0**, with the artifact demoted into the
 *  NON-FATAL "expected mid-edit" list beside rebuilt surface chunks. The remedy
 *  the message offers ("ARM 2 is what refuses to let them stay that way") is
 *  true and is not this arm's job. The same silence was waiting for digestify's
 *  `review.js` and grapevine's `daemon.js`.
 *
 *  ⛔ THE SPLIT IS NOW IMPORTED, NOT RE-DERIVED (D44). `grimoire/lib/dist-artifacts.ts`
 *  computes it from the emitted `index.html`'s REFERENCE CLOSURE — what the
 *  served page actually pulls in — so "backend" means "nothing the surface
 *  reaches", which is a property rather than a name test. A second derivation
 *  here would be the two-denominators defect `entry-points.ts` exists because of.
 *
 *  ⚠ `null` FROM THE SHARED PREDICATE MEANS **NOT LOOKED AT**, AND IT IS MADE
 *  LOUD RATHER THAN COERCED. It can only arise for a path whose own `dist/` does
 *  not exist, which cannot happen for a path this script read OFF that
 *  directory — so if it ever happens, the enumerator and the classifier
 *  disagree about the tree, and a `false` there would spell that disagreement as
 *  "not a backend artifact". */
// ⛔ NEVER PASS THIS BARE TO `.filter(...)`. `Array.prototype.filter` supplies
// (value, index, array), so a bare reference feeds the ELEMENT INDEX into
// `root` — which threw `ERR_INVALID_ARG_TYPE` the first time this function grew
// a second parameter, and which would have been a SILENT wrong answer had the
// parameter been anything `join` tolerates. Every call site below wraps it.
export const isBackendArtifact = (repoRelative: string, root: string = REPO_ROOT): boolean => {
  const verdict = classifyBackendArtifact(join(root, repoRelative), root);
  if (verdict === null) {
    throw new Error(
      `dist-check: ${repoRelative} was enumerated from the disk but its dist/ could not be ` +
        "classified — the enumerator and grimoire/lib/dist-artifacts.ts disagree about the tree. " +
        "This is NOT LOOKED AT and must never be reported as `not a backend artifact` (D42).",
    );
  }
  return verdict;
};

export type Roster = {
  spell: string;
  root: string;
  tracked: number;
  disk: number;
  untracked: string[];
  /** Declared by `src/build.ts` and not on the disk — `absentBackendArtifacts`. */
  absent: string[];
}[];

/** ARM 0's denominator, derived the way `src/build.ts` derives it — by importing
 * the same function, so the two cannot drift. A hand-kept list here would be a
 * second roster, and a spell relocated into the build but not into this list
 * would be invisible to the check that exists to see it. */
export function roster(): Roster {
  return buildableSpells().map((spell) => ({
    spell,
    root: distRoot(spell),
    tracked: trackedDistFiles(spell).length,
    disk: diskDistFiles(spell).length,
    untracked: untrackedDistFiles(spell),
    absent: absentBackendArtifacts(spell),
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
    // ⛔ BOTH NUMBERS, ALWAYS. `3 tracked` alone read as a complete measurement
    // of a spell whose disk held five files; the two it did not name were the
    // backend artifacts (D42).
    console.log(
      `    ${r.spell.padEnd(14)} ${String(r.tracked).padStart(3)} tracked / ${String(r.disk).padStart(3)} on disk   ${r.root}`,
    );
  }
  console.log(`  tracked files         ${trackedTotal}`);
  console.log(`  files on disk         ${rows.reduce((n, r) => n + r.disk, 0)}`);

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
  // ── ARM 1b · THE INDEX IS NOT THE TREE ───────────────────────────────────
  //
  // ⛔ A POPULATION READ FROM THE INDEX IS NOT A POPULATION READ FROM THE TREE.
  // ARM 1 above counts what git has; the build writes to the disk. On the commit
  // that FIRST EMITS a spell's backend those two sets differ, and every check
  // that only counts the first one is silent about a file it has already named
  // the spell for. Nothing can LAND that way — ARM 2 reads `git status
  // --porcelain`, which lists an unstaged artifact as `??`, and the `.gitignore`
  // un-ignore lines exist for all eight spells — but ARM 1 said `✅ PASS` over
  // it, and a green that means "unexamined" is the failure this whole script
  // exists because of.
  const unstagedBackends = rows.flatMap((r) => r.untracked.filter((f) => isBackendArtifact(f)));
  const unstagedOther = rows.flatMap((r) => r.untracked.filter((f) => !isBackendArtifact(f)));
  const diskTotal = rows.reduce((n, r) => n + r.disk, 0);
  const untrackedTotal = rows.reduce((n, r) => n + r.untracked.length, 0);

  // ⛔ THE ARM SAYS WHAT IT LOOKED AT, ON THE PASS AS WELL AS ON THE FAIL — the
  // rule D42 wrote and this arm was built to enforce, broken by the arm itself.
  // It used to print NOTHING when it passed: on a clean tree the output went
  // from ARM 1's `✅ PASS` straight to ARM 2, so "1b ran and found nothing" and
  // "1b never ran" were the same bytes. That is the silent green D42 forbids,
  // in the instrument D42 built.
  //
  // ⚠ THE DENOMINATOR IS THE DISK, NOT THE UNTRACKED SET. `0 untracked` is
  // exactly the number a broken enumerator prints, so the line leads with the
  // population that must be non-zero for the comparison to mean anything.
  console.log("\n  ARM 1b · index vs disk  a BACKEND artifact on the disk must be in the INDEX");
  console.log(
    `  looked at             ${rows.length} spell(s), ${diskTotal} file(s) on disk, ${untrackedTotal} untracked`,
  );

  // ⛔ AND THE OTHER DIRECTION: A DECLARED BACKEND ENTRY THAT IS NOT ON THE DISK.
  // The clause below this one (`tracked > 0 && disk === 0`) convicted only a
  // TOTALLY empty `dist/`; a spell that lost ONE of five artifacts printed
  // `5/4` and reddened nothing (T13 #2). The expected set is the build's own
  // `backendEntryNames`, so this is a comparison against a declaration rather
  // than against a name convention.
  const expectedTotal = rows.reduce((n, r) => n + expectedBackendArtifacts(r.spell).length, 0);
  const absentBackends = rows.flatMap((r) => r.absent);
  console.log(
    `  declared by the build ${expectedTotal} backend artifact(s), ${absentBackends.length} not on the disk`,
  );
  if (absentBackends.length > 0) {
    console.log(
      `  ⛔ FAIL — ${absentBackends.length} of ${expectedTotal} DECLARED backend artifact(s) are NOT ON THE DISK:`,
    );
    for (const f of absentBackends) console.log(`     ${f}`);
    console.log("");
    console.log("     `src/build.ts` declares one artifact per backend module with a paired");
    console.log("     launcher. A declared entry missing from the disk is an emit that did not");
    console.log(
      "     happen — nothing about it is ordinary work in progress. Run `bun run build`;",
    );
    console.log("     if it comes back missing, that entry is failing to emit and the build is");
    console.log("     saying so at exit 0.");
    console.log("");
    return 1;
  }

  if (unstagedBackends.length > 0) {
    console.log(
      `  ⛔ FAIL — ${unstagedBackends.length} BACKEND artifact(s) NOT STAGED — NOT LOOKED AT:`,
    );
    for (const f of unstagedBackends) console.log(`     ${f}`);
    console.log("");
    console.log("     A backend artifact has a STABLE name, so untracked cannot mean `a rebuilt");
    console.log("     chunk pending staging` — it means this spell's backend has never been");
    console.log("     staged. Everything above counted the INDEX and therefore said nothing");
    console.log("     about these files. Stage them, or add the two `.gitignore` un-ignore");
    console.log("     lines if `git add` is silently refusing them at exit 0:");
    console.log("");
    for (const r of rows.filter((x) => x.untracked.some((f) => isBackendArtifact(f)))) {
      console.log(`       git add -- ${r.root}`);
    }
    console.log("");
    return 1;
  }

  console.log(`  ✅ PASS — 0 of ${untrackedTotal} untracked file(s) is a backend artifact.`);

  // ⚠ NON-FATAL, AND THE ASYMMETRY IS DELIBERATE (see `isBackendArtifact`). A
  // hashed surface chunk is renamed by every content change, so untracked here is
  // ordinary work in progress; failing on it would red the local gate on every
  // surface edit, which is the same reason ARM 2 is CI-only. But it is NAMED, so
  // the green above can never be read as "everything on the disk was examined".
  if (unstagedOther.length > 0) {
    console.log(
      `  ⚠ ${unstagedOther.length} file(s) on disk are NOT STAGED and therefore NOT part of what`,
    );
    console.log("     ARM 1 measured. Expected mid-edit (a rebuilt surface chunk is renamed);");
    console.log("     ARM 2 is what refuses to let them stay that way in a commit:");
    for (const f of unstagedOther) console.log(`     ${f}`);
  }

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
