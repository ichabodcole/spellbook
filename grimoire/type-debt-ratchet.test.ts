// TYPE DEBT RATCHET — `bunx tsc --noEmit` reports 584 errors across 69 files and
// NOTHING in this repo reds over any of them. `bun run gate` is
// `build && check && test`: the build is a bundler and does not type-check,
// `check` is biome, and `bun test` only reaches a statement a test executes.
// Phase 7 of the backend convergence demonstrated the cost end to end — an
// undefined identifier on an uncovered path passed the build, passed biome and
// passed 2,019 tests, and shipped a latent `ReferenceError`.
//
// This ward does NOT close that gap. It makes the gap's SIZE impossible to move
// without saying so: a per-area baseline that may only go down (proposal R1,
// Cole, 2026-09-10).
//
// ⛔ IT IS NOT A BLOCKING WHOLE-REPO TYPECHECK. Sprint 05 ruled that out
// (`scripts/instruments/type-sentinel-probe.ts:30`) and R2 keeps the ruling.
// Nothing here fails because an area has 125 errors; it fails because an area's
// count MOVED and nobody wrote down which way.
//
// ⛔ IT CONSUMES `scripts/instruments/type-debt-census.ts` BY INVOKING IT, and
// deliberately does not re-implement its predicate — `gate-honesty.test.ts`'s
// relationship to `gate-blind-set.ts`, followed rather than reinvented. A
// second predicate for one fact is free to drift from the first, and then
// neither side is wrong. That instrument owns the question ("how many
// `tsc --noEmit` errors does each area carry, and which areas were not measured
// at all?"); this ward owns only whether the answer has moved without anyone
// saying so.
//
// ── WHY IT LIVES IN THE GATE, AND NOT IN A SIDE COMMAND ────────────────────
// MEASURED: `bunx tsc --noEmit` is ~6 s wall; `bun run gate` is ~180 s. So the
// ratchet is ~4% overhead and can simply run inside `bun test`. A side command
// nobody runs is worse than no ward at all — `scripts/instruments/` already
// holds report-only instruments precisely because closing their subject was out
// of scope, and this one's subject is IN scope for the four phases that follow.
//
// ⚠ ONE tsc RUN PER TEST PROCESS. The census is memoised below, so five cells
// cost one 6-second run rather than five. `gate-honesty.test.ts` re-invokes its
// instrument per cell because its instrument is milliseconds; copying that shape
// here would have put 30 seconds in the gate for nothing.
//
// ── ⛔ A FALL FAILS TOO, WITH AN INSTRUCTION. THE ARGUMENT, IN FULL ─────────
// R1 says the check fails when a count RISES. It does. The open question was
// what a FALL should do — pass silently, auto-lower the baseline, or fail with
// "the baseline is stale, lower it to N". This ward FAILS, and the reason is
// D64, twice over.
//
// D64: a DE-DUPLICATION reduced the spawn-path ward's coverage. `resolveMode`'s
// inlined body became `resolveModeIn(DIST_DIR)` and `pins=6` became `pins=5`
// with nothing about the spell's path behaviour changed — and **no instrument
// reddened, because a coverage COUNT going down is not a failure.** Three
// shipped documents then quoted a number that had been false since the commit
// they shipped in.
//
// The same route is wide open here, and there are five of them: a
// `@ts-expect-error`, an `arr[i]!`, a deleted file, a file MOVED to another
// area, a de-duplication that hides an indexed read behind a parameter. Every
// one lowers a count with nothing fixed, and R3 exists because two of them are
// the specific dishonest fixes this project must not accept. **An auto-lowering
// ratchet books all five as progress and records nothing.**
//
// ⛔ AND AUTO-LOWERING OPENS A SECOND HOLE THAT EXACT EQUALITY CLOSES FOR FREE:
// MASKING. If a fall silently becomes the new baseline, then a commit that fixes
// three errors in an area's tests and introduces three in its shipped code nets
// to zero and passes green. Because every movement in either direction reds
// here, no compensating movement can be silent — which is also why this ward
// pins ONE number per area rather than splitting each area into shipped and
// test halves. (The split is PRINTED by the instrument, and unpinned.)
//
// The cost is honest and worth stating: whoever fixes a type error must
// re-declare a number in this file, in the same commit. That is the same bargain
// `gate-honesty.test.ts`'s DECLARED_BLIND has been paying since sprint 05, and
// its log of re-declarations is the best documentation of the blind set that
// exists. The alternative buys convenience with exactly the silence this repo
// has now paid for four times this month.
//
// ── ⛔ WHAT A GREEN HERE DOES NOT MEAN ─────────────────────────────────────
//   1. NOT "the repo type-checks". It does not, 584 times. A green means the
//      584 are where they were declared to be.
//   2. NOT "these errors are the same errors". The unit is a COUNT. A fix and a
//      fresh defect in one area at one commit net to zero and nothing here
//      discriminates them. What the pin buys is that the NUMBER cannot drift.
//   3. NOT "the areas are the phases". The instrument derives areas from the
//      tree; the proposal's phases group them by hand, and the two do not have
//      to agree.
//   4. NOT a coverage claim about `dist/`. tsc reads the emitted bundles
//      (`allowJs: true`, no `exclude`) and they get their own `(generated)`
//      row, at 0, because a number that changes on every rebuild has no
//      business inside a hand-authored area's baseline.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ⛔ THE DECLARED BASELINE — pinned DEBT, not an exemption, and the house's
// existing `knownFailures` idiom rather than a fourth shape. Every entry is one
// area's `tsc --noEmit` error count at the moment someone last looked.
//
// A count RISING is new type debt shipping. A count FALLING is good news whose
// baseline is now stale. Both fail this cell, on purpose — the point is that
// neither happens silently. An area ARRIVING (a new spell, a new aspect) and an
// area LEAVING (a relocation, a deletion) fail it too, for the same reason.
//
// ⛔ DO NOT paste the instrument's new output in to make a red go away. Ask
// which direction it moved and why, and write the account down — the direction
// is the whole finding, and the accounts below the pin in
// `gate-honesty.test.ts` are what make that ward's number legible two months
// later.
//
// ⛔ DECLARED 2026-09-10 — PHASE 0, the first declaration. 584 errors across 32
// areas, of which 15 are at ZERO and are listed anyway: an area that is clean is
// a fact this ward must state, because the day it stops being clean is the day
// the row has to be there already. Measured at `bunx tsc --noEmit` 584 / exit 2,
// cross-checked against tsc's own "Found 584 errors in 69 files."
//
// ⚠ TWO NUMBERS HERE CONTRADICT THE PROPOSAL'S TABLE, AND THE TREE WINS:
//   • `src/bounty/backend` is 125 + `src/bounty/surface` 3 = 128, matching the
//     proposal's bounty row. `src/grapevine` 104 + 37 = 141, `src/imago` 99 +
//     36 = 135, `src/magpie` 38 + 1 = 39, `src/astrolabe` 19 + 1 = 20 — every
//     per-spell total reproduces.
//   • ⛔ BUT THE PROPOSAL'S TABLE HAS NO `mind-mapper` ROW AND THE TREE HAS
//     ONE ERROR THERE (`src/mind-mapper/backend/cli.ts:799`). Summed, the
//     table's eleven rows come to 583 against a headline of 584 — and the
//     missing 1 is mind-mapper's, the eighth spell, absent from a hand-kept
//     table while its number was carried in the total. That is D43's ruling
//     arriving as a one-error discrepancy rather than as an argument.
//   • The proposal's `plugins/ 21` and `grimoire/ 14` and `scripts/ 27`
//     reproduce exactly. `docs` (4 files) and `(generated)` (24 bundles) are in
//     tsc's program and in no row of the table at all — both are clean, which
//     is why nobody noticed.
//
// ⛔ RE-DECLARED 2026-09-10 — PHASE 1, `grimoire` 14 -> 0 and `scripts` 27 -> 0,
// total 584 -> 543. THE FALL WAS A FIX AND NOT A SILENCING, and here is the
// account this ward's own FELL sentence demands, route by route:
//
//   • NO `!`, NO `as any`, NO `@ts-expect-error`, NO `?? fallback` STANDING IN
//     FOR AN INVARIANT. Every one of the 41 reads was replaced by a `must(v,
//     "<the invariant>")` that THROWS naming the invariant, or by an explicitly
//     named terminal branch where the absence is real. `grimoire/lib/must.ts`
//     carries the argument; `scripts/instruments/*` holds its own copies
//     on purpose (each instrument imports node builtins only).
//   • ⛔ NO FILE WAS DELETED. The phase opened by asking whether
//     `r8-outcome-check-v{1,2}.ts` were dead and could be removed instead of
//     typed. They are NOT: all three are live-logic instruments whose hardcoded
//     root went stale in the backend convergence, and all three were re-driven
//     against `src/` before a line was touched. See T10.
//   • NO DE-DUPLICATION HID AN INDEXED READ BEHIND A PARAMETER (D64). Two edits
//     came close and both are argued in T12: `head` replaces `marks[i]`/
//     `group[0]` in v2/v3, and it is `group[0]` BY CONSTRUCTION rather than by
//     assumption; the four `rel.split("/")[0]` reads in
//     `daemon-lifecycle-ward.test.ts` were left as four reads for that reason.
//   • ⭐ ONE FILE WAS ADDED — `grimoire/lib/must.ts` — so `grimoire`'s
//     `filesInTree` goes 20 -> 21 and the repo's 544 -> 545. The new file is
//     clean, which is why the area still lands on 0 rather than on a residue.
//
// AND THE FALLS WERE VERIFIED AS FIXES BY MUTATION, NOT BY THE COUNT: every
// ward whose types moved was driven red and restored green, and the three
// r8 specimens reproduce their pre-change reports BYTE-FOR-BYTE against both
// their real root and `src/`. `phase-1-journal.md` records eleven drives.
//
// ⚠ THE COUNT ALONE WOULD NOT HAVE CAUGHT THE ONE REAL ACCIDENT OF THIS PHASE,
// AND THIS WARD DID. A measurement harness `git checkout --`'d
// `daemon-lifecycle-ward.test.ts` and destroyed four finished edits; the direct
// `tsc | grep` run that had already said ZERO was stale, and it was THIS cell's
// arithmetic (547 against a declared 543) that surfaced the loss. A fix can be
// lost as silently as it can be faked.
const DECLARED_BASELINE: Record<string, number> = {
  "(generated)": 0,
  "(repo root)": 0,
  docs: 0,
  grimoire: 0,
  plugins: 21,
  scripts: 0,
  src: 0,
  "src/astrolabe": 0,
  "src/astrolabe/backend": 19,
  "src/astrolabe/surface": 1,
  "src/bounty": 0,
  "src/bounty/backend": 125,
  "src/bounty/surface": 3,
  "src/digestify": 0,
  "src/digestify/backend": 8,
  "src/digestify/surface": 0,
  "src/glamour": 0,
  "src/glamour/backend": 49,
  "src/glamour/surface": 0,
  "src/grapevine": 0,
  "src/grapevine/backend": 104,
  "src/grapevine/surface": 37,
  "src/imago": 0,
  "src/imago/backend": 99,
  "src/imago/surface": 36,
  "src/kit": 1,
  "src/magpie": 0,
  "src/magpie/backend": 38,
  "src/magpie/surface": 1,
  "src/mind-mapper": 0,
  "src/mind-mapper/backend": 1,
  "src/mind-mapper/surface": 0,
};

/** The declared TOTAL, held separately so it cannot be derived from the object
 *  above. ⛔ D27: a total computed by summing the pin would agree with the pin
 *  for any pin, which is a check that cannot fail in the failing case. This
 *  number is what `bunx tsc --noEmit` said, written by hand. */
const DECLARED_TOTAL = 543;

/** ⛔ `errors: null` MEANS NOT LOOKED AT — see the D42 note in the instrument's
 *  header. It is `number | null` here because it is `number | null` there, and
 *  a ward that narrowed it to `number` on the way in would be the caller D42
 *  warns about. */
type AreaRow = {
  area: string;
  errors: number | null;
  shipped: number | null;
  tests: number | null;
  filesInTree: number;
  filesExamined: number;
  note?: string;
};

type Census = {
  root: string;
  tsc: {
    exitCode: number;
    exitUnderstood: boolean;
    countedErrors: number;
    toolReportedErrors: number | null;
    toolReportedFiles: number | null;
    countedFilesWithErrors: number;
    errorsAgree: boolean;
  };
  population: {
    areasInTree: number;
    areasMeasured: number;
    filesInTree: number;
    filesExamined: number;
  };
  closureHolds: boolean;
  sumOfAreas: number;
  unassigned: string[];
  byClass: Record<string, number>;
  areas: AreaRow[];
};

const INSTRUMENT = "scripts/instruments/type-debt-census.ts";

/** ⛔ EVERY CELL CARRIES AN EXPLICIT TIMEOUT, because `bun test`'s default is
 *  5,000 ms and one whole-repo `tsc --noEmit` is ~6,000. Left at the default,
 *  the first cell timed out, the memoised promise it had already started was
 *  rejected, and the remaining four failed with `exit 143` — a killed child
 *  reported as "the instrument produced no report". A timeout is the one
 *  failure that makes an instrument look broken when it is merely slow, and a
 *  6-second measurement inside a 180-second gate must not be read as a fault. */
const CENSUS_TIMEOUT_MS = 120_000;

async function runCensus(env: Record<string, string | undefined>, cwd?: string): Promise<Census> {
  const proc = Bun.spawn(["bun", join(process.cwd(), INSTRUMENT)], {
    cwd: cwd ?? process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // "no envelope" is a THIRD state: a non-zero exit here may carry its whole
  // explanation on stderr with nothing on stdout, so name that case rather than
  // letting JSON.parse throw for the wrong reason.
  if (code !== 0 || out.trim() === "") {
    throw new Error(
      `type-debt-census did not produce a report (exit ${code}, ${out.length} stdout bytes): ${err.slice(0, 600)}`,
    );
  }
  return JSON.parse(out) as Census;
}

// ⛔ THE ROOT OVERRIDES ARE STRIPPED, AND THAT IS A DEFECT FIX, NOT HYGIENE.
// `TYPE_DEBT_ROOT` / `TYPE_DEBT_TSC` are calibration hooks, and a test process
// inherits the ambient environment — so a seat with either exported in their
// shell would STEER THIS WARD'S POPULATION. `gate-honesty.test.ts` records
// measuring exactly that: with its hooks pointed at a two-file throwaway repo it
// printed "BLIND to 0 files / 0 lines" and PASSED. The zero-guards below cannot
// tell a 543-file world from a 5-file one; the pin and the `root` assertion can.
let cached: Promise<Census> | undefined;
function census(): Promise<Census> {
  if (cached === undefined) {
    const { TYPE_DEBT_ROOT: _r, TYPE_DEBT_TSC: _t, ...cleanEnv } = process.env;
    cached = runCensus(cleanEnv);
  }
  return cached;
}

/** The one place a rise, a fall, an arrival and a departure are turned into
 *  sentences. Returned as an array so `toEqual([])` prints every movement with
 *  its area, its direction and its delta — rather than reporting that two
 *  objects differ. */
function movements(areas: AreaRow[], declared: Record<string, number>): string[] {
  const out: string[] = [];
  const derived = new Map(areas.map((a) => [a.area, a]));
  for (const [area, was] of Object.entries(declared)) {
    const row = derived.get(area);
    if (row === undefined) {
      out.push(
        `DEPARTED — area "${area}" is declared at ${was} and the tree no longer has it. A relocation lowers one area and raises another; find the other half before re-declaring.`,
      );
      continue;
    }
    if (row.errors === null) {
      out.push(
        `NOT LOOKED AT — area "${area}" is declared at ${was} and tsc's program reached NONE of its ${row.filesInTree} file(s). This is not a count of zero. ${row.note ?? ""}`,
      );
      continue;
    }
    const delta = row.errors - was;
    if (delta > 0) {
      out.push(
        `ROSE — area "${area}" ${was} -> ${row.errors} (+${delta}). New type debt. Fix it, or re-declare it deliberately and say why.`,
      );
    } else if (delta < 0) {
      out.push(
        `FELL — area "${area}" ${was} -> ${row.errors} (${delta}). Good news, and THE BASELINE IS NOW STALE: lower it to ${row.errors}. ⛔ First establish that ${-delta} error(s) were FIXED and not silenced — an \`arr[i]!\`, an \`as any\`, a \`@ts-expect-error\`, a deleted file, or a de-duplication that hid an indexed read behind a parameter (D64) all lower this number with nothing fixed.`,
      );
    }
  }
  for (const row of areas) {
    if (!(row.area in declared)) {
      out.push(
        `ARRIVED — area "${row.area}" is in the tree with ${row.errors ?? "NOT LOOKED AT"} error(s) and is not declared. Declare it, at whatever it measures.`,
      );
    }
  }
  return out.sort();
}

describe("type debt ratchet", () => {
  test(
    "STATES THE TYPE DEBT THE GATE'S OTHER ARMS CANNOT SEE",
    async () => {
      const c = await census();
      const worst = c.areas
        .filter((a) => (a.errors ?? 0) > 0)
        .sort((a, b) => (b.errors ?? 0) - (a.errors ?? 0))
        .slice(0, 4);
      console.warn(
        [
          "",
          `  TYPE DEBT — \`tsc --noEmit\` reports ${c.tsc.countedErrors} error(s) in ${c.tsc.countedFilesWithErrors} file(s) (tsc's own total: ${c.tsc.toolReportedErrors}).`,
          `  ⛔ NOTHING ELSE IN THE GATE READS THEM — the build is a bundler, \`check\` is biome, and \`bun test\` reaches only executed statements.`,
          `     areas: ${c.population.areasMeasured} measured of ${c.population.areasInTree} in the tree · files: ${c.population.filesExamined} examined of ${c.population.filesInTree}`,
          `     worst: ${worst.map((a) => `${a.area} (${a.errors})`).join(" · ")}`,
          `     clean: ${c.areas.filter((a) => a.errors === 0).length} area(s) at ZERO, listed in the pin so the day they move is loud`,
          `     top classes: ${Object.entries(c.byClass)
            .slice(0, 4)
            .map(([k, n]) => `${k}x${n}`)
            .join(" · ")}`,
          "  A green from this ward means the debt is WHERE IT WAS DECLARED, never that the repo type-checks.",
          "",
        ].join("\n"),
      );

      // Zero-guards on the POPULATION, not on the finding: an instrument that
      // enumerated nothing would report 0 errors everywhere and read as clean.
      expect(c.population.filesInTree).toBeGreaterThan(0);
      expect(c.population.areasInTree).toBeGreaterThan(0);
      // ⛔ AND A GUARD ON WHICH WORLD WAS MEASURED. `> 0` cannot distinguish this
      // repo from a five-file fixture; the root can.
      expect(c.root).toBe(process.cwd());
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "the per-area baseline has not moved without being re-declared",
    async () => {
      const c = await census();
      // ⛔ ASSERTED ON RENDERED SENTENCES, not on two objects. A `toEqual` between
      // the derived record and the pin names which area differs and both numbers,
      // but it does not name the DIRECTION — and the direction is the entire
      // finding: a rise is new debt and a fall is a stale baseline, and the two
      // want opposite responses from the reader.
      expect(movements(c.areas, DECLARED_BASELINE)).toEqual([]);
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "every area the ward NAMES was actually EXAMINED (D42)",
    async () => {
      const c = await census();
      // A row with `errors: null` is an area this ward names and tsc did not look
      // at. It must never pass, and it must never be spelled like a zero — the
      // movements cell above catches a declared area going null, and this cell
      // catches an UNDECLARED one, plus the case where every area went null at
      // once (a broken tsconfig) and the pin would be uniformly wrong rather than
      // pointedly wrong.
      // ⛔ AND THE FILE-LEVEL COVERAGE IS ASSERTED SEPARATELY, BECAUSE A REAL
      // MUTATION PROVED THE NULL IS NOT ENOUGH. Driven on this tree: adding
      // `"exclude": ["src/kit"]` to `tsconfig.json` did NOT produce a null for
      // `src/kit` — all eight spells IMPORT from the kit, so module resolution
      // re-admitted those files and tsc still reported kit's one error;
      // `areasMeasured` stayed 32. What moved was `filesExamined`, 544 -> 535:
      // the nine kit files nobody imports left the program SILENTLY. So an
      // `exclude` on an IMPORTED area is caught only by the file count, and an
      // `exclude` on an UNIMPORTED one (driven with `["docs"]`: 4 -> 0 files,
      // `errors: null`, `areasMeasured` 31 of 32) is caught by the null. Both
      // mutations are real, both were run, and each is caught by a DIFFERENT
      // one of these three assertions — which is why all three are here and not
      // just the one that looked sufficient.
      const notLookedAt = c.areas
        .filter((a) => a.errors === null)
        .map((a) => `${a.area}: ${a.note}`);
      expect(notLookedAt).toEqual([]);
      expect(c.population.areasMeasured).toBe(c.population.areasInTree);
      expect(c.population.filesExamined).toBe(c.population.filesInTree);
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "the instrument stands behind its own arithmetic — count, closure, exit",
    async () => {
      const c = await census();
      // ⛔ C4 / D43: A DERIVED POPULATION IS NOT COVERAGE, so coverage is
      // ASSERTED and not merely printed (D27's amendment to Phase 1b, which
      // predicted this failure mode in writing one phase before it happened).
      //
      // ⚠ THE TRUNCATION LESSON, MADE MECHANICAL. biome's default
      // `--max-diagnostics=20` once made one missing config line look like
      // pre-existing debt. The general repair is to compare the total you COUNTED
      // against the total the TOOL reports, and refuse the numbers when they
      // differ. tsc does not truncate today; this is what notices the day it
      // does, or the day a diagnostic arrives in a shape the parser misreads.
      // ⛔ THE TWO TOTALS ASSERTED SIDE BY SIDE, WHICH IS THE IDIOM ITSELF:
      // "print the total you counted next to the total the tool reports". As a
      // PAIR rather than as two cells, so a failure shows both numbers at once —
      // and against the DECLARED total, so a run where both agree on a number
      // nobody declared is still red. ⚠ `toolReportedErrors` is `number | null`
      // and the `null` is a third state (the summary line was unreadable), so it
      // is compared here rather than coerced with a `?? 0` — which is the
      // fallback proposal R3 exists to refuse.
      expect([c.tsc.countedErrors, c.tsc.toolReportedErrors]).toEqual([
        DECLARED_TOTAL,
        DECLARED_TOTAL,
      ]);
      expect(c.tsc.errorsAgree).toBe(true);
      expect(c.closureHolds).toBe(true);
      expect(c.unassigned).toEqual([]);
      expect(c.sumOfAreas).toBe(c.tsc.countedErrors);
      // 0 (clean) or 2 (errors found) and nothing else. A 1 — a rejected flag —
      // arriving here as "no errors" would be the silent green this ward is about.
      expect(c.tsc.exitUnderstood).toBe(true);
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "the declaration is not empty — the zero-guard on the pin itself",
    () => {
      // A pin that silently emptied would make every area invisible AND make this
      // ward pass. Guarding the finding's own denominator.
      expect(Object.keys(DECLARED_BASELINE).length).toBeGreaterThan(0);
      expect(Object.values(DECLARED_BASELINE).reduce((n, v) => n + v, 0)).toBe(DECLARED_TOTAL);
    },
    CENSUS_TIMEOUT_MS,
  );
});

// ── CALIBRATION ──────────────────────────────────────────────────────────────
// Proves the ward's answer is DERIVED FROM THE WORLD rather than echoed from its
// own declaration — the failure where a pin and a "check" agree because the check
// never looked. Every arm goes THROUGH the real instrument against a tree the
// cell built.
//
// Mutations never touch the shared tree: a seat mutating to calibrate is
// indistinguishable, to every other seat, from a broken tree.
//
// ⚠ The fixture is minted under the OS temp dir and removed in `finally`. A
// mkdtemp'd dir cannot COLLIDE and is never REMOVED unless someone removes it —
// one predicate, two harms.
//
// ⛔ THE FIXTURE CARRIES ITS OWN `tsconfig.json` AND BORROWS THE REPO'S `tsc`.
// `bunx tsc` inside a fixture would install a second, unpinned compiler whose
// count is not comparable to the gate's; `TYPE_DEBT_TSC` is why the instrument
// resolves its binary from its OWN location rather than from the census root.
describe("type debt ratchet — calibration", () => {
  const TSC = join(process.cwd(), "node_modules", ".bin", "tsc");

  /** A five-area world, one area per branch of `areaOf`: a spell's backend, the
   *  same spell's surface (so an arm cannot satisfy the split by accident), a
   *  non-spell directory under `src/`, a depth-1 directory of its own, and a
   *  file at the root. */
  function mintFixture(exclude?: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "type-debt-cal-"));
    const write = (rel: string, body: string) => {
      const parts = rel.split("/");
      parts.pop();
      if (parts.length > 0) mkdirSync(join(dir, ...parts), { recursive: true });
      writeFileSync(join(dir, ...rel.split("/")), body);
    };
    write(
      "tsconfig.json",
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noUncheckedIndexedAccess: true,
            noEmit: true,
            allowJs: true,
            types: [],
            lib: ["ESNext"],
            module: "Preserve",
            moduleResolution: "bundler",
            moduleDetection: "force",
          },
          ...(exclude ? { exclude } : {}),
        },
        null,
        2,
      )}\n`,
    );
    write("src/alpha/backend/a.ts", "export const a = 1;\n");
    write("src/alpha/surface/b.ts", "export const b = 2;\n");
    write("src/lib/c.ts", "export const c = 3;\n");
    write("tools/d.ts", "export const d = 4;\n");
    write("e.ts", "export const e = 5;\n");
    return dir;
  }

  function censusIn(dir: string): Promise<Census> {
    return runCensus({ ...process.env, TYPE_DEBT_ROOT: dir, TYPE_DEBT_TSC: TSC }, dir);
  }

  const errorsFor = (c: Census): Record<string, number | null> =>
    Object.fromEntries(c.areas.map((a) => [a.area, a.errors]));

  const CLEAN = {
    "src/alpha/backend": 0,
    "src/alpha/surface": 0,
    "src/lib": 0,
    tools: 0,
    "(repo root)": 0,
  };

  test(
    "CONTROL — a clean five-area world measures five areas, all at ZERO and all VISIBLE",
    async () => {
      const dir = mintFixture();
      try {
        const c = await censusIn(dir);
        // ⛔ THE CONTROL ARM IS WHAT MAKES THE MUTATION ARMS EVIDENCE. Without it
        // they prove only that the instrument returns something, not that it
        // DISCRIMINATES.
        expect(errorsFor(c)).toEqual(CLEAN);
        // Drive 3 of the brief: a ZERO area stays green and is VISIBLE — five of
        // them here, and `docs`, `src/digestify/surface`, `src/glamour/surface`
        // and `src/mind-mapper/surface` on the real tree. An absent row would
        // pass a "no rises" check and be the D42 silence.
        expect(c.areas.length).toBe(5);
        expect(c.tsc.exitCode).toBe(0);
        expect(c.tsc.countedErrors).toBe(0);
        // With zero errors tsc prints no summary at all; the instrument must read
        // that as a real 0 and not as an unreadable tool.
        expect(c.tsc.toolReportedErrors).toBe(0);
        expect(c.tsc.errorsAgree).toBe(true);
        expect(c.closureHolds).toBe(true);
        expect(c.population).toEqual({
          areasInTree: 5,
          areasMeasured: 5,
          filesInTree: 5,
          filesExamined: 5,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "MUTATION — a RISE in a BACKEND area is named, with its delta, and the peer areas do not move",
    async () => {
      const dir = mintFixture();
      try {
        writeFileSync(
          join(dir, "src", "alpha", "backend", "a.ts"),
          "export const a: number = 'x';\n",
        );
        const c = await censusIn(dir);
        expect(errorsFor(c)).toEqual({ ...CLEAN, "src/alpha/backend": 1 });
        // The sentence the gate would print, through the real renderer.
        const said = movements(c.areas, { ...CLEAN, "src/alpha/backend": 0 });
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('ROSE — area "src/alpha/backend" 0 -> 1 (+1)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "MUTATION — a rise in the SURFACE half does not land on the BACKEND half (the split is real)",
    async () => {
      const dir = mintFixture();
      try {
        // ⛔ THE POINT OF SPLITTING backend FROM surface. If the areas were
        // per-spell, this mutation and the one above would be indistinguishable,
        // and a rise in shipped backend code could hide behind a fall in the
        // surface at the same commit. 443 backend errors against 78 surface ones
        // say the two halves behave differently, and the proposal phases them
        // apart (Phase 4 is the three big backends; the surface is "in scope but
        // last").
        writeFileSync(
          join(dir, "src", "alpha", "surface", "b.ts"),
          "export const b: number = 'y';\n",
        );
        const c = await censusIn(dir);
        expect(errorsFor(c)).toEqual({ ...CLEAN, "src/alpha/surface": 1 });
        const said = movements(c.areas, CLEAN);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('ROSE — area "src/alpha/surface" 0 -> 1 (+1)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "MUTATION — a FALL fails WITH AN INSTRUCTION rather than passing or auto-lowering",
    async () => {
      const dir = mintFixture();
      try {
        // The world is clean; the DECLARATION says this area carries 3. That is
        // the shape the day after someone fixes three errors — and the ward's
        // ruling is that it reds, naming the new number to write down.
        const c = await censusIn(dir);
        const said = movements(c.areas, { ...CLEAN, "src/alpha/backend": 3 });
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('FELL — area "src/alpha/backend" 3 -> 0 (-3)');
        expect(said[0]).toContain("lower it to 0");
        // ⛔ And it names the five ways a count falls with nothing fixed (D64,
        // R3). A fall that reads as unqualified progress is how `pins=6` shipped
        // in three documents while the ward said 5.
        expect(said[0]).toContain("silenced");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "MUTATION — an UNMEASURABLE area says NOT LOOKED AT, and does not pass as a zero (D42)",
    async () => {
      // ⛔ THE DEFECT THIS ARM EXISTS FOR IS THE ONE D42 PAID FOR THREE TIMES: an
      // area the instrument NAMES and cannot EXAMINE producing a row that reads
      // like "nothing to find". The realistic mutation is a `tsconfig.json`
      // `exclude` — which is exactly what someone reaches for to quiet a noisy
      // directory, and it would otherwise take that directory's whole baseline to
      // zero and call it a fix.
      const dir = mintFixture(["src/lib"]);
      try {
        // A real error is planted in the excluded area, so the arm distinguishes
        // "not looked at" from "looked at and clean" rather than assuming it.
        writeFileSync(join(dir, "src", "lib", "c.ts"), "export const c: number = 'z';\n");
        const c = await censusIn(dir);
        // ⛔ `null`, NOT 0. The return type is what enforces it
        // (`grimoire/lib/dist-artifacts.ts`'s discipline), and this is the cell
        // that proves the type is doing work.
        expect(errorsFor(c)["src/lib"]).toBeNull();
        const row = c.areas.find((a) => a.area === "src/lib");
        expect(row?.note).toContain("NOT LOOKED AT");
        expect(row?.filesInTree).toBe(1);
        expect(row?.filesExamined).toBe(0);
        // C4: the two numbers diverge, and the divergence is the finding.
        expect(c.population.areasMeasured).toBe(4);
        expect(c.population.areasInTree).toBe(5);
        // The ward's verdict on a declared area that went unmeasurable.
        const said = movements(c.areas, CLEAN);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('NOT LOOKED AT — area "src/lib"');
        expect(said[0]).toContain("This is not a count of zero");
        // ⛔ AND THE EXCLUDED ERROR IS GONE FROM THE TOTAL WITH NOTHING FIXED —
        // the whole reason a null must not read as a zero.
        expect(c.tsc.countedErrors).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "MUTATION — an ARRIVING area is named rather than silently admitted",
    async () => {
      const dir = mintFixture();
      try {
        mkdirSync(join(dir, "src", "beta", "backend"), { recursive: true });
        writeFileSync(
          join(dir, "src", "beta", "backend", "f.ts"),
          "export const f: number = 'q';\n",
        );
        const c = await censusIn(dir);
        // Derived from the tree, so a new spell appears with no edit to any list
        // (D43) — and the pin is what forces someone to look at it.
        expect(errorsFor(c)).toEqual({ ...CLEAN, "src/beta/backend": 1 });
        const said = movements(c.areas, CLEAN);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(
          'ARRIVED — area "src/beta/backend" is in the tree with 1 error(s)',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "MUTATION — a MOVED file lowers one area and raises another, and BOTH halves are named (D64)",
    async () => {
      const dir = mintFixture();
      try {
        // ⛔ THE REFACTOR THAT LOWERS A COUNT WITH NOTHING FIXED. A file with a
        // type error relocated from a spell's backend into the shared kit takes
        // its error with it: the backend "improves", the kit "regresses", and an
        // auto-lowering ratchet would book the first and be forced to accept the
        // second. Both are named here, in one verdict.
        writeFileSync(join(dir, "src", "lib", "c.ts"), "export const c: number = 'z';\n");
        const c = await censusIn(dir);
        const said = movements(c.areas, { ...CLEAN, "src/alpha/backend": 1, "src/lib": 0 });
        expect(said).toHaveLength(2);
        expect(said.join("\n")).toContain('FELL — area "src/alpha/backend" 1 -> 0 (-1)');
        expect(said.join("\n")).toContain('ROSE — area "src/lib" 0 -> 1 (+1)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "MUTATION — a multi-line diagnostic with RELATED INFORMATION is counted ONCE (the truncation arm)",
    async () => {
      const dir = mintFixture();
      try {
        // ⛔ THE PARSE HAZARD, DRIVEN. tsc's pretty reporter prints a source
        // excerpt, a squiggle and a whole RELATED-INFORMATION block under one
        // diagnostic — and the related-information block NAMES A FILE with a
        // line and column. An unanchored matcher counts that as a second error;
        // a truncating tool prints fewer than it found. Both are caught the same
        // way: our count against tsc's own "Found N errors in M files." Three
        // errors are planted, one of them the related-information shape.
        writeFileSync(
          join(dir, "src", "alpha", "backend", "a.ts"),
          [
            "const out: { spell: string }[] = [];",
            'const parts = "a/b".split("/");',
            "out.push({ spell: parts[0] });",
            "export const bad: number = 'x';",
            "export const worse: string = 42;",
            "export const used = out;",
            "",
          ].join("\n"),
        );
        const c = await censusIn(dir);
        expect(c.tsc.countedErrors).toBe(3);
        expect(c.tsc.toolReportedErrors).toBe(3);
        expect(c.tsc.countedFilesWithErrors).toBe(1);
        expect(c.tsc.errorsAgree).toBe(true);
        expect(errorsFor(c)).toEqual({ ...CLEAN, "src/alpha/backend": 3 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );
});
