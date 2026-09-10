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

---

## T10 · ⛔ THE THREE `r8-outcome-check` COPIES ARE NOT DEAD. Nothing was deleted

**Decided:** implementer, 2026-09-10, Phase 1, on the brief's instruction to
establish liveness before typing 21 of the phase's 41 errors — and its
hypothesis that _"a dead instrument should be DELETED, not typed."_ **The
hypothesis is refuted for all three files, and the refutation needed a run, not
a grep.**

**What a grep establishes, and why it is not enough.** Nothing in the repo
references `r8-outcome-check-v1.ts` or `-v2.ts` at all; `-v3.ts` appears in two
sprint documents and `.anthill/retro.md` as a manual command. Every execution
route was then checked rather than assumed:

| route                  | what it runs                                                     | reaches r8? |
| ---------------------- | ---------------------------------------------------------------- | ----------- |
| `package.json` scripts | `build`, `check`, `test`, `gate`, `land-check`, `prune-branches` | no          |
| `bun test`             | collects `*.test.ts`; these are `.ts` scripts                    | no          |
| `.husky/pre-commit`    | `bunx lint-staged` → biome + prettier                            | no          |
| `.github/workflows`    | `ci.yml` = `bun run gate` + `bun scripts/dist-check.ts`          | no          |
| any local import       | every `scripts/instruments/*.ts` imports node/bun builtins ONLY  | no          |

So **no automated path runs any of the three.** That is where a deletion
argument would ordinarily stop, and it would have been wrong.

### ⭐ THE FINDING: ALL THREE ARE LIVE LOGIC POINTED AT A STALE ROOT

Run as they stand, **all three exit 1 with
`ZERO-DENOMINATOR — verdict withheld`.** Their root is a hardcoded absolute
`…/plugins/spellbook/skills`, and the backend convergence moved every command
dispatcher from there to `src/<spell>/backend/`. The 26 files still at the old
address are the thin LAUNCHERS Phase 3 left behind (D2, D6, D12); they contain
**zero** dispatch branches, confirmed independently by grep.

Re-pointed at `src/` — one `sed` on a scratch copy, nothing in the tree — every
one of them works:

| instrument | against the stale root    | against `src/`                        |
| ---------- | ------------------------- | ------------------------------------- |
| v1         | 0 files, verdict withheld | 154 files, 294 branches, 476 captures |
| v2         | 0 dispatchers, withheld   | 25 dispatchers, 287 branches          |
| v3         | 0 dispatchers, withheld   | **three-way calibration ✅ ✅ ✅**    |

**v3's three arms still convict, clear and see** — RED `imago context.add`,
GREEN `bounty task.add`, and the v2-blind `magpie element.add`. An instrument
whose calibration arms all fire is not dead by any definition worth having.

**So the verdict is not "dead, delete" and not "live, leave alone" — it is
SUBJECT-ORPHANED, and the honest act was to type all three and report the
staleness.** Deleting a working self-calibrating instrument because its root
string is out of date would have destroyed the most calibrated instrument in
`scripts/` to make a number smaller, which is R3's dishonesty at instrument
scale.

### What this costs elsewhere, stated

- ⚠ **`docs/projects/spell-hardening/sprints/05-the-gate/cold-read.md:87` cites
  `bun scripts/instruments/r8-outcome-check-v3.ts` reproducing "113 RED", and
  that command does not reproduce it from this tree** — it withholds. Sprint
  06's `plan.md:158` leans on the same command.
- ⚠ **`.anthill/retro.md:552`'s hypothesis H1** — _"at sprint 05's start,
  `r8-outcome-check-v3` or any peer cell still convicts a live in-tree
  instance"_ — is **falsified by the relocation, not by the fix it predicted
  would wear out.** The wasting-asset thesis was right; the mechanism was the
  tree moving, not the defect being repaired.
- ⚠ **The root is a hardcoded absolute path to one machine's checkout.** The
  house idiom is an env override (`gate-blind-set.ts` takes `SKILLS_DIR`,
  `type-debt-census.ts` takes `TYPE_DEBT_ROOT`, `canon-ledger-ward.ts` takes
  `CANON_DIR`) and these three have none — so they are unreproducible on any
  other machine, which is the exact argument `c4d669eb` made for landing them.

⛔ **NONE OF THAT WAS FIXED HERE, DELIBERATELY.** Re-pointing the root is a
BEHAVIOUR change: it turns three withheld verdicts into three real ones, one of
which reports ~113 RED rows. That is a finding to be triaged, not a side effect
of a type-debt commit. Filed as backlog, argued in T13.

**Not taken:**

- _Delete v1 and v2._ The brief's own suggestion, and `c4d669eb` explicitly kept
  v1 as _"the 49% DECORATION — kept on purpose"_ because _"v1 passing on real
  input beside v3 failing its mutation arm is the only artifact here that shows
  the difference between a check and a check that works."_ That evidence is
  still LIVE: driven on a fixture, v1 reports 4 branches where v2 and v3 report
  0, because v1 never grouped by discriminant. Its defect reproduces on demand.
- _Delete all three and keep the prose._ Tempting once the zero-denominator was
  found, and it is the option that looks most decisive. It trades a working
  instrument for a smaller number.
- _Re-point the root as part of the type fix._ The number would have moved for
  two unrelated reasons at once, which is the one thing the ratchet cannot
  decompose.

---

## T11 · The honest fix for a ward's possibly-undefined is a LOUD INVARIANT — not a fallback, and above all not a SKIP

**Decided:** implementer, 2026-09-10, Phase 1. This is R3 turned into something
that can be applied 41 times without judgement drifting.

R3 names two dishonest fixes, `arr[i]!` and `?? fallback`. **Driving Phase 1
found a third that is worse than either, and it is the one a careful engineer
reaches for first:**

```ts
const mark = marks[i];
if (!mark) continue; // ← looks like the responsible option. It is the D64 defect.
```

⛔ **In an instrument, an element skipped is an element that LEFT THE
DENOMINATOR.** D64 is exactly this: the spawn-path ward's `pins` went 6 → 5, no
behaviour changed, and **nothing reddened, because a coverage count going down
is not a failure.** Three shipped documents then quoted a number false since the
commit they shipped in. A `continue` converts a type error into a silently
smaller population — it is `?? fallback` with the evidence removed.

**So the rule, and it is mechanical:** every possibly-undefined read in a ward
is one of exactly two things, and the fix says which.

| the absence is…                                                     | the fix                                          |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| **impossible** by an invariant the type system cannot see           | `must(v, "<the invariant>")` — throws, naming it |
| **real** — past the end, an exhausted pool, an optional regex group | an explicit named branch that RECORDS the case   |

`must` is fifteen lines and its comment is fifty, because the comment is the
part that transfers. **A ward that crashes is repaired within the hour; a ward
that examines less ships a green that means nothing.**

⭐ **The two halves are live in ONE statement in `canon-ledger-ward.ts`, which
is why that file is the phase's best teaching site.** `scored[0]` is impossible
to be absent (guarded by `scored.length`) while `scored` being EMPTY is entirely
real — the pairing is injective, so the pool genuinely exhausts. One gets
`must`, the other keeps an explicit `undefined` branch that pushes to
`unmatched`. Driven: with the ledger cut to 2 rows, 2 rules pair and **17 are
RECORDED as unmatched — 2 + 17 = 19, the full rule denominator.** A `continue`
there would have reported `unmatched: 0` over a population of 2 and passed.

**Where the helper lives, and why it is duplicated on purpose.**
`grimoire/lib/must.ts` serves the four wards, because `grimoire/lib/` is already
the extraction home (`entry-points.ts`, `dist-artifacts.ts`, `import-graph.ts`)
and three wards import it — real reuse, one place for the argument.
`scripts/instruments/*` keeps its own copies: **every file there imports node
builtins and nothing else**, which is what makes each one runnable and copyable
alone, and the three r8 files are calibrated specimens whose independence is
their evidentiary value (`c4d669eb` verified each byte-identical to its own
baseline). A shared module would let one edit move all three specimens at once.

**Not taken:**

- _`arr[i]!` with a comment._ Twenty-eight characters shorter and it asserts the
  invariant to the compiler and to nobody else. When the invariant is false the
  ward computes a verdict from `undefined` and reports it with full confidence.
- _`?? fallback` everywhere, on the grounds that these are only instruments._
  Precisely backwards: an instrument is the one program whose wrong answer is
  indistinguishable from its right one.
- _A repo-wide `must` in `src/kit`._ It is where a shared helper belongs for
  shipped code, and importing it would end `scripts/instruments/`'s standalone
  discipline for fifteen lines.

---

## T12 · The two edits that came near D64, and why each is safe

**Recorded:** implementer, 2026-09-10. T4 names _"a de-duplication that hid an
indexed read behind a parameter"_ as one of five routes that lower a count with
nothing fixed. Two edits in this phase are that shape and both are argued rather
than waved through.

**1 — `head` replaces `marks[i]` AND `group[0]` in v2 and v3.** The grouping
walk had three indexed reads (`marks[j + 1].disc`, `marks[i].disc`,
`group[0].disc`) and now has one named `head`. **It is safe because
`head === group[0]` BY CONSTRUCTION, not by assumption:** `group` is
`marks.slice(i, j + 1)`, so `group[0]` _is_ `marks[i]`, and one read replaces
two names for one value rather than hiding a second read behind a parameter.

The walk was also rewritten `while` → `for(;;)` so the end of the array is a
NAMED terminal (`next === undefined`) instead of a length comparison the type
system cannot connect to the read. ⛔ **That is a control-flow change in the
predicate itself, so it was driven on a fixture rather than reasoned about:** a
4-branch dispatcher on one discriminant reports 1 dispatcher / 4 branches;
splitting one branch onto a different discriminant reports **0 / 0**; restoring
returns 1 / 4. The grouping is still fully sensitive to the thing it groups by —
which is the whole of what v2 added over v1.

**2 — the four `rel.split("/")[0]` reads in `daemon-lifecycle-ward.test.ts` were
LEFT AS FOUR.** A `spellOf(rel)` helper is the obvious cleanup and it is
literally D64's sentence. Kept as four `must(...)` calls: the edit is then
provably local to each `out.push`, and the ward's population was measured
unchanged across the change — **daemons 8, clis 14, before and after.**

⚠ **AND THE `spell` FIELD BOTH FUNCTIONS COMPUTE IS READ BY NO CELL IN THE
WARD.** `grep '\.spell'` over the file returns nothing; all three clauses map
`d.file`. Four of `grimoire`'s fourteen errors were in a field nothing consumes.
Left in place — deleting a struct field is a behaviour question, not a typing
one — and reported.

---

## T13 · ⛔ FIVE PRE-EXISTING WARD DEFECTS, FOUND BY MUTATION AND NOT BY TYPING

**Recorded:** implementer, 2026-09-10. **None of these is caused by this phase's
changes, and none would have been found by reading.** They are what the brief's
re-calibration requirement bought, and they are the phase's most valuable output
after the type fixes themselves.

**1 — ⛔ `daemon-lifecycle-ward`'s `idleTimeout` clause is satisfied by a
COMMENT.** The clause is `!/idleTimeout\s*:/.test(d.text)` over the file's raw
text. Driven: `idleTimeout: IDLE_TIMEOUT_SEC` deleted from
`src/glamour/backend/server.ts` and **the ward stayed GREEN, 5 pass / 0 fail** —
because line 408 of that file discusses `` `idleTimeout: 255` `` in prose. Three
daemons carry such a mention: **glamour, imago and bounty.** Two of them are in
the ward's own `fixed.idleTimeout` list of the spells it was written from, so
**the clause cannot convict two of its three founding cases.** It does convict
where prose does not shield it (astrolabe, driven red and restored).

**2 — the tracked-vs-disk cell only convicts a TOTALLY empty `dist/`.** Removing
one of astrolabe's five tracked artifacts printed `astrolabe:5/4` in the ward's
own output and **nothing reddened**; the clause is
`r.tracked > 0 && r.disk === 0`. Removing all five reds correctly. A partial
loss is invisible.

**3 — `expect(r.disk).toBeGreaterThanOrEqual(0)` is vacuous.** A count is always
≥ 0. The cell it sits in is named _"BOTH numbers are measured, so a green cannot
mean unexamined"_, and this half of it cannot fail.

**4 — `daemon-lifecycle-ward`'s population guard is a FLOOR, not a parity pin.**
`expect(daemons().length).toBeGreaterThanOrEqual(7)` against an actual **8**,
and `clis()` ≥ 7 against an actual **14**. A shrink from 14 to 7 passes silently
— the D64 shape, in the guard whose job is to catch it. (Measured only because
this phase touched both enumerators and had to prove no shrink.)

**5 — the three r8 instruments' stale hardcoded root** — T10, and the two
documents that cite numbers it no longer reproduces.

**6 — ⚠ AND ONE THE GATE ITSELF SURFACED, WHICH IS T2'S HAZARD ARRIVING ON A
PEER.** `src/mind-mapper/backend/cli.test.ts`'s _"open `--port N` binds the
daemon to N"_ cell **failed at 5004.19 ms in one full-gate run and passed in the
next two** (2035 pass / 0 fail), and passes alone in 2.49 s. It sits at
`bun test`'s DEFAULT 5,000 ms. T2 gave the ratchet's own five cells explicit 120
s timeouts for exactly this reason — _"a timeout is the one failure that makes
an instrument look broken when it is merely slow"_ — but the ratchet also puts a
~6-second `tsc` subprocess into the suite's CPU budget, and **nothing extended
the deadline of the PEERS it now competes with.** Not caused by this phase's
code (nothing here is reachable from mind-mapper) and plausibly aggravated by
its load. A flake that lands on an unrelated spell is the most expensive kind,
because the next reader debugs the wrong file.

⛔ **NOT ONE OF THESE WAS FIXED IN THIS PHASE, AND THAT IS DELIBERATE.** Every
one is a change to what a ward CATCHES. Folded into a type-debt commit they
would move counts for two unrelated reasons at once — and #1 in particular will
red on three real daemons the moment it is repaired, which is a finding that
deserves its own branch rather than a footnote in this one. Filed to backlog;
the journal names each with its drive.

---

## T14 · ⭐ NONE OF THE 41 `undefined`s WAS REACHABLE — and that is a finding, not a shrug

**Recorded:** implementer, 2026-09-10, Phase 1, answering R3's question
directly.

R3's stated deliverable is _"the handful of sites where the undefined was
reachable."_ **Read one at a time, all 41 sites are unreachable, and the
distribution says why:** 39 of the 41 fall into three mechanical shapes, none of
which can produce `undefined` in a program that type-checks the rest of the way.

| shape                                                                   | sites | why unreachable                                                     |
| ----------------------------------------------------------------------- | ----: | ------------------------------------------------------------------- |
| regex ALTERNATION, `m[1] ?? m[2]`                                       |     4 | each alternative has exactly one group, so a match sets exactly one |
| regex MANDATORY group, `m[1].trim()`                                    |     9 | one alternative, group not optional — a match sets it               |
| indexed read inside a BOUNDED loop (`marks[i]`, `group[k]`, `lines[j]`) |    24 | the loop bound is the array's own length                            |
| `rel.split("/")[0]`                                                     |     4 | `String.split` always yields ≥ 1 element                            |
| **`rows[0]` guarded in ANOTHER CELL**                                   | **1** | **the only site whose guard was not local** — see below             |

**The one site worth the whole exercise, and the honest size of it.**
`dist-roster-ward.test.ts:220` reads `rows[0].spell` in a positive-control cell
whose non-emptiness is asserted in ARM 1, a **different cell**. Driven under a
forced-empty roster, the ORIGINAL code already failed —
`TypeError: undefined is not an object (evaluating 'rows[0].spell')` — so the
vacuity this looked like was never open. ⚠ **The first draft of the code comment
claimed it was, and the comment was corrected before commit.** What the named
throw buys is a cell that says WHY it cannot run instead of dying on a property
access. That is worth having and it is not worth overstating: **a ward comment
that overclaims is the same defect as a ward that overclaims.**

**⭐ THE REAL FINDING IS THE SHAPE OF THE POPULATION, AND IT SHOULD CHANGE HOW
PHASES 2–4 ARE BUDGETED.** `noUncheckedIndexedAccess` produced 56% of the repo's
584 (proposal), and in this area **100% of what it produced was a type-system
artifact of a bounded loop or a mandatory capture group.** Phase 1's 41 errors
contained **zero latent defects.** That is a real and reportable answer to R3 —
and it is emphatically NOT an argument for `!`: the fixes still cost their
comments, because the invariant that is true today is what a `must(…)` states
and a `!` conceals.

⚠ **The honest limit on this claim.** It is a claim about `scripts` and
`grimoire`, which are 41 of 584 and are TOOLING — code that walks trees with its
own loop bounds. The three big backends are 404 errors of request handling and
state, where an index comes off a wire payload rather than a `for` bound.
**Phase 2 should NOT inherit "the answer is always zero"**; it should inherit
the table above as the set of shapes to triage FAST, so the reading budget goes
to the reads that are not in it.

---

## T15 · What the ratchet's fall path got right, and the three things to correct

**Recorded:** implementer, 2026-09-10 — Phase 1 is the ratchet's first user and
its cheapest chance to be corrected (Phase 0's own instruction).

### Right, and worth keeping exactly as built

1. **⭐ THE FALL FAILING IS WHAT CAUGHT A LOST FIX — T4 earned its argument
   inside one phase.** A measurement harness in this session ran
   `git checkout -- grimoire/daemon-lifecycle-ward.test.ts` and destroyed four
   finished edits. A direct `tsc | grep` had already reported ZERO for that file
   and was stale. **The ratchet's arithmetic cell disagreed — 547 against a
   declared 543 — and that disagreement is the only reason the loss was found.**
   T4's case for failing on a fall was built on a fix being FAKED; the first
   real incident was a fix being LOST. An auto-lowering ratchet books both as
   progress.
2. **The FELL sentence names the area, both numbers, the delta, and the five
   dishonest routes.** It is directly answerable, and the account written above
   the pin is that answer route by route. Nothing had to be invented to comply.
3. **The DECLARED_TOTAL held separately from the pin (D27) is load-bearing, not
   ceremony.** Both failing cells were needed: the movements cell named the two
   areas, and the arithmetic cell caught the 4-error gap the movements cell
   could not see, because `grimoire` looked like a legitimate partial fall.
4. **The exact-equality rule made "did I finish?" a mechanical question.** 584 −
   41 = 543 and the instrument agreed to the unit, which is what turned the lost
   edit from an opinion into arithmetic.

### To correct, in Phase 2's own interest

1. ⚠ **THE FELL SENTENCE ASKS FOR AN ACCOUNT AND NAMES NOWHERE TO PUT IT.** It
   says _"establish that N errors were FIXED and not silenced"_ and stops. Every
   incentive at that moment points at editing one integer; the account exists
   here because the brief demanded it, **not because the instrument asked.** The
   sentence should name the destination — _"and record the account beside the
   pin"_ — which is the one edit that would make the mechanism self-sustaining.
2. ⚠ **A FILE ADDED WHILE FIXING MAKES `filesInTree` MOVE, AND NOTHING PINS
   IT.** `grimoire/lib/must.ts` took `grimoire` 20 → 21 and the repo 544 → 545.
   Both numbers are printed and asserted EQUAL TO EACH OTHER, so the pair still
   closes and no cell reds. That is correct — a file count is not debt — but
   T5's third assertion (`filesExamined === filesInTree`) is the one that caught
   the `exclude` on an imported area, and it is satisfied by two numbers moving
   together. **A file DELETED from an area whose errors are all in other files
   would move both and red nothing.** Worth stating in the ward's "what a green
   does not mean" block, which today does not mention file counts.
3. ⚠ **THE 7.5-SECOND CELL IS WHERE THE GATE'S FEEDBACK LOOP NOW LIVES, AND IT
   IS FINE — the cost is running it ALONE.**
   `bun test grimoire/type-debt-ratchet.test.ts` is ~7.5 s for a one-integer
   question, which during this phase made a direct
   `bunx tsc --noEmit --pretty false | grep` the natural instrument to reach
   for. **That habit is what went stale and hid the lost edit.** The lesson is
   not to make the ward faster; it is that the census is the only reader whose
   arithmetic closes, and a `grep` is not a second opinion — it is a second
   predicate, which T1 forbids for exactly this reason.

**Nothing about the fall path was WRONG.** It fired on both areas, in the right
direction, with the right deltas, and it caught an error the phase's own author
had already convinced himself was not there.
