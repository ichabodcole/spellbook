---
type: artifact
title: "Sprint 06 D6: second-seat calibration of four wards"
description:
  roster-drift, gate-honesty, strict-parse-invariant and the rewritten
  terminator-invariant, each run against one planted defect per cell family in a
  detached git worktree, with pass / fail / CELLS per run and the cell count
  reconciled against the real tree.
status: stable
generated: { by: claude-opus-5-5, at: 2026-09-27 }
---

# Sprint 06 D6: calibration of four wards

Part of
[terminator-ward-over-the-registry](../../../../items/terminator-ward-over-the-registry.md).
Run on 2026-09-27 against `0adb8fe5` (the terminator-invariant rewrite on top of
`41065365`) by a seat that wrote none of roster-drift, gate-honesty or
strict-parse-invariant. It did write terminator-invariant, so that ward's
calibration is the author's, not a no-stake reader's.

## Method

```
git worktree add --detach <scratch>/d6wt HEAD     # never a directory copy
(cd <scratch>/d6wt && bun install)
python3 calibrate.py <scratch>/d6wt <ward>        # baseline, then each plant
git worktree remove --force <scratch>/d6wt
```

`calibrate.py` (a scratch script, not committed) applies one plant as an exact
string edit, file creation or directory creation, and stops if the edit does not
apply. It runs `bun test grimoire/<ward>.test.ts` in the worktree, prints
`pass / fail / CELLS` and the failing cells, and restores the files. After the
last run, `diff -rq` of `src`, `grimoire`, `scripts`,
`plugins/spellbook/skills`, `README.md` and `.claude-plugin` against the main
worktree was empty, so every plant was reverted before the worktree was removed.

A plant counts only if it turns red a cell of the family it targets. A ward that
stays green against a plant is vacuous for that family.

## roster-drift: 17 cells

**Reconciled:** 2 standalone cells, plus 4 listings × (non-empty + listed), plus
3 two-way listings × orphaned, plus 4 calibration cells: 2 + 8 + 3 + 4 = **17**.
Baseline `pass 17 / fail 0 / CELLS 17`.

| plant                                                                                | result                        | cells that went red                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| R1 new folder `skills/zeta-plant`, in no listing                                     | `pass 13 / fail 4 / CELLS 17` | "every asserted spell folder is listed" × 4 (both READMEs, trigger registry, marketplace tags) |
| R2 README row `zeta-plant` with no folder                                            | `pass 16 / fail 1 / CELLS 17` | README "every listed name has a folder"                                                        |
| R3 README header reworded `Spell \| Kind` → `Charm \| Sort` (zero rows)              | `pass 15 / fail 2 / CELLS 17` | README "parses to a non-empty set", README "listed"                                            |
| R4 `PINNED` gains `bounty`, which every listing declares (stale pin)                 | `pass 16 / fail 1 / CELLS 17` | "every PINNED spell is still undeclared"                                                       |
| R5 `folderRoster` returns nothing (`.filter(() => false)`)                           | `pass 13 / fail 4 / CELLS 17` | clause (i) zero-guard, and "every listed name has a folder" × 3                                |
| R6 `tableColumn` reads code spans from prose after the table                         | `pass 11 / fail 6 / CELLS 17` | the three calibration cells on table scope, and "orphaned" × 3 on the real tree                |
| R7 `tableColumn` falls back to any first-column code span when the header is missing | `pass 16 / fail 1 / CELLS 17` | "a reworded header yields ZERO"                                                                |

R5's first version (`.filter((d) => d.isFile())`) was not a clean zero: the
skills directory holds files, so it tested a different defect. It went red too
(`pass 10 / fail 7`), but it is not the zero-guard plant; the table records the
second version.

**Verdict: calibrated.** Every family went red. The ward's own header already
states its blind spots (names only; marketplace tags checked one way; no
SKILL.md check), and they are not vacuity: a tag for a removed spell was not
planted, because the header says the ward cannot see it.

## gate-honesty: 6 cells

**Reconciled:** 3 in "gate honesty ward" (clause (i), blind set moved,
declaration non-empty) + 3 calibration arms (root 1, root 2, false positive) =
**6**. The plan says 5; the root-2 arm (R5, 2026-08-31) is the sixth. Baseline
`pass 6 / fail 0 / CELLS 6`.

| plant                                                                        | result                      | cells that went red                                           |
| ---------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| G1 a declared blind file grows one line (`src/digestify/surface/styles.css`) | `pass 5 / fail 1 / CELLS 6` | "the blind set has not moved"                                 |
| G2 the instrument's default skills root becomes `plugins/spellbook`          | `pass 5 / fail 1 / CELLS 6` | clause (i) (the `REAL_ROOTS` guard)                           |
| G3 `DECLARED_BLIND` emptied at load                                          | `pass 4 / fail 2 / CELLS 6` | "declaration is not empty", "blind set has not moved"         |
| G4 the instrument drops root 1's blind files                                 | `pass 4 / fail 2 / CELLS 6` | ROOT 1 arm, "blind set has not moved"                         |
| G5 the instrument drops root 2's blind files                                 | `pass 4 / fail 2 / CELLS 6` | ROOT 2 arm, "blind set has not moved"                         |
| G6 the instrument calls every non-doc file blind                             | `pass 2 / fail 4 / CELLS 6` | false-positive arm, both root arms, "blind set has not moved" |
| G7 the line unit drifts to `split("\n").length`                              | `pass 3 / fail 3 / CELLS 6` | both root arms, "blind set has not moved"                     |

Not planted: a new blind file entering the real tree. The instrument lists files
with `git ls-files`, so the plant must be staged in the worktree, and this
seat's harness refuses git commands aimed outside its own worktree. The same
family is exercised by the ROOT 1 and ROOT 2 arms, which commit a new blind file
into a fixture repo, and G1 shows the real-tree cell reads the world.

**Verdict: calibrated.**

## strict-parse-invariant: 3 cells

**Reconciled:** zero-denominator guard, strict pin (11 invocations), mechanism =
**3**. Baseline `pass 3 / fail 0 / CELLS 3`.

| plant                                                                    | result                      | cells that went red        |
| ------------------------------------------------------------------------ | --------------------------- | -------------------------- |
| S1 the registry's per-row parse becomes `strict: false`                  | `pass 2 / fail 1 / CELLS 3` | strict pin                 |
| S2 the same parse omits `strict` (the convention half)                   | `pass 2 / fail 1 / CELLS 3` | strict pin                 |
| S3 a new strict `parseArgs` call arrives (`src/bounty/backend/plant.ts`) | `pass 2 / fail 1 / CELLS 3` | strict pin (count 11 → 12) |
| S4 `PARSES_ARGS` matches nothing                                         | `pass 1 / fail 2 / CELLS 3` | zero-guard, strict pin     |

The mechanism cell pins `node:util`'s behaviour (`strict` refuses, the default
is strict, `--k=v` parses). No defect in this tree can reach it; only a runtime
change can. It is calibrated by construction (it asserts both the refusing and
the permissive shape), not by a plant.

**Verdict: calibrated.**

## terminator-invariant (rewritten, `0adb8fe5`): 7 cells

**Reconciled:** zero-denominator guards, one-`Cli`-per-adopter, rebuild equals
declaration, the warning drive (311 cases), the pin (9 adopters / 114 rows with
positionals / 311 cases, per adopter), mechanism, registry-is-the-only-parser =
**7**. The scope doc counted 5 on the old ward. Baseline
`pass 7 / fail 0 / CELLS 7`.

| plant                                                                             | result                      | cells that went red                               |
| --------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------- |
| T1 `warnDemoted` returns at once                                                  | `pass 6 / fail 1 / CELLS 7` | warning drive (all 311 cases, measured in part 1) |
| T2 the warning goes to stdout                                                     | `pass 6 / fail 1 / CELLS 7` | warning drive                                     |
| T3 only rows with a variadic positional warn                                      | `pass 6 / fail 1 / CELLS 7` | warning drive                                     |
| T4 a warned call returns 0 without running the row                                | `pass 6 / fail 1 / CELLS 7` | warning drive                                     |
| T5 `backendSources()` returns nothing                                             | `pass 5 / fail 2 / CELLS 7` | zero-denominator guards, pin                      |
| T6 scriptorium stops exporting `cli`                                              | `pass 5 / fail 2 / CELLS 7` | one-`Cli`-per-adopter, pin                        |
| T7 the rebuild drops `globalFlags`                                                | `pass 5 / fail 2 / CELLS 7` | rebuild equals declaration, warning drive         |
| T8 an astrolabe row with no positionals gains one                                 | `pass 6 / fail 1 / CELLS 7` | pin (114 → 115 rows)                              |
| T9 a caller-facing `parseArgs` with `allowPositionals: true` outside the registry | `pass 6 / fail 1 / CELLS 7` | registry-is-the-only-parser                       |

The mechanism cell is `node:util`'s behaviour, as in strict-parse. Short
aliases, `check` hooks, a row's `allowPositionals: false`, spell-side argv
handling and the root-level `--` are outside this ward by its header, so they
were not planted.

**Verdict: calibrated**, by its author (see the first paragraph).

## Findings

- No ward stayed green against a plant, so nothing was vacuous and no item was
  filed.
- The cell counts in [phase-2-scope.md](./phase-2-scope.md) hold for
  roster-drift (17), gate-honesty (6) and strict-parse-invariant (3).
  terminator-invariant's 5 is superseded by the rewrite's 7.
- Two cells cannot be calibrated by a plant in the tree: the `node:util`
  mechanism cells in strict-parse-invariant and terminator-invariant. They pin a
  dependency's behaviour, and a runtime upgrade is the only defect that reaches
  them.
