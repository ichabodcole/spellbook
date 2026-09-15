# Phase 0 — the ratchet

**Branch:** `feat/type-debt-ratchet` (from `develop`) · **Date:** 2026-09-10 ·
**Status:** built, calibrated, green **Decisions:**
[`decision-log.md`](./decision-log.md) T1–T9

⛔ **THIS PHASE FIXED NO TYPE ERRORS, BY DESIGN.** `bunx tsc --noEmit` says 584
before this branch and 584 after it. Two files were added, both of them clean;
one temporary fix was made to `src/kit/wire/serveDist.ts` to drive the
fall-handling calibration and was reverted in the same command.

---

## What was built

| file                                      | role                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scripts/instruments/type-debt-census.ts` | runs `tsc --noEmit`, classifies every error into a tree-derived area, prints JSON. **Reports.** |
| `grimoire/type-debt-ratchet.test.ts`      | invokes it, prints the finding on every gate run, pins `DECLARED_BASELINE`. **Gates.**          |

The pair is `gate-blind-set.ts` + `gate-honesty.test.ts` followed rather than
imitated (T1); the `number | null` return discipline is
`grimoire/lib/dist-artifacts.ts`'s, adopted wholesale (T1).

## The derived area list, with its baseline

32 areas, 584 errors, **15 of them at zero and every one of them a row in the
pin** — an area that is clean is a fact the ward has to state, because the day
it stops being clean is the day the row must already be there.

| area                      | errors | shipped | tests | files |
| ------------------------- | -----: | ------: | ----: | ----: |
| `src/bounty/backend`      |    125 |      71 |    54 |     6 |
| `src/grapevine/backend`   |    104 |      73 |    31 |     6 |
| `src/imago/backend`       |     99 |      16 |    83 |     9 |
| `src/glamour/backend`     |     49 |      26 |    23 |    16 |
| `src/magpie/backend`      |     38 |       9 |    29 |    15 |
| `src/grapevine/surface`   |     37 |      37 |     0 |    34 |
| `src/imago/surface`       |     36 |      21 |    15 |    43 |
| `scripts`                 |     27 |      27 |     0 |    14 |
| `plugins`                 |     21 |       2 |    19 |    30 |
| `src/astrolabe/backend`   |     19 |       2 |    17 |     6 |
| `grimoire`                |     14 |       1 |    13 |    20 |
| `src/digestify/backend`   |      8 |       2 |     6 |     3 |
| `src/bounty/surface`      |      3 |       3 |     0 |    29 |
| `src/astrolabe/surface`   |      1 |       1 |     0 |    15 |
| `src/kit`                 |      1 |       1 |     0 |    20 |
| `src/magpie/surface`      |      1 |       1 |     0 |    18 |
| `src/mind-mapper/backend` |      1 |       1 |     0 |    57 |
| `(generated)`             |      0 |       0 |     0 |    24 |
| `(repo root)`             |      0 |       0 |     0 |     1 |
| `docs`                    |      0 |       0 |     0 |     4 |
| `src`                     |      0 |       0 |     0 |     1 |
| `src/astrolabe`           |      0 |       0 |     0 |     1 |
| `src/bounty`              |      0 |       0 |     0 |     3 |
| `src/digestify`           |      0 |       0 |     0 |     4 |
| `src/digestify/surface`   |      0 |       0 |     0 |    32 |
| `src/glamour`             |      0 |       0 |     0 |     2 |
| `src/glamour/surface`     |      0 |       0 |     0 |    19 |
| `src/grapevine`           |      0 |       0 |     0 |     2 |
| `src/imago`               |      0 |       0 |     0 |     1 |
| `src/magpie`              |      0 |       0 |     0 |     1 |
| `src/mind-mapper`         |      0 |       0 |     0 |     1 |
| `src/mind-mapper/surface` |      0 |       0 |     0 |   107 |

**584 total · 294 shipped · 290 in test files** — the proposal's by-kind split,
reproduced exactly. (The `files` column counts every source file in the area,
not the ones with errors: `src/mind-mapper/surface`'s 107 files carry zero
errors, and `src/bounty/backend`'s 6 carry 125.)

**Coverage, both numbers, asserted and not merely printed:** areas 32 measured
of 32 in the tree; files 544 examined of 544. Class distribution: TS2532 ×193,
TS2345 ×114, TS18048 ×79, TS2454 ×53 — the proposal's numbers exactly.

## The five calibration drives

Every one driven, most of them twice — once synthetically in the ward's own
calibration `describe` (13 cells, a five-area fixture with its own
`tsconfig.json`, borrowing the repo's pinned `tsc`), and once against the REAL
tree with the mutation reverted in the same command.

### 1 — a new type error → RED, naming the area and the delta

`export const DRIVE_1_PROBE: number = "not a number";` appended to
`src/kit/wire/serveDist.ts`:

```
ROSE — area "src/kit" 1 -> 2 (+1). New type debt. Fix it, or re-declare it
deliberately and say why.
```

11 pass / **2 fail** (the movements cell and the arithmetic cell, the second
because the declared total 584 no longer held). Reverted; `git diff` empty.
Synthetic twin: _"a RISE in a BACKEND area is named, with its delta, and the
peer areas do not move."_

### 2 — a real fix → RED, with the instruction (T4)

`refsIn`'s `.filter((ref) => !!ref && …)` given a real type predicate
(`(ref): ref is string =>`) — an honest fix, not a silencing:

```
FELL — area "src/kit" 1 -> 0 (-1). Good news, and THE BASELINE IS NOW STALE:
lower it to 0. ⛔ First establish that 1 error(s) were FIXED and not silenced —
an `arr[i]!`, an `as any`, a `@ts-expect-error`, a deleted file, or a
de-duplication that hid an indexed read behind a parameter (D64) all lower this
number with nothing fixed.
```

Reverted with `git checkout --` on that one path. Synthetic twins: the FELL arm,
and _"a MOVED file lowers one area and raises another, and BOTH halves are
named"_ — which is the D64 refactor driven as a two-line verdict.

### 3 — a ZERO area stays green and is VISIBLE

**15 areas at zero on the real tree**, all fifteen rows in the pin and in the
printed census, including `docs`, `src/digestify/surface`, `src/glamour/surface`
and `src/mind-mapper/surface` (107 clean files). `src/kit` was not needed as the
zero subject — the brief offered it at 1, and the derivation found fifteen
genuine zeros instead. The synthetic control arm asserts all five fixture areas
are present at 0 and that `areas.length === 5`; an absent row would pass a "no
rises" check and be the D42 silence.

### 4 — an unmeasurable area says NOT LOOKED AT (T5)

Driven twice on the real `tsconfig.json`, and the two results are different,
which is the finding:

| mutation                 | result                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"exclude": ["docs"]`    | `docs` → `errors: null`, note _"NOT LOOKED AT — 4 source file(s) in the tree, none in tsc's program"_, `areasMeasured` 31 of 32. 11 pass / **2 fail**.                                                                                                                                                 |
| `"exclude": ["src/kit"]` | `src/kit` **still measured**, still reporting its 1 error. All eight spells import from the kit, so resolution re-admitted those files; what left silently were the **nine kit files nobody imports** — `filesExamined` 544 → **535**. 12 pass / **1 fail**, caught by the FILE-count assertion alone. |

Synthetic twin plants a real error inside the excluded area, so the arm
distinguishes "not looked at" from "looked at and clean" rather than assuming
it, and asserts `errors` is `null` — not 0 — with the population's two numbers
diverging 4 of 5.

### 5 — the gate's wall time

Both runs unpiped, exit read from a file, on the same tree:

| gate                | wall      | result                        |
| ------------------- | --------- | ----------------------------- |
| without the ratchet | **180 s** | 2022 pass / 0 fail, 161 files |
| with the ratchet    | **188 s** | 2035 pass / 0 fail, 162 files |

**+8 s, +4.4%** — the brief's ~4% estimate, reproduced.
`bun scripts/dist-check.ts` exit 0, all three arms, `dirty paths 0`.

## What a refactor could do to a count with nothing fixed

The brief's fourth trap, answered concretely. Five routes, and what you would
see:

| route                                                                    | what you would see                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arr[i]!`, `as any`, `?? fallback`, `@ts-expect-error`                   | a **FELL** verdict, whose sentence names all four by name (R3's whole subject)                                                                            |
| deleting a file                                                          | a **FELL** verdict, plus `filesInTree` down by one in the printed row                                                                                     |
| **moving a file to another area**                                        | **TWO** verdicts in one run — FELL on the source, ROSE on the destination. Driven synthetically.                                                          |
| **a de-duplication that hides an indexed read behind a parameter** (D64) | a **FELL** verdict. This is the exact route that reduced the spawn-path ward's coverage silently; it cannot be silent here, which is T4's whole argument. |
| **a rebuild** (`bun run build`)                                          | movement in `(generated)` ONLY — the reason that bucket exists rather than folding into `plugins` (T7).                                                   |
| renaming an area's directory                                             | **DEPARTED** on the old name and **ARRIVED** on the new, with the instruction to find the other half.                                                     |

The one thing the count genuinely cannot discriminate is a fix and a fresh
defect in **one area at one commit**. That is stated in the ward's "what a green
does not mean" block, and it is why the areas are as fine as T3 makes them.

## Defects found in this instrument, by driving it

Four, all found by calibration rather than by reading, all fixed:

1. **The population could not contain the subject** (T7) — `.ts`/`.tsx` only, so
   the 24 emitted `dist/*.js` bundles existed in the measurement and had no row
   in the population; `areasMeasured` came out ABOVE `areasInTree`, C4's
   arithmetic inverted.
2. **tsc's summary line has three shapes and the first version read one** (T6) —
   the fixture's `Found 1 error in src/alpha/backend/a.ts:1` produced
   `toolReportedErrors: null` and the agreement check correctly refused the run.
   The self-check caught a defect in the self-check on its first run.
3. **`realpathSync`** (T8) — macOS's `/tmp` → `/private/tmp` symlink emptied the
   examined set; the closure check caught it.
4. **The 5,000 ms default test timeout** (T2) — a 6-second `tsc` reported as
   "the instrument produced no report", exit 143.

## What Phase 1 inherits

- The ratchet is green and in the gate. **The first thing Phase 1 does to it is
  lower two numbers** — `grimoire` 14 and `scripts` 27 — and the ward will
  demand a re-declaration paragraph for each, which is the mechanism working.
- `scripts`'s 27 are concentrated: `r8-outcome-check-v{1,2,3}.ts` (6 + 9 + 6)
  and `canon-ledger-ward.ts` (6) carry 27 of 27. Four files.
- `grimoire`'s 14 are 1 in `grimoire/lib/entry-points.ts` and 13 across four
  test files (`rule-id` 6, `daemon-lifecycle-ward` 4, `flag-invariant` 2,
  `dist-roster-ward` 1).
- ⚠ **A number in this ward will move the moment anyone edits an instrument, and
  that includes Phase 1's own work on the census.** Re-declare in the same
  commit, with the account.
