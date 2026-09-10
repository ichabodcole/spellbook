# Type debt — decision log

**Series:** `T`, not `D`. **The reason is that the D-series belongs to a project
that is archived.** `docs/projects/_archive/backend-convergence/decision-log.md`
runs D1–D98 and it is closed; continuing it from a live project would put new
decisions inside an archive nobody reads and make "D99" ambiguous the day
another project does the same. Every T entry that leans on a D entry cites it by
number, and the D-series is referenced constantly below — the citations are the
continuity, not the numbering.

---

## T1 · The ratchet is a REPORT-ONLY INSTRUMENT plus a PINNING WARD, and it follows `gate-blind-set` + `gate-honesty`

**Decided:** implementer, 2026-09-10, Phase 0, on the brief's instruction to
follow the closest existing idiom rather than invent a fourth shape.

Three house idioms were read before anything was written:

| idiom                                    | shape                                                                                             | fit                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `scripts/instruments/gate-blind-set.ts`  | a non-test script that emits JSON and exits non-zero ONLY when its own arithmetic breaks          | **the measurement half, exactly**                                                                            |
| `grimoire/gate-honesty.test.ts`          | a ward that INVOKES that script, prints the finding, and pins the answer in a `DECLARED_*` object | **the gating half, exactly**                                                                                 |
| `grimoire/import-boundary-wards.test.ts` | derived populations, per-cell coverage rows, synthetic-repo controls                              | borrowed for the CONTROL discipline; its shape is a multi-population ward and the ratchet has one population |
| `grimoire/lib/dist-artifacts.ts`         | `string[] \| null`, `null` meaning NOT LOOKED AT, enforced in the RETURN TYPE                     | borrowed wholesale for `errors: number \| null` — the brief called it the strongest form and it is           |

So the ratchet is **two files, one per half**:

- `scripts/instruments/type-debt-census.ts` — runs `tsc --noEmit`, classifies
  every error into an area derived from the tree, prints JSON. **It reports; it
  does not gate.** The only non-zero exit is its own arithmetic failing.
- `grimoire/type-debt-ratchet.test.ts` — invokes it, prints the finding on every
  gate run, and pins `DECLARED_BASELINE`.

**Why the split rather than one test file.** `gate-blind-set`'s header gives
both reasons and both hold: a `.test.ts` is COLLECTED the moment it exists, so
an in-progress instrument reds a peer's live gate; and the measurement is
independently runnable, which is what let every calibration drive below go
through the real predicate against a tree the cell built. A single ward would
also have had to re-implement the predicate to calibrate it, which is the drift
`gate-honesty`'s "⛔ IT CONSUMES … BY INVOKING IT" paragraph exists to forbid.

**Not taken:**

- _One `.test.ts` doing both._ Fewer files, and it gives up the calibration
  route and the "in progress reds the peer" protection for nothing.
- _Follow `import-boundary-wards.test.ts` instead._ It is the repo's most
  elaborate ward and its shape is about many populations over one tree. The
  ratchet has ONE population and ONE scalar per area; adopting the bigger shape
  would have been imitation rather than fit.
- _A `knownFailures`-style JSON sidecar (the `acc` idiom)._ Correct for a tool
  whose conformance report is machine-consumed. Here the declaration's VALUE is
  the prose beside it: `gate-honesty`'s twelve re-declaration paragraphs are the
  best documentation of the blind set that exists, and a JSON file has nowhere
  to put them.

---

## T2 · It runs INSIDE the gate, not as a side command

**Decided:** implementer, 2026-09-10, on the brief's measurement.

`bunx tsc --noEmit` is **~6 s** wall. `bun run gate` is **~180 s**. Measured end
to end, both unpiped with the exit read from a file:

| gate                | wall      | tests                         |
| ------------------- | --------- | ----------------------------- |
| without the ratchet | **180 s** | 2022 pass / 0 fail, 161 files |
| with the ratchet    | **188 s** | 2035 pass / 0 fail, 162 files |

**+8 s, +4.4%.** The brief's estimate was ~4% and it reproduced.

**A side command nobody runs is worse than none.** `scripts/instruments/` holds
report-only instruments because closing their subjects was out of scope; this
one's subject is in scope for the four phases that follow, and a baseline that
is only consulted deliberately cannot ratchet.

⚠ **One tsc run per test process, memoised.** Five cells at 6 s each would have
been 30 s. `gate-honesty` re-invokes its instrument per cell because its
instrument is milliseconds; copying that shape here would have been a 22-second
tax for symmetry.

⚠ **And every cell carries an explicit 120 s timeout, which is a defect fix.**
`bun test`'s default is 5,000 ms and one whole-repo `tsc` is ~6,000. Left at the
default the first cell timed out, the memoised promise it had already started
was rejected, and the other four failed with `exit 143` — a killed child
reported as _"the instrument produced no report"_. A timeout is the one failure
that makes an instrument look broken when it is merely slow.

**Not taken:** _a `bun run typecheck:ratchet` script and a CI job._ It is the
shape a 60-second check would need. At 4% there is no reason to put the ratchet
anywhere the gate is not.

---

## T3 · Areas are DERIVED from the tree, and `backend` / `surface` are SEPARATE areas

**Decided:** implementer, 2026-09-10. The derivation follows D43; the split is
argued below.

**The rule.** One classifier, `areaOf(relPath)`, run over two different sources:
every `.ts`/`.tsx`/`.js` on DISK (the population) and tsc's own `--listFiles`
output (the measurement).

- a directory under `src/` is a **spell** iff it holds a `backend/` or a
  `surface/` — the same predicate `src/build.ts`'s `buildableSpells()` uses;
- a spell's areas are `src/<spell>/backend` and `src/<spell>/surface`, plus
  `src/<spell>` for files sitting directly in it;
- anything else under `src/` is one area (today: `src/kit`);
- every other depth-1 directory of the repo is one area — `grimoire`, `scripts`,
  `plugins`, `docs`;
- `.ts` at the repo root is `(repo root)`; anything under a `dist/` is
  `(generated)`.

**No hand-kept list.** D43: _"a per-spell entry list is a hand-kept list, which
is the thing that goes blind on exactly the spell that arrives next."_ The
calibration arm _"an ARRIVING area is named rather than silently admitted"_
drives it: `src/beta/backend/f.ts` created in a fixture appears as its own area
with no edit to any list, and the pin forces someone to look at it.

**⛔ The classifier is TOTAL — every path gets an area.** A "none of the above"
branch would let an error leave every row while the total stayed right, which is
the shape of every silence D42 records. `sumOfAreas === countedErrors` is
asserted, and `unassigned` names any path that escaped.

### Why `backend` and `surface` are separate, in three parts

1. **They behave differently.** 443 backend errors against 78 surface ones, and
   the classes differ: the backend is `noUncheckedIndexedAccess`'s consequence
   (TS2532/TS18048/TS2454), the surface is prop-type mismatches (TS2345/TS2322).
2. **The proposal phases them apart.** Phase 4 is the three big backends; the
   surface's 78 are _"in scope but last."_ An area that two phases split is two
   areas.
3. **⭐ It is the masking argument, and it is the strongest of the three.** With
   per-spell areas, a commit that adds three errors to `src/grapevine/backend`
   and removes three from `src/grapevine/surface` nets to zero in one number.
   Finer areas mean fewer places a rise can hide. The calibration arm _"a rise
   in the SURFACE half does not land on the BACKEND half"_ exists to prove the
   split is real rather than aliased.

**Not taken:**

- _Per-spell areas (the proposal's table)._ Eleven rows instead of thirty-two,
  and it matches the document — at the cost of the masking hole above, and of
  hiding the fact that `src/bounty` is 125 backend + 3 surface rather than
  one 128.
- _Split each area again into SHIPPED and TEST halves._ The proposal orders work
  that way ("shipped code before test files") and 294 vs 290 says the halves are
  comparable in size. Rejected because T4's exact-equality pin already closes
  the masking hole the split would close, and doubling to ~64 pinned rows
  doubles the re-declaration cost for no new signal. **The split is PRINTED per
  area by the instrument (`shipped` / `tests`) and left unpinned** — available
  to whoever is choosing what to fix next, costing nothing.
- _A depth-2 area everywhere (`src/imago/surface/components`, …)._ Genuinely
  finer, and it makes the pin churn on every ordinary refactor that moves a file
  between sibling directories, which is a red that teaches nothing.

---

## T4 · A FALL fails, WITH AN INSTRUCTION. It does not pass, and it does not auto-lower

**Decided:** implementer, 2026-09-10, on the brief's explicit delegation
("decide whether it fails-with-instruction or auto-lowers, and argue it").

R1 says the check fails when a count RISES. It does, naming the area and the
delta. A **fall also fails**, with a different sentence:

```
FELL — area "src/kit" 1 -> 0 (-1). Good news, and THE BASELINE IS NOW STALE:
lower it to 0. ⛔ First establish that 1 error(s) were FIXED and not silenced —
an `arr[i]!`, an `as any`, a `@ts-expect-error`, a deleted file, or a
de-duplication that hid an indexed read behind a parameter (D64) all lower this
number with nothing fixed.
```

**Two arguments, and the second is the one that decided it.**

**(a) D64, twice.** A de-duplication reduced the spawn-path ward's coverage:
`resolveMode`'s inlined body became `resolveModeIn(DIST_DIR)`, `pins=6` became
`pins=5`, nothing about the spell's path behaviour changed, and **no instrument
reddened, because a coverage COUNT going down is not a failure.** Three shipped
documents then quoted a number that had been false since the commit they shipped
in. Here there are five such routes — `@ts-expect-error`, `arr[i]!`, a deleted
file, a file moved to another area, a de-duplication that hides an indexed read
behind a parameter — and **R3 exists precisely because two of them are the
dishonest fixes this project must refuse.** An auto-lowering ratchet books all
five as progress and records nothing.

**(b) ⭐ Auto-lowering opens a masking hole that exact equality closes for
free.** If a fall silently becomes the new baseline, a commit that fixes three
errors in an area's tests and introduces three in its shipped code nets to zero
and passes green. Because every movement in either direction reds, **no
compensating movement can be silent** — which is also what let T3 decline the
shipped/test sub-split.

**The cost, stated so it can be disagreed with.** Whoever fixes a type error
re-declares a number in the ward, in the same commit. That is the bargain
`gate-honesty`'s `DECLARED_BLIND` has been paying since sprint 05, and its
twelve re-declaration paragraphs are the best documentation of the blind set
that exists.

**Not taken:**

- _Pass on a fall._ Literal R1. It is the D64 silence, adopted deliberately.
- _Auto-lower on a fall (write the new number back to the file)._ The
  no-friction option, and it is the one that makes the ratchet stop ratcheting:
  the mechanism records the number and loses the reason, which is the half worth
  keeping.
- _Fail on a fall only when it exceeds some slack._ A threshold is a third
  number with no owner, and the first `-1` is exactly the D64 case.

---

## T5 · Coverage is ASSERTED THREE WAYS, because one real mutation defeated the first two

**Decided:** implementer, 2026-09-10, driven on the real tree.

D42's rule is that a subject an instrument NAMES and does not EXAMINE must
produce a row saying "not looked at", and D27 amended Phase 1b: **printing both
numbers is not enough, coverage must be ASSERTED.** So the ward asserts

1. `areas.filter(errors === null)` is empty — no area is NOT LOOKED AT;
2. `areasMeasured === areasInTree`;
3. `filesExamined === filesInTree`.

**All three are here because a real mutation is caught by only one of them, and
which one was not predictable from reading the code.** Driven on this tree:

| mutation                                    | result                                                                                   | caught by     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------- |
| `"exclude": ["docs"]` in `tsconfig.json`    | `docs` → `errors: null`, `filesExamined` 4 → 0, `areasMeasured` 31 of 32                 | (1) and (2)   |
| `"exclude": ["src/kit"]` in `tsconfig.json` | `src/kit` **still measured**, still reporting its 1 error; `filesExamined` 544 → **535** | **(3) ALONE** |

**The finding is the second row.** All eight spells import from the kit, so
module resolution re-admitted every imported kit file and the exclude was
invisible to the area-level checks; what left the program silently were the
**nine kit files nobody imports**. An `exclude` on an imported area is caught
only by the file count. Reading the predicate suggested the null would fire;
planting the mutation showed it does not — which is D44's own lesson about its
own defect ("reading the predicate suggested the wrong half").

**Not taken:** _assert only the null._ It is the strongest-looking of the three
and it is blind to the exclude that matters most — the one on code other code
imports.

---

## T6 · The tool's own total is cross-checked, and it comes in THREE SHAPES

**Decided:** implementer, 2026-09-10. The trap is the brief's fifth; the three
shapes were found by calibration.

The truncation lesson: biome's default `--max-diagnostics=20` once made one
missing config line look like pre-existing debt, and the general repair is to
**print the total you counted next to the total the tool reports** and refuse
the numbers when they differ. So the instrument counts anchored error lines
itself and compares against tsc's own summary; a disagreement exits 1 with
_"Every per-area number above is unusable."_

⚠ **`--pretty false` prints NO summary at all.** One compact line per error and
nothing else. So the instrument runs `--pretty true` and parses the verbose form
— the cross-check is worth more than the smaller buffer — and anchors its
matcher on a non-space first character, because pretty output indents the source
excerpt, the squiggle and the whole **related-information block, which NAMES A
FILE with a line and column**. An unanchored matcher counts one diagnostic
twice. The calibration arm plants three errors, one of them the
related-information shape, and asserts counted 3 = tool-reported 3.

⛔ **AND THE FIRST VERSION MATCHED ONLY ONE OF THE THREE SUMMARY SHAPES — THE
ONE THIS REPO HAPPENS TO PRODUCE.** Driven against a five-file fixture, tsc
printed no `Found N errors in M files.` line at all:

```
Found 3 errors in 2 files.                                            ← 69-file repo
Found 2 errors in the same file, starting at: src/alpha/backend/a.ts:1 ← 1 file, >1 error
Found 1 error in src/alpha/backend/a.ts:1                              ← 1 file, 1 error
```

`toolReportedErrors` came back `null`, the agreement check went red, and the
instrument correctly refused to stand behind its numbers — **the self-check
catching a defect in the self-check, on its first run against a world it had not
been written against.** All three shapes are read now, and a fourth arriving
tomorrow lands as `null` → a loud refusal, never a quiet zero.

**That is the transferable form of the truncation lesson:** a cross-check is
only worth something if it can READ the tool's own total, and a parser
calibrated against one repo's output is calibrated against one repo's error
count.

---

## T7 · tsc reads `dist/`, so `(generated)` is its own area

**Decided:** implementer, 2026-09-10, found while closing the population.

`allowJs: true` with no `exclude` means the root program pulls in **24 emitted
`plugins/**/dist/\*.js` bundles\*\*. They carry 0 errors today.

Folding them into `plugins` would put a number that **moves on every rebuild**
inside a hand-authored area's baseline — the trap-4 route, arriving for free.
Dropping them would break the `sumOfAreas` closure and hide a real error in
emitted output. So they get their own derived bucket (`/dist/` in the path),
counted, printed and pinned at 0. Every other instrument in the repo already
defines "generated" as "under dist/" — biome excludes it, `gate-blind-set`'s
`GENERATED` regex matches it — so the bucket is the house's existing boundary,
not a new one.

⛔ **AND THE FIRST VERSION OF THE POPULATION COULD NOT CONTAIN THEM.** The tree
walk collected `.ts`/`.tsx` only. Result: `filesInTree` 519, `filesExamined`
543, and `areasMeasured` (32) came out **ABOVE** `areasInTree` (31) — C4's
coverage arithmetic inverted, with the `(generated)` area existing in the
measurement and having no row in the population. **A population that cannot
contain the subject is not a smaller population, it is the wrong one.** The walk
now admits every extension the program can (`.ts .tsx .js .jsx .mjs .cjs`) and
all four numbers close: 32 = 32, 544 = 544.

---

## T8 · `realpathSync` on the census root

**Recorded:** implementer, 2026-09-10, found by calibration.

tsc prints `--listFiles` paths RESOLVED. A census root reached through a symlink
— which every `mkdtemp` under macOS's `/tmp` is, `/tmp` being a link to
`/private/tmp` — made every `relative(ROOT, line)` start with `..`, the examined
set come out **empty**, and every area report NOT LOOKED AT while the error
lines counted fine.

**The closure check is what caught it** (1 counted, 0 decomposed across areas) —
on its first run, against a defect that would have made every calibration arm
fail for a reason unrelated to what it tests. Recorded because the general shape
is worth having: an instrument that compares its own paths against a tool's must
resolve both through the same normalisation, and the cross-check is what tells
you it did not.

---

## T9 · What the tree contradicts in the proposal

**Recorded:** implementer, 2026-09-10.

Every per-spell total in the proposal's table reproduces exactly once backend +
surface are added back together: bounty 125 + 3 = 128, grapevine 104 + 37 = 141,
imago 99 + 36 = 135, magpie 38 + 1 = 39, astrolabe 19 + 1 = 20, glamour 49 + 0 =
49, digestify 8 + 0 = 8. `scripts` 27, `plugins` 21, `grimoire` 14, `src/kit` 1
— all exact. The 584 headline, the 69 files, and the class distribution all
reproduce.

**Three things the table does not have:**

1. ⛔ **No `mind-mapper` row, and the tree has one error there**
   (`src/mind-mapper/backend/cli.ts:799`). Summed, the table's eleven rows come
   to **583** against a headline of **584**. The missing 1 is mind-mapper's —
   the eighth spell, absent from a hand-kept table while its error was carried
   in the total. That is D43's ruling arriving as a one-error discrepancy rather
   than as an argument.
2. **No `docs` row.** `docs/` holds four `.ts` files that are in tsc's program
   (`docs/projects/digestify-conversion/inventory-coverage.ts` and three
   `model-tests/*.ts` under an archive). Clean, which is why nobody noticed —
   and exactly the "area at zero that must be VISIBLE" the brief asked for.
3. **No `(generated)` row** — see T7.

**Nothing else contradicts.** The "the root tsconfig mis-measures the surface
aliases" hypothesis stays killed: this instrument runs the ROOT config, which is
what `bunx tsc --noEmit` at the root does, and the proposal's own 126-vs-128
measurement for bounty is recorded in the instrument's blind-spot list rather
than re-litigated.
