#!/usr/bin/env bun
// type-debt-census — how many `tsc --noEmit` errors does each AREA of this repo
// carry, and which areas were not measured at all?
//
//     bun scripts/instruments/type-debt-census.ts                    # JSON on stdout
//     TYPE_DEBT_ROOT=/path/to/a/tree bun scripts/instruments/type-debt-census.ts
//
// ⛔ DELIBERATELY NOT A `.test.ts`, for both of `gate-blind-set.ts`'s reasons.
// A test file is COLLECTED the moment it exists, so an in-progress instrument
// turns a peer's live gate red. And IT REPORTS, IT DOES NOT GATE: the only thing
// that exits non-zero here is its OWN arithmetic breaking. 584 errors is a
// finding to report; `grimoire/type-debt-ratchet.test.ts` is what gates on it,
// exactly as that ward gates on this instrument's sibling.
//
// ⛔ AND IT IS NOT A BLOCKING WHOLE-REPO TYPECHECK. Sprint 05 ruled that out
// (`scripts/instruments/type-sentinel-probe.ts:30`) and the proposal's R2 keeps
// the ruling. This runs tsc to COUNT, and the count is compared against a
// declared per-area baseline that may only move when someone says so. A repo
// with 584 errors cannot have a red-on-any-error gate, and pretending otherwise
// would mean the gate is disabled within a day.
//
// ── THE QUESTION, STATED FIRST, BECAUSE THE QUESTION PICKS THE UNIT ─────────
// Of the hand-authored TypeScript in this repo, HOW MANY `tsc --noEmit` errors
// does each area carry — and for every area the tree has, was it MEASURED?
//
// It is NOT "does the repo typecheck" (it does not, 584 times) and it is NOT
// "which files have errors" (69 of them; that list is in tsc's own output and
// nothing here improves on it). It is a per-area SCALAR, because a scalar is
// the only thing a ratchet can hold.
//
// ── D42 GOVERNS THE RETURN SHAPE ───────────────────────────────────────────
// `errors` is `number | null`, and `null` means NOT LOOKED AT — never 0. The two
// absences are different facts:
//
//   • an area whose files tsc examined and found clean          → `errors: 0`
//   • an area in the tree that tsc's program never reached      → `errors: null`
//
// A coerced 0 is the exact silence D42 paid for three times: a subject the
// instrument NAMES and does not EXAMINE producing a row indistinguishable from
// "nothing to find". `grimoire/lib/dist-artifacts.ts` enforces this in its
// return type and that is the strongest form, so it is the form used here.
// ⚠ It is REACHABLE, not theoretical: adding `"exclude": ["src/kit"]` to the
// root `tsconfig.json` produces a `null` for `src/kit` today. Driven.
//
// ── D43: THE AREA SET IS DERIVED FROM THE TREE, NEVER NAMED ────────────────
// `areaOf()` below is the ONE classifier, and it is used twice against two
// DIFFERENT sources:
//
//   • over every `.ts`/`.tsx` on DISK        → the POPULATION (which areas exist)
//   • over tsc's own `--listFiles` output    → the MEASUREMENT (which were seen)
//
// A hand-kept area list goes blind on exactly the spell that arrives next
// (D43), so `src/<spell>/{backend,surface}` is derived the way `src/build.ts`
// derives `buildableSpells()`: a directory under `src/` is a spell iff it holds
// a `backend/` or a `surface/`. Anything else under `src/` (today: `src/kit`)
// is one area. Every other depth-1 directory of the repo is one area. Files
// sitting directly in a directory that is nobody's area land in `(root)` or
// `src`, and they are NAMED rather than dropped.
//
// ⛔ THE DISK, NOT THE INDEX (D42). tsc reads the disk, so an untracked `.ts`
// with a type error raises a count and must be in the population. D42 judged
// `trackedSources`-style index reads DIFFERENT because "what ships" for source
// is the tracked list — that is a question about shipping. This is a question
// about what the type checker examined, and the type checker examines the disk.
//
// ── C4: A DERIVED POPULATION IS NOT COVERAGE. BOTH NUMBERS ARE PRINTED ─────
// `areasInTree` and `areasMeasured` are separate fields, as are `filesInTree`
// and `filesExamined`. Phase 1b printed both and D27 amended it: printing is
// not enough, coverage must be ASSERTED — so the ward asserts they are equal.
// The printing here is for the human reading a green run.
//
// ── D27: THE SELF-CHECK IS NOT COMPUTED FROM THE THING IT BACKSTOPS ────────
// The failure conditions below are all CROSS-SOURCE. None of them asks tsc
// whether tsc was right:
//
//   • `countedErrors` (our parse of the error lines) vs `toolReportedErrors`
//     (tsc's own "Found N errors in M files." summary) — two numbers from two
//     places in one run. This is the TRUNCATION lesson made mechanical: biome's
//     default `--max-diagnostics=20` once made one missing config line look
//     like pre-existing debt, and the general repair is to print the total you
//     COUNTED beside the total the tool REPORTS and refuse to proceed when they
//     differ. tsc does not truncate today; this is what notices the day it does,
//     or the day a diagnostic arrives in a shape the regex cannot read.
//   • `sumOfAreas` vs `countedErrors` — an error in a path `areaOf` cannot
//     classify would otherwise vanish from every row while the total stayed
//     right. `unassigned` names those paths.
//   • the exit code is 0 or 2 and nothing else. tsc exits 1 on a bad flag and 2
//     on "there were errors"; a 1 that arrived here as "0 errors" would be a
//     silent green, which is this instrument's whole subject.
//
// ── WHAT THIS INSTRUMENT CANNOT SEE ────────────────────────────────────────
//   • WHETHER AN ERROR IS THE SAME ERROR. It is a COUNT. A fix and a fresh
//     defect in one area at one commit net to zero and this is silent about it.
//     The ward's exact-equality pin is what makes any movement announce itself;
//     within one number at one commit, nothing here discriminates.
//   • ⛔ A COUNT CAN FALL WITH NOTHING FIXED, and every route is worth knowing
//     because each one is a green nobody earned:
//       - `@ts-expect-error`, `@ts-nocheck`, `arr[i]!`, `as any`, `?? fallback`
//         — proposal R3's whole subject; the error disappears and the reachable
//         `undefined` does not.
//       - DELETING a file, or MOVING it to another area. A relocation lowers one
//         area and raises another, and the pin reds on both halves, naming both.
//       - ⛔ A DE-DUPLICATION (D64, twice). `resolveMode`'s inlined body became
//         `resolveModeIn(DIST_DIR)` and the spawn-path ward's coverage fell by
//         one with nothing changed, because a coverage COUNT going down is not
//         a failure. It is a failure HERE: a fall reds this ward with "the
//         baseline is stale", so the tidy-up that lowered it has to be
//         accounted for in the re-declaration. That is the whole argument for
//         fails-with-instruction over auto-lowering.
//       - A REBUILD, via the `(generated)` bucket below. Excluded from every
//         hand-authored area for exactly this reason, and still counted.
//   • WHETHER A FILE IS RIGHT. Zero errors means tsc had no complaint, not that
//     the code works. The gate's other arms are what read behaviour.
//   • THE STRICTER FLAGS `tsconfig.json` LEAVES OFF (`noUnusedLocals`,
//     `noUnusedParameters`, `noPropertyAccessFromIndexSignature`). Every number
//     here is measured against the flags as configured; turning one on is a
//     different measurement and a different project.
//
// ── ⛔ A WORKSPACE IS MEASURED UNDER ITS OWN `tsconfig.json` (type-debt T32) ──
// This scope note used to say the census runs the ROOT config over the whole
// tree and that the workspace configs (`src/<spell>/tsconfig.json`, which map
// `@/*` to that spell's surface) were out of scope, because "bounty is 126
// under its own config against 128 under the root, so the root's answer is not
// an artifact of the aliases". That held for bounty and was FALSE for the spell
// measured next: under its own config grapevine's surface is 0; under the root
// it was 37 — 27 unresolved `@/` imports and 10 implicit-anys cascading from
// them. Worse than inflated: every shadcn component there was `any` to the
// root run, so a real prop-type error in that surface was INVISIBLE. The
// playbook already said so ("`tsc -p src/<spell>` is the honest check").
//
// So: every directory `src/<dir>/` holding a `tsconfig.json` is a WORKSPACE,
// derived from the tree like everything else here. The root run still runs
// over everything, and then EACH FILE HAS EXACTLY ONE OWNER — a workspace owns
// every file under its directory; the root owns the rest. A file's `examined`
// status and its errors come ONLY from its owner's run; the other runs'
// diagnostics for it are discarded (and counted as discarded, so each run's
// own total still cross-checks). One owner per file is what PREVENTS a double
// count — but ⚠ the closure and the per-run agreement cannot DETECT one (both
// are computed from the kept lines), so a separate check does: no diagnostic may
// be kept by two runs (`doubleCounted`, below). Found by the verify pass, which
// removed the ownership filter and watched every other check stay green. The build
// resolves `@/` the same way — per importing file, from the nearest tsconfig —
// so this measures the tree the way it is built.
//
// ── ⛔ tsc EXAMINES `dist/`, AND THAT IS WHY `(generated)` EXISTS ───────────
// `allowJs: true` and no `exclude` in `tsconfig.json` means the root program
// pulls in 24 emitted `plugins/**/dist/*.js` bundles. Every other instrument in
// this repo defines "generated" as "under dist/" — biome excludes it,
// `gate-blind-set`'s GENERATED regex matches it — so folding them into
// `plugins` would put a number that MOVES ON EVERY REBUILD inside a
// hand-authored area's baseline. They are not dropped either: dropping them
// would break the `sumOfAreas` closure and hide a real error in emitted output.
// They get their own derived bucket, counted and pinned like any other.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The tree to census. The hook exists so the ward can drive this against a
 *  throwaway tree it built, rather than proving only that it can read this one.
 *
 *  ⛔ `realpathSync`, AND IT IS A DEFECT FIX FOUND BY CALIBRATION. tsc prints
 *  `--listFiles` paths RESOLVED, so a census root reached through a symlink —
 *  which every `mkdtemp` under macOS's `/tmp` is, `/tmp` being a link to
 *  `/private/tmp` — made every `relative(ROOT, line)` start with `..`, the
 *  examined set come out EMPTY, and every area report `NOT LOOKED AT` while the
 *  error lines were counted fine. The closure check caught it (1 counted, 0
 *  decomposed), which is that check earning its place on its first run. */
const ROOT = realpathSync(process.env.TYPE_DEBT_ROOT ?? join(import.meta.dir, "..", ".."));

/** The repo's own `tsc`, resolved from THIS file rather than from the census
 *  root — a fixture root has no `node_modules`, and `bunx tsc` inside one
 *  installs a second, unpinned compiler whose count would not be comparable. */
const TSC =
  process.env.TYPE_DEBT_TSC ?? join(import.meta.dir, "..", "..", "node_modules", ".bin", "tsc");

/** The WORKSPACES: every `src/<dir>/` that holds its own `tsconfig.json` (T32).
 *  Derived from the tree — a named list would go blind on the next spell (D43).
 *  Repo-relative, POSIX, sorted. */
function workspaces(): string[] {
  const src = join(ROOT, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(src, e.name, "tsconfig.json")))
    .map((e) => `src/${e.name}`)
    .sort();
}
const WORKSPACES = workspaces();

/** The ONE run whose verdict on `rel` counts: the workspace whose directory
 *  contains it, else the root (`.`). Total by construction — every path has an
 *  owner — which is what keeps each file in exactly one run's tally. */
function ownerOf(rel: string): string {
  return WORKSPACES.find((w) => rel.startsWith(`${w}/`)) ?? ".";
}

/** Every extension tsc's program can admit under this `tsconfig.json`.
 *  ⛔ `.js` IS IN HERE BECAUSE `allowJs: true` IS, and leaving it out was this
 *  instrument's first defect: the tree walk found 519 files, tsc examined 543,
 *  and the 24 emitted `plugins/**\/dist/*.js` bundles existed in the
 *  MEASUREMENT with no row in the POPULATION — `areasMeasured` (32) came out
 *  ABOVE `areasInTree` (31), which is C4's coverage arithmetic inverted. A
 *  population that cannot contain the subject is not a smaller population, it
 *  is the wrong one. `.mjs`/`.cjs`/`.jsx` are admitted for the same reason and
 *  have no members today. */
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const GENERATED = /(^|\/)dist\//;
/** `**` in tsconfig's default `include` does not match a leading dot, so tsc
 *  never walks `.claude/` or `.git/`; the tree walk must agree or the
 *  population would carry areas the measurement structurally cannot reach. */
const SKIP_DIR = /^(node_modules|\.)/;

const GENERATED_AREA = "(generated)";
const ROOT_AREA = "(repo root)";

/** Is this depth-1 directory under `src/` a SPELL? Derived the way
 *  `src/build.ts`'s `buildableSpells()` is: a spell is a directory that holds a
 *  `backend/` or a `surface/`. ⛔ Not a name list — a hand-kept roster goes
 *  blind on exactly the spell that arrives next (D43), and `src/kit` is
 *  correctly excluded by the rule rather than by an exception. */
function isSpell(dir: string): boolean {
  return (
    existsSync(join(ROOT, "src", dir, "backend")) || existsSync(join(ROOT, "src", dir, "surface"))
  );
}

/**
 * The ONE classifier, run over two different sources (the disk walk and tsc's
 * `--listFiles`). A repo-relative POSIX-ish path in, an area name out.
 *
 * ⛔ IT IS TOTAL BY CONSTRUCTION — every path gets an area — and that is what
 * makes the `sumOfAreas === countedErrors` closure meaningful. A classifier
 * with a "none of the above" branch would let an error leave every row while
 * the total stayed right, which is the shape of every silence D42 records.
 */
function areaOf(rel: string): string {
  if (GENERATED.test(rel)) return GENERATED_AREA;
  // ⛔ DESTRUCTURED, NOT INDEXED, AND THAT IS PROPOSAL R3 APPLIED TO THIS FILE.
  // `parts[1] as string` would compile and would be a lie: this instrument's
  // own count must not be bought with the assertion the project exists to
  // remove. The narrowing below is the honest read of "is there a second
  // segment", and the fall-through answers are real answers.
  const [first, second, third] = rel.split("/");
  if (first === undefined) return ROOT_AREA;
  if (second === undefined) return ROOT_AREA;
  if (first !== "src") return first;
  if (third === undefined) return "src";
  if (isSpell(second) && (third === "backend" || third === "surface")) {
    return `src/${second}/${third}`;
  }
  return `src/${second}`;
}

/** Every `.ts`/`.tsx` on the DISK under `root`, repo-relative, dot-dirs and
 *  `node_modules` skipped so the walk sees the same world tsc's include does. */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      walkSources(join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE.test(entry.name)) {
      out.push(relative(ROOT, join(dir, entry.name)).split(sep).join("/"));
    }
  }
  return out;
}

/** ⛔ BUILT FROM A CHAR CODE, NOT WRITTEN AS `\x1b`. biome's
 *  `noControlCharactersInRegex` rejects the literal escape, and a suppression
 *  comment for a rule that is right would be the pointer-only-suppression
 *  habit this repo already ruled against. */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
/** tsc's PRETTY error line: `path:line:col - error TS1234: message`.
 *  ⛔ ANCHORED ON A NON-SPACE FIRST CHARACTER. Pretty output indents the source
 *  excerpt, the squiggle and the whole related-information block by two spaces —
 *  and a related-information line names a FILE, so an unanchored match would
 *  count one diagnostic twice and the `toolReportedErrors` cross-check is what
 *  would catch it. The end-of-run summary table is indented too. */
const ERROR_LINE = /^([^\s].*?):(\d+):(\d+) - error (TS\d+):/;
// ── ⛔ tsc's OWN TOTAL COMES IN THREE SHAPES, AND ASSUMING ONE WAS A DEFECT ──
// It is printed ONLY by the pretty reporter — `--pretty false` gives one compact
// line per error and NO summary — which is why this runs pretty and parses the
// verbose form. The cross-check is worth more than the smaller buffer.
//
// ⛔ AND THE FIRST VERSION MATCHED ONLY `Found N errors in M files.`, WHICH IS
// THE SHAPE THIS REPO HAPPENS TO PRODUCE. Driven against a five-file fixture,
// tsc printed `Found 1 error in src/alpha/backend/a.ts:1` — no file COUNT at
// all — so `toolReportedErrors` came back `null`, the agreement check went red,
// and the instrument correctly refused to stand behind its numbers. Three
// shapes exist and all three are read here:
//
//     Found 3 errors in 2 files.
//     Found 2 errors in the same file, starting at: src/alpha/backend/a.ts:1
//     Found 1 error in src/alpha/backend/a.ts:1
//
// That is the TRUNCATION LESSON in its general form: the cross-check is only
// worth something if it can READ the tool's own total, and a parser calibrated
// against one repo's output is calibrated against one repo's error count. A
// fourth shape arriving tomorrow lands as `null` → a loud refusal, never as a
// quiet zero. With zero errors tsc prints nothing at all and exits 0; that case
// is handled below rather than read as a missing summary.
const SUMMARY_MULTI_FILE = /^Found (\d+) errors? in (\d+) files?\.$/m;
const SUMMARY_ONE_FILE = /^Found (\d+) errors? in (?:the same file, starting at: )?\S+:\d+$/m;

type Run = { exitCode: number; stdout: string };

function runTsc(project: string): Run {
  // `--listFiles` so the MEASUREMENT's population comes from tsc itself rather
  // than from a second guess at what tsc reads. Measured: it costs nothing
  // (6.0s vs 6.2s wall on this repo). `-p` names the config; cwd stays ROOT so
  // every run prints paths relative to the same place. A workspace run costs
  // ~1s on this repo (T32).
  const args = ["--noEmit", "--pretty", "true", "--listFiles", "-p", project];
  try {
    const stdout = execFileSync(TSC, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    if (typeof e.status !== "number") {
      // Could not RUN it — a missing binary, a killed process. Not a count of
      // zero: an unrunnable checker is the "not looked at" case for the whole
      // repo, and it must not arrive as a clean bill of health.
      throw new Error(`type-debt-census: could not run ${TSC}: ${e.message ?? String(err)}`);
    }
    return { exitCode: e.status, stdout: e.stdout ?? "" };
  }
}

type RunTally = {
  project: string;
  exitCode: number;
  /** Error lines this instrument parsed from the run — ALL of them, owned or not. */
  counted: number;
  /** The run's own summary total; `null` = unreadable (fatal below). */
  toolReported: number | null;
  toolReportedFiles: number | null;
  /** Lines for files this run OWNS — the only ones that reach an area. */
  kept: number;
  /** Lines for files another run owns — measured there, discarded here. */
  discarded: number;
  agree: boolean;
};

const examined = new Set<string>();
const errorLines: { file: string; code: string }[] = [];
const runs: RunTally[] = [];
/** ⛔ THE DOUBLE-COUNT CHECK, AND IT HAD TO BE ADDED BECAUSE THE OTHERS CANNOT
 *  SEE ONE. Each run's `agree` compares its summary with its OWN parsed lines,
 *  and the combined total is those runs net of their discards — so if the
 *  ownership filter ever stopped filtering, the same diagnostic would be kept by
 *  two runs and EVERY other check here would still pass (the verify pass drove
 *  exactly that: a root-owned error imported into a workspace, counted twice,
 *  `errorsAgree` and `closureHolds` both true). This is the independent one: a
 *  diagnostic's position (`file:line:col:code`) may be KEPT by one run only.
 *  Within one run a repeat is legitimate (tsc reports two TS2532 at one column);
 *  across runs it is a double count. */
const keptBy = new Map<string, string>();
const doubleCounted: string[] = [];
for (const project of [".", ...WORKSPACES]) {
  const run = runTsc(project);
  const plain = run.stdout.replace(ANSI, "");
  const lines = plain.split("\n");

  // tsc's own file list is ABSOLUTE. Only files inside the census root and
  // outside `node_modules` are the subject; the lib.d.ts family and installed
  // packages are read by tsc and owned by nobody here. And a file counts as
  // examined only by the run that OWNS it (T32).
  for (const line of lines) {
    if (!line.startsWith("/")) continue;
    if (!SOURCE.test(line)) continue;
    const rel = relative(ROOT, line);
    if (rel.startsWith("..") || rel.includes("node_modules/")) continue;
    const posix = rel.split(sep).join("/");
    if (ownerOf(posix) === project) examined.add(posix);
  }

  let counted = 0;
  let kept = 0;
  for (const line of lines) {
    const m = ERROR_LINE.exec(line);
    if (!m) continue;
    const [, file, lineNo, col, code] = m;
    if (file === undefined || code === undefined) continue;
    counted++;
    const posix = file.split(sep).join("/");
    if (ownerOf(posix) !== project) continue;
    kept++;
    errorLines.push({ file: posix, code });
    const key = `${posix}:${lineNo}:${col}:${code}`;
    const prior = keptBy.get(key);
    if (prior !== undefined && prior !== project)
      doubleCounted.push(`${key} (${prior} and ${project})`);
    else keptBy.set(key, project);
  }

  const multi = SUMMARY_MULTI_FILE.exec(plain);
  const single = multi ? null : SUMMARY_ONE_FILE.exec(plain);
  // Exit 0 means tsc found nothing and printed no summary — a real state, not a
  // missing one. Any other exit with no readable summary leaves both `null`,
  // which is the instrument being unable to read the tool, and is fatal below.
  const toolReported = multi
    ? Number(multi[1])
    : single
      ? Number(single[1])
      : run.exitCode === 0
        ? 0
        : null;
  const toolReportedFiles = multi ? Number(multi[2]) : single ? 1 : run.exitCode === 0 ? 0 : null;
  runs.push({
    project,
    exitCode: run.exitCode,
    counted,
    toolReported,
    toolReportedFiles,
    kept,
    discarded: counted - kept,
    agree: toolReported === counted,
  });
}

// ⛔ THE COMBINED "TOOL TOTAL" IS EACH RUN'S OWN SUMMARY MINUS WHAT IT DISCARDED.
// Each run is cross-checked against ITSELF (`agree`: its summary vs its parsed
// lines), so a parse that drops a line in any run is still caught there; the
// subtraction only removes lines another run owns and measured.
const toolReportedErrors = runs.some((r) => r.toolReported === null)
  ? null
  : runs.reduce((n, r) => n + (r.toolReported ?? 0) - r.discarded, 0);
const rootRun = runs[0];
if (rootRun === undefined) throw new Error("type-debt-census: the root run did not happen");

const inTree = walkSources(ROOT);

// ── THE TWO POPULATIONS, THROUGH ONE CLASSIFIER ────────────────────────────
const treeByArea = new Map<string, number>();
for (const rel of inTree) {
  const area = areaOf(rel);
  treeByArea.set(area, (treeByArea.get(area) ?? 0) + 1);
}
const examinedByArea = new Map<string, number>();
for (const rel of examined) {
  const area = areaOf(rel);
  examinedByArea.set(area, (examinedByArea.get(area) ?? 0) + 1);
}
const errorsByArea = new Map<string, number>();
const shippedByArea = new Map<string, number>();
const testsByArea = new Map<string, number>();
const unassigned: string[] = [];
const byClass = new Map<string, number>();
for (const { file, code } of errorLines) {
  byClass.set(code, (byClass.get(code) ?? 0) + 1);
  const area = areaOf(file);
  // An area the classifier invented for a path the tree walk never saw. It
  // cannot happen while `areaOf` is total and both sources agree on the tree —
  // and if it ever does, the error is in NO row, which is the failure the
  // closure below exists to make loud.
  if (!treeByArea.has(area) && !examinedByArea.has(area)) unassigned.push(file);
  errorsByArea.set(area, (errorsByArea.get(area) ?? 0) + 1);
  const isTest = /\.test\.tsx?$/.test(file);
  const bucket = isTest ? testsByArea : shippedByArea;
  bucket.set(area, (bucket.get(area) ?? 0) + 1);
}

/** ⛔ `errors: null` MEANS NOT LOOKED AT. See the D42 note in the header; a
 *  caller that reads it as 0 has re-committed the defect this shape prevents. */
type AreaRow = {
  area: string;
  errors: number | null;
  shipped: number | null;
  tests: number | null;
  filesInTree: number;
  filesExamined: number;
  note?: string;
};

const areas: AreaRow[] = [...new Set([...treeByArea.keys(), ...examinedByArea.keys()])]
  .sort()
  .map((area) => {
    const filesExamined = examinedByArea.get(area) ?? 0;
    const filesInTree = treeByArea.get(area) ?? 0;
    if (filesExamined === 0) {
      return {
        area,
        errors: null,
        shipped: null,
        tests: null,
        filesInTree,
        filesExamined,
        note: `NOT LOOKED AT — ${filesInTree} source file(s) in the tree, none in tsc's program`,
      };
    }
    return {
      area,
      errors: errorsByArea.get(area) ?? 0,
      shipped: shippedByArea.get(area) ?? 0,
      tests: testsByArea.get(area) ?? 0,
      filesInTree,
      filesExamined,
    };
  });

const countedErrors = errorLines.length;
const sumOfAreas = areas.reduce((n, a) => n + (a.errors ?? 0), 0);
const measured = areas.filter((a) => a.errors !== null);
const errorsAgree = runs.every((r) => r.agree) && toolReportedErrors === countedErrors;
const closureHolds = sumOfAreas === countedErrors && unassigned.length === 0;
const exitUnderstood = runs.every((r) => r.exitCode === 0 || r.exitCode === 2);
const exitCode = Math.max(...runs.map((r) => r.exitCode));

console.log(
  JSON.stringify(
    {
      root: ROOT,
      invocation: [TSC, "--noEmit", "--pretty", "true", "--listFiles", "-p", "<project>"],
      workspaces: WORKSPACES,
      runs,
      tsc: {
        exitCode,
        exitUnderstood,
        countedErrors,
        toolReportedErrors,
        // The ROOT run's own file count; per-run counts are in `runs`.
        toolReportedFiles: rootRun.toolReportedFiles,
        countedFilesWithErrors: new Set(errorLines.map((e) => e.file)).size,
        errorsAgree,
      },
      population: {
        areasInTree: treeByArea.size,
        areasMeasured: measured.length,
        filesInTree: inTree.length,
        filesExamined: examined.size,
      },
      closureHolds,
      doubleCounted,
      sumOfAreas,
      unassigned,
      byClass: Object.fromEntries([...byClass.entries()].sort((a, b) => b[1] - a[1])),
      areas,
    },
    null,
    2,
  ),
);

// ── THE ONLY FAILURE CONDITIONS: THIS INSTRUMENT'S OWN ARITHMETIC ──────────
// A large error count is a finding to REPORT, never an error to raise — that
// distinction is `gate-blind-set`'s remit and it is this one's too. What exits
// non-zero is the instrument being unable to stand behind its own numbers.
const faults: string[] = [];
for (const r of runs) {
  if (r.exitCode !== 0 && r.exitCode !== 2) {
    faults.push(
      `tsc -p ${r.project} exited ${r.exitCode}, which is neither 0 (clean) nor 2 (errors found). Every number above was parsed from the output of a run that did not do what was asked.`,
    );
  }
  if (!r.agree) {
    faults.push(
      `COUNT DISAGREEMENT in \`tsc -p ${r.project}\` — this instrument counted ${r.counted} error line(s); tsc reports ${r.toolReported}. Every per-area number above is unusable.`,
    );
  }
}
if (!errorsAgree) {
  faults.push(
    `COUNT DISAGREEMENT — this instrument counted ${countedErrors} error line(s); tsc reports ${toolReportedErrors}. One of us is not seeing all of the output (a truncating flag, a diagnostic shape the parser cannot read, a double-counted related-information line). Every per-area number above is unusable.`,
  );
}
if (doubleCounted.length > 0) {
  faults.push(
    `DOUBLE COUNT — ${doubleCounted.length} diagnostic(s) were kept by two runs: ${doubleCounted.slice(0, 5).join(", ")}. Each file has one owning run (T32); a diagnostic kept twice is in two rows, and no total above means anything.`,
  );
}
if (!closureHolds) {
  faults.push(
    `CLOSURE BROKEN — ${countedErrors} counted error(s) decompose into ${sumOfAreas} across areas, with ${unassigned.length} unclassified path(s): ${unassigned.slice(0, 5).join(", ")}. An error in no row is an error nobody's baseline holds.`,
  );
}
if (faults.length > 0) {
  for (const f of faults) console.error(`type-debt-census: ${f}`);
  process.exit(1);
}
