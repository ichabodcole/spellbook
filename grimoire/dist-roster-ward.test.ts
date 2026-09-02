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
// The arms are imported rather than re-derived, so this cell and CI cannot
// disagree about what the roster is.
import { describe, expect, test } from "bun:test";
import { roster, trackedDistFiles } from "../scripts/dist-check.ts";

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
