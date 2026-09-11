# Phase 1 — our own instruments first

**Branch:** `feat/type-debt-phase-1` (from `develop`) · **Date:** 2026-09-10 ·
**Status:** complete, calibrated, green **Decisions:**
[`decision-log.md`](./decision-log.md) **T10–T15**

**`grimoire` 14 → 0 · `scripts` 27 → 0 · repo total 584 → 543 (−41, exactly what
was fixed).** No file deleted, no `!`, no `as any`, no `@ts-expect-error`, no
`?? ` standing in for an invariant.

---

## 1 · ⛔ The r8 verdict: NOT DEAD. Nothing was deleted

The brief opened by asking whether `r8-outcome-check-v1.ts` and `-v2.ts` were
still live, because **21 of the phase's 41 errors sit in three versioned copies
of one instrument**, and offered that a dead instrument should be deleted rather
than typed. **Established: all three are live logic pointed at a stale root.**
Full argument in **T10**; the establishment, in the order it was done:

**a. Grep — necessary and not sufficient.** Nothing references v1 or v2
anywhere. v3 appears in two sprint docs and `.anthill/retro.md` as a manual
command.

**b. Every execution route, checked rather than assumed.** `package.json`
scripts (six, none of them), `bun test` (collects `*.test.ts`; these are `.ts`
scripts), `.husky/pre-commit` (`lint-staged` → biome/prettier),
`.github/workflows/ci.yml` (`bun run gate` + `dist-check.ts`), and local imports
— **every `scripts/instruments/*.ts` imports node/bun builtins ONLY.** No
automated path runs any of the three. A deletion argument would normally stop
here.

**c. ⭐ Then they were RUN, and that is what refuted the hypothesis.** All three
exit 1 with **`ZERO-DENOMINATOR — verdict withheld`**. Their root is a hardcoded
`…/plugins/spellbook/skills`, and the backend convergence moved every dispatcher
to `src/<spell>/backend/`; the 26 files still there are Phase 3's thin
LAUNCHERS, with zero dispatch branches (confirmed by independent grep).

**d. The positive control that settled it.** Re-pointed at `src/` — one `sed` on
a scratch copy, nothing in the tree:

| instrument | at the stale root       | against `src/`                          |
| ---------- | ----------------------- | --------------------------------------- |
| v1         | 0 files, withheld       | 154 files · 294 branches · 476 captures |
| v2         | 0 dispatchers, withheld | 25 dispatchers · 287 branches           |
| v3         | 0 dispatchers, withheld | **three-way calibration ✅ ✅ ✅**      |

**v3's arms still convict `imago context.add`, clear `bounty task.add`, and see
the v2-blind `magpie element.add`.** An instrument whose calibration arms all
fire is not dead. **"Nothing greps it" was true and would have been the wrong
answer.**

⚠ Three consequences, reported and deliberately NOT fixed here (T13):
`cold-read.md:87` and sprint 06's `plan.md:158` cite a v3 result the command no
longer reproduces; `.anthill/retro.md:552`'s **H1 is falsified by the
relocation**, not by the fix it predicted would wear out; and the root is an
absolute path to one machine's checkout while the house idiom is an env override
(`SKILLS_DIR`, `TYPE_DEBT_ROOT`, `CANON_DIR`). Re-pointing it is a BEHAVIOUR
change — it turns three withheld verdicts into real ones, one reporting ~113 RED
rows — and belongs on its own branch, not inside a type commit.

---

## 2 · ⭐ The reachable-`undefined` list: it is EMPTY, and the shape is the finding

R3's stated deliverable. **Read one at a time, none of the 41 was reachable.**
39 of 41 fall into four mechanical shapes that cannot produce `undefined`:

| shape                                                               | sites | why unreachable                                          |
| ------------------------------------------------------------------- | ----: | -------------------------------------------------------- |
| regex ALTERNATION — `m[1] ?? m[2]`                                  |     4 | each alternative has exactly one group; a match sets one |
| regex MANDATORY group — `m[1].trim()`                               |     9 | one alternative, group not optional                      |
| indexed read in a BOUNDED loop — `marks[i]`, `group[k]`, `lines[j]` |    24 | the bound is the array's own `.length`                   |
| `rel.split("/")[0]`                                                 |     4 | `String.split` always yields ≥ 1 element                 |
| **`rows[0]` guarded in ANOTHER CELL**                               | **1** | the only site whose guard was not local                  |

**The one site worth the exercise, at its honest size.**
`grimoire/dist-roster-ward.test.ts:220` reads `rows[0].spell` in a
positive-control cell whose non-emptiness is asserted in ARM 1, a **different
cell**. Driven under a forced-empty roster, **the original already failed** —
`TypeError: undefined is not an object (evaluating 'rows[0].spell')`. So the
vacuity it looked like was never open; the named throw buys a cell that says WHY
it cannot run. ⚠ **The first draft of that code comment claimed it closed a
vacuity, and the comment was corrected before commit** — a ward comment that
overclaims is the same defect as a ward that overclaims.

⚠ **What Phase 2 must NOT inherit.** "Zero reachable" is a claim about 41 of 584
errors in TOOLING — code that walks trees with its own loop bounds. The three
big backends are 404 errors of request handling and state, where an index comes
off a wire payload rather than a `for` bound. Inherit the TABLE (the shapes to
triage fast), not the zero.

**And it is not an argument for `!`.** The invariant that is true today is what
`must(v, "…")` states and `!` conceals. See **T11**.

---

## 3 · The fix idiom, and the third dishonest option R3 does not name

R3 names `arr[i]!` and `?? fallback`. Driving this phase found a worse one, and
it is the one a careful engineer reaches for first:

```ts
const mark = marks[i];
if (!mark) continue; // ← looks responsible. It is the D64 defect.
```

⛔ **In an instrument, an element skipped is an element that LEFT THE
DENOMINATOR** — D64 exactly, where `pins` went 6 → 5 with nothing changed and
nothing reddened. So every read is one of two things and the fix says which:
`must(v, "<invariant>")` where absence is impossible, an explicit named branch
where it is real. `grimoire/lib/must.ts` (new, 4 wards import it);
`scripts/instruments/*` keeps local copies because every file there imports
builtins only and the r8 trio's independence is its evidentiary value.

⭐ **Both halves live in ONE statement in `canon-ledger-ward.ts`**, which makes
it the phase's best teaching site: `scored[0]` cannot be absent, while `scored`
being EMPTY is entirely real (the pairing is injective, so the pool exhausts).
Driven with the ledger cut to 2 rows: 2 rules pair and **17 are RECORDED as
unmatched — 2 + 17 = 19, the full denominator.** A `continue` there would have
reported `unmatched: 0` over a population of 2, and passed.

---

## 4 · Eleven re-calibration drives — every touched ward seen RED

⛔ The phase's hard constraint: **these files are instruments, so a type fix can
change what they CATCH** (D27, D43, D64, C10). A ward that still passes is not
evidence. Every drive was mutated, run, reverted, and re-run green.

| #   | ward / instrument                          | mutation                                                                | result                                                                                         |
| --- | ------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `rule-id.test.ts`                          | delete a `<!-- rule-id: … -->`                                          | **RED** — `L19 (h3) Architect for the reader's…`; one drive proves `line`, `depth` AND `title` |
| 2   | `rule-id.test.ts`                          | same heading `###` → `####`                                             | **RED** naming **`h4`** — so `m[1].length` is genuinely read, not a constant                   |
| 3   | `flag-invariant.test.ts`                   | document `--zzz-bogus-flag` in `glamour/SKILL.md`                       | **RED** — `unrecognized: ["zzz-bogus-flag"]`, through the `documented` map I changed           |
| 4   | `lib/entry-points.ts` (via flag-invariant) | add a QUOTED `"zzz-probe-flag"` to glamour's flag map                   | **RED** — `undocumented: ["zzz-probe-flag"]`; exercises the `k[1]` alternative                 |
| 5   | `lib/entry-points.ts`                      | (control) the 10 green cells are all BARE-identifier flags              | covers the `k[2]` alternative — a broken `k[2]` would empty `all` and red every spell          |
| 6   | `daemon-lifecycle-ward.test.ts`            | strip `idleTimeout` from `src/glamour/backend/server.ts`                | ⛔ **STAYED GREEN — a pre-existing ward defect, see §5**                                       |
| 7   | `daemon-lifecycle-ward.test.ts`            | strip `idleTimeout` from `src/astrolabe/backend/server.ts`              | **RED** naming the file, through the `src/` enumerator I edited                                |
| 8   | `daemon-lifecycle-ward.test.ts`            | population parity, my version vs HEAD                                   | **daemons 8, clis 14 — identical.** No silent shrink                                           |
| 9   | `dist-roster-ward.test.ts`                 | remove astrolabe's whole tracked `dist/` from disk                      | **RED** — `astrolabe:5/0`, ARM 1b                                                              |
| 10  | `dist-roster-ward.test.ts`                 | force `rows = []`                                                       | **RED** with my named precondition (and see §2 for the honest counterfactual)                  |
| 11  | `canon-ledger-ward.ts`                     | ×3 — delete a ledger row · cut the ledger to 2 rows · add an orphan row | **exit 1 ×3**: `unmatched 1`, `unmatched 17`, `orphan 1`; unmutated canon **exit 0, PASS**     |
| 12  | `r8-outcome-check-v3.ts`                   | give imago's `context.add` a distinguishing return                      | **RED arm flips ✅ → ❌** while GREEN and v2-BLIND hold — a discriminating drive               |
| 13  | `r8-outcome-check-v{1,2,3}.ts`             | fixture: split one branch's discriminant                                | v2/v3 **1 dispatcher / 4 branches → 0 / 0 → 1 / 4**; **v1 reports 4 regardless**               |

⭐ **Drive 13 is the one worth reading twice.** It calibrates the `for(;;)`
grouping walk I restructured in v2 and v3 — the phase's riskiest edit, a
control-flow change inside a predicate — **and in the same run re-demonstrates
v1's documented defect**, that it never grouped by discriminant. The specimen
value `c4d669eb` kept v1 for reproduces on demand, through the typed code.

**And the strongest single piece of evidence, for the three files with no
self-calibration:** v1, v2, v3 and `canon-ledger-ward` reproduce their
pre-change reports **BYTE-FOR-BYTE** — v1's 286-line report, v2's 46, v3's 151,
canon's 19-rules/19-rows PASS — against both their real root and `src/`,
re-verified after `biome --write`. That is `c4d669eb`'s own discipline for
touching these files, reused.

---

## 5 · ⛔ Five pre-existing ward defects, found by mutation and not by typing

> ⭐ **ALL FIVE WERE REPAIRED 2026-09-10 on `fix/wards-that-pass-on-prose`**
> (decision log **T16–T20**; register rows **C9, C11, C12–C16**), each
> re-calibrated by mutation in both directions. ⚠ **And #6's stated MECHANISM
> was falsified there:** `bun test` runs test files sequentially and the ratchet
> awaits its `tsc` child, so it does not compete with the peer at all — the
> flake is `ensureDaemon`'s 10-second boot budget against a 5,000 ms framework
> default, and it now reproduces on demand (T20). Nothing else in this section
> changed.

**None caused by this phase. None would have been found by reading.** Full
detail in **T13**.

1. ⛔ **`daemon-lifecycle-ward`'s `idleTimeout` clause is satisfied by a
   COMMENT.** `!/idleTimeout\s*:/.test(d.text)` over raw file text. Deleting the
   real setting from glamour left the ward **GREEN (5 pass / 0 fail)** — because
   line 408 discusses `` `idleTimeout: 255` `` in prose. **glamour, imago and
   bounty** all carry such a mention, and two of them are in the ward's own list
   of the three spells it was written from: **the clause cannot convict two of
   its three founding cases.**
2. **The tracked-vs-disk cell only convicts a TOTALLY empty `dist/`.** Removing
   one of five artifacts printed `astrolabe:5/4` in the ward's own output and
   reddened nothing (`r.tracked > 0 && r.disk === 0`).
3. **`expect(r.disk).toBeGreaterThanOrEqual(0)` is vacuous** — a count is always
   ≥ 0 — inside the cell named _"a green cannot mean unexamined"_.
4. **`daemon-lifecycle-ward`'s population guard is a FLOOR, not a parity pin:**
   `>= 7` against actuals of **8** and **14**. A shrink from 14 to 7 passes
   silently — the D64 shape, in the guard whose job is to catch it.
5. **The r8 trio's stale hardcoded root**, and the two docs citing numbers it no
   longer reproduces (§1).

⛔ **Not one was fixed here, deliberately.** Each changes what a ward CATCHES;
folded in, counts would move for two unrelated reasons at once — and #1 will red
on three real daemons the moment it is repaired.

⚠ **Also found:** the `spell` field that `daemons()` and `clis()` both compute
is **read by no cell in the ward** (`grep '\.spell'` returns nothing; all three
clauses map `d.file`). **Four of `grimoire`'s fourteen errors were in a field
nothing consumes.** Left in place — deleting a struct field is a behaviour
question.

---

## 6 · The ratchet's fall path, exercised deliberately

**The FELL message, as printed, before the baseline was touched:**

```
FELL — area "grimoire" 14 -> 4 (-10). Good news, and THE BASELINE IS NOW STALE:
lower it to 4. ⛔ First establish that 10 error(s) were FIXED and not silenced —
an `arr[i]!`, an `as any`, a `@ts-expect-error`, a deleted file, or a
de-duplication that hid an indexed read behind a parameter (D64) all lower this
number with nothing fixed.

FELL — area "scripts" 27 -> 0 (-27). Good news, and THE BASELINE IS NOW STALE:
lower it to 0. ⛔ First establish that 27 error(s) were FIXED and not silenced …
```

`11 pass / 2 fail` — the movements cell and, separately, the arithmetic cell.

### ⭐ And the FELL is what caught a LOST FIX — T4 earned its argument inside one phase

**Read that first message again: `grimoire` 14 → 4, not 14 → 0.** A measurement
harness in this session ran
`git checkout -- grimoire/daemon-lifecycle-ward.test.ts` and **destroyed four
finished edits.** A direct `tsc | grep` had already reported ZERO for that file
and was stale. The ratchet's arithmetic cell disagreed — **547 against a
declared 543** — and that disagreement is the only reason the loss was found.
The edits were re-applied and the drives affected (7 and 8) re-driven against
the real code.

**T4's case for failing on a fall was built on a fix being FAKED. The first real
incident was a fix being LOST.** An auto-lowering ratchet books both as
progress. Two cells were needed and neither was redundant: the movements cell
named the areas, the arithmetic cell (D27, total held separately) caught the
4-error gap that looked like a legitimate partial fall.

### The deliberate lowering

`grimoire: 14 → 0`, `scripts: 27 → 0`, `DECLARED_TOTAL: 584 → 543`, with a
re-declaration account above the pin that answers the FELL sentence **route by
route** — no `!`/`as any`/`@ts-expect-error`/`?? `, **no file deleted** (T10),
**no D64 de-duplication** (T12, two near misses argued), and one file ADDED
(`grimoire/lib/must.ts`, clean, so the area still lands on 0).

Ratchet after: **13 pass / 0 fail**, 543 errors in 60 files (tsc's own total
543), 32 areas of 32 measured, 545 files of 545 examined, **17 areas at ZERO**
(was 15).

### Three things to correct, in Phase 2's interest (T15)

1. ⚠ **The FELL sentence asks for an account and names nowhere to put it.**
   Every incentive at that moment points at editing one integer. The account
   exists because the brief demanded it, **not because the instrument asked.**
   Adding _"and record the account beside the pin"_ is the one edit that makes
   the mechanism self-sustaining.
2. ⚠ **A file added while fixing moves `filesInTree` and nothing pins it.**
   `must.ts` took `grimoire` 20 → 21 and the repo 544 → 545; both numbers are
   asserted equal TO EACH OTHER, so the pair closes and nothing reds. Correct —
   a file count is not debt — but T5's third assertion is the one that caught
   the `exclude` on an imported area, and it is satisfied by two numbers moving
   together. Belongs in the ward's "what a green does not mean" block, which
   today does not mention file counts.
3. ⚠ **The 7.5 s cell is fine; the cost is running it ALONE.** Reaching for
   `bunx tsc --noEmit | grep` instead is what went stale and hid the lost edit.
   **A grep is not a second opinion — it is a second predicate**, which T1
   forbids for exactly this reason. The census is the only reader whose
   arithmetic closes.

**Nothing about the fall path was wrong.** It fired on both areas, in the right
direction, with the right deltas, and it caught an error the phase's own author
had already convinced himself was not there.

---

## 7 · What the measurements contradict

- ✅ **41 errors, 9 files, `scripts` 27 + `grimoire` 14** — exact.
- ✅ **TS2532 ×21, TS2322 ×14, TS2345 ×5, TS18048 ×1** — exact.
- ✅ **Tooling 28 / test files 13** — exact, and worth restating: 28 of the 41
  were in code that CHECKS the code, which was the phase's whole rationale.
- ✅ The per-file table reproduces exactly, all nine rows.
- ⛔ **The brief's premise that a dead instrument was probably hiding here does
  NOT hold.** 21 of 41 errors are in three live, subject-orphaned instruments,
  and the smallest-population argument for going first paid off differently than
  expected: the ratchet's fall path got debugged here, but so did the discovery
  that `scripts/instruments/` is pointed at a tree that moved.
- ⚠ **Phase 0's inheritance note said "`scripts`'s 27 are concentrated … Four
  files"** — correct, and it under-sold the consequence: **three of those four
  are the same instrument**, which is why the phase's first hour went to a
  liveness question rather than to typing.

---

## 8 · Gate

- `bunx tsc --noEmit`: **543** errors (was 584). `grimoire` **0**, `scripts`
  **0**.
- `bun run gate` **unpiped**, exit read from a file: **exit 0**, 2035 pass / 0
  fail across 162 files, 188.8 s.
- ⚠ **One earlier gate run failed on a FLAKE in a file this phase never
  touched** — ⛔ **the mechanism below is WRONG, corrected by measurement in
  T20; the observation is exact and now reproducible** — —
  `src/mind-mapper/backend/cli.test.ts`'s _"open `--port N`"_ cell, at 5004.19
  ms against `bun test`'s default 5,000 ms. Green in the two runs after, and
  2.49 s alone. **This is T2's own hazard arriving on a peer:** the ratchet
  added a ~6 s `tsc` subprocess to the suite's CPU budget and only the ratchet's
  cells got extended deadlines. Recorded as T13 #6.
- `bun scripts/dist-check.ts`: exit **0**.
- `bunx biome check --write` on every changed `.ts`, and the r8 + canon outputs
  re-verified byte-identical AFTER formatting.
- Repo root clean; no empty directories.
