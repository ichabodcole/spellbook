// TYPE CHECK WARD — every `tsc --noEmit` error in every area of this repo reds
// the gate. Ruled by Cole, 2026-09-10 (type-debt T37), once the type-debt
// project took the repo from 584 errors to 0.
//
// ⛔ WHY NOT JUST `tsc --noEmit` IN THE GATE. Two reasons, both measured:
//   1. A ROOT `tsc` IS WRONG FOR THIS REPO. Spells with their own
//      `src/<spell>/tsconfig.json` resolve `@/` through it; the root config
//      cannot, and reports ~40 false errors (T32). The census runs each such
//      WORKSPACE under its own config and gives every file one owning run.
//   2. "EXIT 0" CANNOT TELL CLEAN FROM UNEXAMINED. A `tsconfig` `exclude`, or a
//      new spell's files outside tsc's program, leaves those files unchecked and
//      the exit code green. This ward asserts coverage — every area measured,
//      every file on disk examined — which is the D42 lesson this repo paid for
//      four times: absence of a finding must never look like absence of a
//      subject.
//
// ⛔ IT WAS A RATCHET UNTIL THE COUNT REACHED ZERO. From Phase 0 to Phase 4 this
// file held a per-area baseline that failed on ANY movement, with a
// re-declaration account for every fall (proposal R1). At zero a count can only
// rise, so that machinery guarded a direction that no longer exists and was
// removed; the accounts live in git history (as
// `grimoire/type-debt-ratchet.test.ts`) and in `docs/projects/_archive/type-debt/`.
//
// ⛔ IT CONSUMES `scripts/instruments/type-debt-census.ts` BY INVOKING IT and
// does not re-implement its predicate — `gate-honesty.test.ts`'s relationship to
// `gate-blind-set.ts`, followed rather than reinvented. The census owns the
// measurement; this ward owns the verdict.
//
// ── COST ─────────────────────────────────────────────────────────────────────
// One root run (~6 s) plus ~1 s per workspace, memoised across cells. It lives
// in `bun test`, so `bun run gate` carries it; it is deliberately NOT in the
// husky pre-commit hook (tsc checks the whole program, not the staged files).
//
// ── ⛔ WHAT A GREEN HERE DOES NOT MEAN ─────────────────────────────────────
//   1. NOT the stricter flags `tsconfig.json` leaves off (`noUnusedLocals`,
//      `noUnusedParameters`, `noPropertyAccessFromIndexSignature`).
//   2. NOT that a value typed at a JSON boundary (`.json()`, `JSON.parse`) is
//      what it says — only that the code agrees with its annotations (T26).
//   3. NOT behaviour. Zero errors means tsc had no complaint; the gate's other
//      arms are what read behaviour.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /** `src/<dir>/` directories with their own tsconfig, each measured by its own run (T32). */
  workspaces: string[];
  runs: {
    project: string;
    exitCode: number;
    counted: number;
    toolReported: number | null;
    kept: number;
    discarded: number;
    agree: boolean;
  }[];
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
  /** Diagnostics kept by two runs — must be empty (T32). */
  doubleCounted: string[];
  /** tsc's own first line for every kept error — what a red prints. */
  diagnostics: string[];
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

/** The ward's verdict as sentences — empty is green. Every error is named in
 *  tsc's own words, and every area tsc never reached is named as NOT LOOKED AT,
 *  which is never spelled like a zero (D42). */
function verdict(c: Census): string[] {
  const out = c.areas
    .filter((a) => a.errors === null)
    .map(
      (a) =>
        `NOT LOOKED AT — area "${a.area}" has ${a.filesInTree} file(s) in the tree and tsc's program reached none of them. This is not a count of zero. ${a.note ?? ""}`,
    );
  for (const a of c.areas) {
    if (a.errors !== null && a.errors > 0) {
      out.push(`TYPE ERROR — area "${a.area}" has ${a.errors} \`tsc --noEmit\` error(s).`);
    }
  }
  return [...out.sort(), ...c.diagnostics];
}

describe("type check ward", () => {
  test(
    "STATES WHAT IT MEASURED — runs, areas, files",
    async () => {
      const c = await census();
      console.warn(
        [
          "",
          `  TYPE CHECK — \`tsc --noEmit\`: ${c.tsc.countedErrors} error(s) in ${c.tsc.countedFilesWithErrors} file(s).`,
          `     areas: ${c.population.areasMeasured} measured of ${c.population.areasInTree} in the tree · files: ${c.population.filesExamined} examined of ${c.population.filesInTree}`,
          `     runs: ${c.runs.map((r) => `${r.project} (${r.kept} kept, ${r.discarded} discarded)`).join(" · ")} — each file counted by its OWNING run only (T32)`,
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
    "ZERO — no `tsc --noEmit` error in any area, and no area left unexamined",
    async () => {
      const c = await census();
      // ⛔ ASSERTED ON RENDERED SENTENCES, so a red prints tsc's own lines and
      // names any area that went unmeasured, rather than reporting that two
      // numbers differ.
      expect(verdict(c)).toEqual([]);
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "every area the ward NAMES was actually EXAMINED (D42)",
    async () => {
      const c = await census();
      // A row with `errors: null` is an area this ward names and tsc did not look
      // at. It must never pass, and it must never be spelled like a zero — the
      // ZERO cell names it, and this cell also pins the population counts, which
      // catch the case the null alone cannot (below).
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
      // and against ZERO, so a run where both agree on a non-zero number is red. ⚠ `toolReportedErrors` is `number | null`
      // and the `null` is a third state (the summary line was unreadable), so it
      // is compared here rather than coerced with a `?? 0` — which is the
      // fallback proposal R3 exists to refuse.
      expect([c.tsc.countedErrors, c.tsc.toolReportedErrors]).toEqual([0, 0]);
      expect(c.tsc.errorsAgree).toBe(true);
      expect(c.closureHolds).toBe(true);
      expect(c.unassigned).toEqual([]);
      // The ONE check that can see a double count (T32): the closure and the
      // per-run agreement are both computed from the kept lines.
      expect(c.doubleCounted).toEqual([]);
      expect(c.sumOfAreas).toBe(c.tsc.countedErrors);
      // 0 (clean) or 2 (errors found) and nothing else. A 1 — a rejected flag —
      // arriving here as "no errors" would be the silent green this ward is about.
      expect(c.tsc.exitUnderstood).toBe(true);
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
describe("type check ward — calibration", () => {
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
    "WORKSPACE — a file under a `src/<dir>/tsconfig.json` is measured under THAT config, once (T32)",
    async () => {
      const dir = mintFixture();
      try {
        // A workspace whose config maps `@/*` — the house shape for a shadcn
        // spell. Under the ROOT config the alias does not resolve (TS2307);
        // under the workspace's own config it does, and that is the verdict
        // that must count.
        writeFileSync(
          join(dir, "src", "alpha", "tsconfig.json"),
          `${JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { paths: { "@/*": ["./surface/*"] } } })}\n`,
        );
        writeFileSync(
          join(dir, "src", "alpha", "surface", "x.ts"),
          'import { b } from "@/b";\nexport const x: number = b;\n',
        );
        const clean = await censusIn(dir);
        expect(clean.workspaces).toEqual(["src/alpha"]);
        // Measured by its own config: clean — and the root run's TS2307 for the
        // same file was DISCARDED, not added to anyone's row.
        expect(errorsFor(clean)).toEqual(CLEAN);
        const root = clean.runs.find((r) => r.project === ".");
        expect(root?.discarded).toBeGreaterThan(0);
        expect(clean.tsc.errorsAgree).toBe(true);
        expect(clean.closureHolds).toBe(true);
        // Every file examined exactly once, by its owner.
        expect(clean.population.filesExamined).toBe(clean.population.filesInTree);

        // And a REAL error under the workspace config is still a rise — the
        // workspace run is not a place errors go to disappear.
        writeFileSync(
          join(dir, "src", "alpha", "surface", "x.ts"),
          'import { b } from "@/b";\nexport const x: string = b;\n',
        );
        const risen = await censusIn(dir);
        expect(errorsFor(risen)).toEqual({ ...CLEAN, "src/alpha/surface": 1 });
        expect(risen.closureHolds).toBe(true);

        // ⛔ AND A ROOT-OWNED ERROR THAT A WORKSPACE IMPORTS IS COUNTED ONCE. Both
        // runs report it; only its owner keeps it. This is the arm the first
        // version of this cell lacked — with the ownership filter removed, the
        // error counted twice and every other check stayed green (verify pass).
        writeFileSync(join(dir, "src", "lib", "c.ts"), "export const c: number = 'x';\n");
        writeFileSync(
          join(dir, "src", "alpha", "surface", "x.ts"),
          'import { b } from "@/b";\nimport { c } from "../../lib/c";\nexport const x: number = b + c;\n',
        );
        const shared = await censusIn(dir);
        expect(errorsFor(shared)).toEqual({ ...CLEAN, "src/lib": 1 });
        expect(shared.doubleCounted).toEqual([]);
        expect(shared.runs.find((r) => r.project === "src/alpha")?.discarded).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "MUTATION — an error in a BACKEND area is named, in tsc's words, and the peer areas stay at zero",
    async () => {
      const dir = mintFixture();
      try {
        writeFileSync(
          join(dir, "src", "alpha", "backend", "a.ts"),
          "export const a: number = 'x';\n",
        );
        const c = await censusIn(dir);
        expect(errorsFor(c)).toEqual({ ...CLEAN, "src/alpha/backend": 1 });
        // The sentences the gate would print, through the real renderer: the
        // area, then tsc's own line for the error.
        const said = verdict(c);
        expect(said).toHaveLength(2);
        expect(said[0]).toContain('TYPE ERROR — area "src/alpha/backend" has 1');
        expect(said[1]).toContain("src/alpha/backend/a.ts:1:14 - error TS2322");
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
        const said = verdict(c);
        expect(said[0]).toContain('TYPE ERROR — area "src/alpha/surface" has 1');
        expect(said.some((l) => l.includes("src/alpha/backend"))).toBe(false);
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
        // The ward's verdict: RED, although tsc reported no error at all.
        const said = verdict(c);
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
