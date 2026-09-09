// ⛔ THE WARD FOR A SPELL THAT SHIPS WITHOUT ITS BUILT ARTIFACT.
//
// `dist/` is gitignored by a bare `dist` rule with a HAND-KEPT un-ignore list
// in `.gitignore`. A newly relocated spell whose two `!` lines were not added is
// invisible to `git add`, which then succeeds AT EXIT 0 and stages nothing. On
// disk the build looks perfect; in the tree there is no artifact; at the
// consumer the marketplace clones a subtree with an empty `dist/`, `server.ts`
// finds no `dist/index.html`, falls to DEV mode (seams Contract 1) and dies
// importing a `src/` tree the marketplace never copied.
//
// ── WHAT THIS WARD IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────
//
// It is ARMs 0 and 1 of `scripts/dist-check.ts`, run in the suite. Both read the
// TREE only — the roster walk and `git ls-files`. Neither builds.
//
// ⛔ ARM 2 (reproduction — rebuild, then the dist roots must be clean) IS NOT
//    HERE, AND ITS ABSENCE IS A RULING, NOT AN OVERSIGHT (Cole, 2026-09-01).
//    `bun run gate` builds before it tests (`0757e55`), so in a working tree any
//    un-committed surface edit legitimately dirties `dist/` — ARM 2 in the suite
//    would red on correct work-in-progress and every surface edit would fail the
//    gate until its artifact was committed. Unusable. ARM 2 runs in CI, where
//    the runner checks out committed state and dirt genuinely means "this commit
//    shipped a stale artifact": `.github/workflows/ci.yml`.
//
// ⛔ SO A GREEN HERE SAYS NOTHING ABOUT WHETHER THE COMMITTED `dist/` MATCHES
//    ITS COMMITTED SOURCE. It says an artifact is PRESENT and TRACKED. Those are
//    different failures with different remedies, and this is the cheap half.
//
// ⛔ AND ARM 1's "PRESENT AND TRACKED" IS TWO MEASUREMENTS, NOT ONE (D42). A
//    spell's surface chunks satisfy "≥1 tracked file" on their own, so the arm
//    passed over imago with both its backend artifacts unstaged. ARM 1b below is
//    the missing half: the index compared to the DISK, fatal for a backend
//    artifact, named-but-non-fatal for a hashed surface chunk.
//
// The arms are imported rather than re-derived, so this cell and CI cannot
// disagree about what the roster is.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isBackendArtifact,
  roster,
  trackedBuildInputs,
  trackedDistFiles,
  untrackedDistFiles,
} from "../scripts/dist-check.ts";

describe("dist roster ward", () => {
  const rows = roster();

  test("ARM 0 — the denominator is not empty", () => {
    // ZERO-GUARD ON THE POPULATION, NOT ON THE FINDING. An empty roster makes
    // every assertion below vacuously true — a walk that found nothing reads
    // exactly like a tree with nothing wrong. `scripts/dist-check.ts` exits 3
    // (NO VERDICT) in that case rather than 0; here the equivalent is a red.
    console.log(
      `  dist roster: ${rows.length} buildable spell(s) — ${rows.map((r) => `${r.spell}:${r.tracked}`).join(" ")}`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  test("ARM 1 — every buildable spell has at least one TRACKED file in its dist/", () => {
    const absent = rows.filter((r) => r.tracked === 0).map((r) => r.root);
    // Named, not counted: the remedy is per-spell (two `!` lines in .gitignore),
    // so the failure message has to say which spell and which path.
    expect(absent).toEqual([]);
  });

  test("ARM 1b — every BACKEND artifact on disk is TRACKED: the index is not the tree", () => {
    // ⛔ THE THIRD INSTANCE OF ONE DEFECT (D42). ARM 1's predicate was "≥1
    // TRACKED file in dist/", and a spell's surface chunks satisfy it on their
    // own. Driven: with imago's `cli.js` and `server.js` left unstaged, ARM 1
    // printed `imago 3 tracked` and PASSED — a green over the two files that
    // were the entire reason to look. A derived denominator counted from the
    // INDEX cannot notice what the BUILD left beside it on the DISK.
    //
    // Named per path, because the remedy is per path: `git add`, or the two
    // `.gitignore` un-ignore lines that make `git add` refuse at exit 0.
    const unstaged = rows.flatMap((r) => r.untracked.filter(isBackendArtifact));
    expect(unstaged).toEqual([]);
  });

  test("ARM 1b — BOTH numbers are measured, so a green cannot mean `unexamined`", () => {
    // The disk count is what makes the tracked count falsifiable. Without it,
    // `3 tracked ✅` and `3 tracked of 5 on disk ✅` print identically.
    console.log(`  dist roster: ${rows.map((r) => `${r.spell}:${r.tracked}/${r.disk}`).join(" ")}`);
    for (const r of rows) expect(r.disk).toBeGreaterThanOrEqual(0);
    // A spell whose dist/ exists on disk must contribute to BOTH measurements —
    // a zero disk count beside a non-zero tracked count means the walk read a
    // path that is not there, which is how this script's v1 pathspec failed.
    expect(rows.filter((r) => r.tracked > 0 && r.disk === 0)).toEqual([]);
  });

  test("positive control — untrackedDistFiles NAMES a file the index does not have", () => {
    // ⛔ THROUGH THE PREDICATE, AGAINST A REPO THE CONTROL BUILT — the ruling
    // `trackedBuildInputs`'s control earned. Proving `readdirSync` can list a
    // directory says nothing about whether this function compares the right two
    // sets.
    const root = mkdtempSync(join(tmpdir(), "dist-unstaged-control-"));
    try {
      const dist = join(root, "plugins", "spellbook", "skills", "probe", "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "server.js"), "// staged\n");
      const git = (...a: string[]) =>
        Bun.spawnSync(["git", ...a], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(git("init", "-q").exitCode).toBe(0);
      // `-f`: the real tree's `dist` is gitignored, and a control should model
      // the INDEX, not re-derive the un-ignore list.
      expect(git("add", "-f", "--", "plugins").exitCode).toBe(0);
      // The first-emit window, exactly: a backend artifact on disk, not staged.
      writeFileSync(join(dist, "cli.js"), "// emitted, never staged\n");
      writeFileSync(join(dist, "index-newhash.js"), "// a rebuilt surface chunk\n");

      expect(untrackedDistFiles("probe", root)).toEqual([
        "plugins/spellbook/skills/probe/dist/cli.js",
        "plugins/spellbook/skills/probe/dist/index-newhash.js",
      ]);
      // ⭐ AND THE FATAL CLAUSE DISCRIMINATES. Only the stable-named artifact is
      // fatal; the hashed chunk is ordinary work in progress and must stay
      // non-fatal, or the local gate reds on every surface edit — the same
      // reason ARM 2 is CI-only.
      expect(untrackedDistFiles("probe", root).filter(isBackendArtifact)).toEqual([
        "plugins/spellbook/skills/probe/dist/cli.js",
      ]);
      // …and it can measure empty in the SAME repo, so the rows above came from
      // a comparison rather than from a function that returns the whole disk.
      expect(untrackedDistFiles("probe-absent", root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S3 clause 1 — no roster spell ships build-input source: zero tracked surface/ paths, no bunfig.toml", () => {
    // The OTHER half of source-free (seams Contract 4, Contract 20): ARM 1 says
    // the artifact is present; this says the INPUT is absent. Over the TRACKED
    // subtree, because that is what the marketplace copies — a `surface/` still
    // on disk but untracked does not ship, and one tracked but deleted from
    // disk does. Named per path: a copy-not-move leaves the predecessor fully
    // intact beside a working successor, so "dist-check says 5" is not evidence
    // the move happened, and the remedy is `git rm` of exactly these paths.
    // Population = roster(), so a spell relocated into the build is covered the
    // day it arrives, and a spell not yet in the build is not falsely accused.
    const leaks = rows.flatMap((r) => trackedBuildInputs(r.spell));
    expect(leaks).toEqual([]);
  });

  test("positive control — trackedBuildInputs NAMES a known leak in a repo the control built", () => {
    // ⛔ THE CONTROL GOES THROUGH THE PREDICATE, NOT AROUND IT. The first draft
    // asserted `git ls-files <spell>/scripts` was non-empty — which proves the
    // instrument can read an index and says NOTHING about whether
    // trackedBuildInputs points at surface/ and bunfig.toml. cassandra typo'd
    // both pathspecs, planted a tracked leak, and the ward stayed 5/0 (comms
    // #1160, R4). A control that stays green under any pathspec licenses
    // nothing. So: a throwaway git repo with one leaking spell and one clean
    // one, and the assertion is on the exact paths this function returns.
    // Deliberately NOT keyed on glamour's own tracked surface/ — the port
    // removes that, and a control the roadmap drains goes vacuous in silence.
    const root = mkdtempSync(join(tmpdir(), "dist-roster-control-"));
    try {
      const skills = join(root, "plugins", "spellbook", "skills");
      mkdirSync(join(skills, "probe", "surface", "state"), { recursive: true });
      mkdirSync(join(skills, "probe-clean", "scripts"), { recursive: true });
      writeFileSync(join(skills, "probe", "surface", "state", "x.tsx"), "export {};\n");
      writeFileSync(join(skills, "probe", "bunfig.toml"), "[serve.static]\n");
      writeFileSync(join(skills, "probe-clean", "scripts", "cli.ts"), "export {};\n");
      const git = (...a: string[]) =>
        Bun.spawnSync(["git", ...a], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(git("init", "-q").exitCode).toBe(0);
      expect(git("add", "-A").exitCode).toBe(0); // the INDEX is what ships; no commit needed
      expect(trackedBuildInputs("probe", root).sort()).toEqual([
        "plugins/spellbook/skills/probe/bunfig.toml",
        "plugins/spellbook/skills/probe/surface/state/x.tsx",
      ]);
      // …and the clean sibling, in the SAME repo, measures empty — so the two
      // paths above came from the predicate discriminating, not from a
      // function that returns the whole index.
      expect(trackedBuildInputs("probe-clean", root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("positive control — the tracked-file count CAN be zero", () => {
    // Without this, ARM 1's greens are unfalsifiable: a `git ls-files` that
    // silently returned the whole index (wrong pathspec, wrong cwd) would give
    // every spell a non-zero count and the ward would pass by construction.
    // A spell that does not exist must measure 0.
    expect(trackedDistFiles("no-such-spell-6f3a1c")).toEqual([]);
    // …and a real one must not, in the SAME run, so the instrument is shown
    // discriminating rather than merely capable of returning empty.
    expect(trackedDistFiles(rows[0].spell).length).toBeGreaterThan(0);
  });
});
