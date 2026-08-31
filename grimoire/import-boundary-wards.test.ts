// THE IMPORT-BOUNDARY WARDS — R6 (spell-kit). THREE checks, two directions.
//
//   1a  OUTWARD, structural   no tracked file under `plugins/spellbook/` STATICALLY
//                             resolves a RELATIVE specifier outside it.
//   1b  OUTWARD, dependency   no file on the SHIPPED EXECUTION PATH (`scripts/`,
//                             `shared/` — never `surface/`) statically imports a
//                             bare specifier outside `node:` / `bun:` / `bun`.
//   2   DOWNWARD              no file under `src/kit/` makes a RELATIVE import
//                             outside `src/kit/`. The kit is a leaf.
//
// ⛔ 1a AND 1b ARE TWO WARDS AND THIS IS THE WHOLE POINT OF R6's CORRECTION.
// A single predicate phrased "may not statically import outside
// plugins/spellbook/" reads, in English, over BARE specifiers too. R6 counted
// 88 of them; RE-COUNTED HERE 2026-08-31 the figure is 95 — 49 react/react-dom,
// 42 lucide-react, 4 bare `bun`, and `sharp` is now 0 because daedalus retired
// it mid-session. R6's 34 for lucide-react does not reproduce and I did not
// inherit it. ⚠ THE NUMBER MOVED AND THE ARGUMENT DID NOT: either version is
// RED ON ARRIVAL AGAINST ~90 CORRECT FILES, and that version was drafted into a
// sprint plan and nearly built. The measurement behind it had counted RELATIVE
// specifiers only, so the English and the number were describing two different
// wards. Do not re-merge them.
//
// ⛔ WHY THE BARE `bun` EXEMPTION IN 1b IS LOAD-BEARING, AND MEASURED:
// written as `node:`/`bun:` alone the predicate is RED on four files today —
// astrolabe, bounty, imago and magpie each carry
// `import type { ServerWebSocket } from "bun"`, type-only and erased at runtime.
//     4 violations without the exemption · 0 with it   (re-measured 2026-08-31)
// The exemption is not a courtesy; deleting it turns this cell red against
// correct code, which is the same defect as the retracted Ward 1 above.
//
// ⛔ DYNAMIC ESCAPES ARE EXEMPT BUT PINNED — NOT ALLOWLISTED. There is one, and
// it is Contract 1's dev-only mode resolution: a release daemon must never pull
// the surface build graph into its load path, so that import is dynamic ON
// PURPOSE. A ward phrased over all imports would be red against correct code.
// The exemption is an INVENTORY on the `exit-site-inventory.test.ts` model: a
// new escape fails this suite until a human re-declares it. An exemption nobody
// has to look at again is how the next one arrives unnoticed.
//
// ── ⛔ WHAT THESE THREE WARDS CANNOT SEE — read before trusting a green ─────
//   1. `.ts` / `.tsx` ONLY. A `<script src="../../x.js">` in a hand-authored
//      `.html` surface escapes every one of them. That population is the blind
//      set (`gate-honesty.test.ts`) — the same hole from the other side.
//   2a. THE `type` / `dynamic` SPLIT IS A HEURISTIC (`isTypePosition`). It can
//      misfile a value dynamic import in an object-literal or ternary value
//      position as a type query. It CANNOT hide an escape: ward 1a checks
//      `static`+`type` for escapes and `dynamic` against the pin, and those two
//      cells partition every relative specifier. A misclassification moves a
//      finding between cells; it never removes one.
//   2. 1a is BLIND TO BARE SPECIFIERS and 1b sees only `scripts/` + `shared/`.
//      A dependency escaping through `surface/` is invisible to BOTH, correctly:
//      the bundler erases it before anything ships.
//   3. `shared/` DOES NOT EXIST YET (R1 creates it in Phase 1b). Half of 1b's
//      stated population is forward-looking, and today the ward is `scripts/`
//      alone. It is not vacuous — `scripts/` is 40 non-test files — but do not
//      read a green as evidence about `shared/`.
//   4. 1b EXCLUDES `*.test.ts`. Ruled, not overlooked: a test is not on the
//      shipped execution path, never runs at a destination, and legitimately
//      imports dev-only packages (imago's fixture builder is the live case).
//      MEASURED BOTH WAYS at 2026-08-31: 0 violations including tests, 0
//      excluding them — so today the choice costs nothing and is recorded for
//      the day it does. The hole it leaves is real: a `*.test.ts` under
//      `scripts/` is still a file that ships to a consumer who cannot resolve
//      its imports. Nothing here says otherwise.
//   5. 1a permits `plugins/spellbook/lib/` ON PURPOSE (R6) — it enforces "the
//      artifact works", not "which sharing mechanism won". It must NOT be read
//      as endorsing Sprint 02's emission ruling, which is unmade.
//   6. NONE of these runs `bunx tsc`. The gate is `check && test`, and the repo
//      carries 434 typecheck errors it does not gate on.
//   7. Ward 2 cannot see a kit that becomes app-shaped by having a spell's types
//      COPIED INTO it rather than imported. Only review catches that.

// ── HOW TO CALIBRATE THESE CELLS — the routes, because a check whose failing
//    case cannot be reached is not a check ─────────────────────────────────
// Every route below was RUN, and one of them found a defect in this file (see
// KIT_ABS). Filter with `bun test <file> -t "<substring>"`.
//
//   1a static escape   Edit any TRACKED file under plugins/spellbook/ in the
//                      WORKING TREE and add `import x from "../../../..//<a
//                      path outside the subtree>"`. No `git add` is needed —
//                      `git ls-files` supplies the path list, the CONTENT is
//                      read from disk — so this leaves the index untouched and
//                      is safe on a tree another seat is using.
//   1a dynamic pin     Same file, `import("<outside>")` in an arrow function.
//   1b bare specifier  Same, in a NON-test file under `scripts/`:
//                      `import sharp from "sharp";`
//   1b bun exemption   Delete `|| spec === "bun"` from BUILTIN. Expect FOUR
//                      named violations — R6's measured number, live.
//   2  zero-guard      `KIT_DIR=/abs/path/to/an/EMPTY/dir bun test … -t ZERO-GUARD`.
//                      Must FAIL ("Received: 0"). If it PASSES, the hook is
//                      dead and nothing here is calibrated.
//   2  violation       `KIT_DIR=/abs/path/to/a/kit/with/an/escaping/import`.
//   cross-check        Break `lib/import-graph.ts` so it MISSES imports — either
//                      make STATIC_RE line-bound (`[^;()\n]*?`), which drops
//                      every multi-line import, OR drop `export` from STATIC_RE,
//                      which drops all SEVEN re-exports.
//                      ⛔ THIS ENTRY PREVIOUSLY TOLD YOU THE OPPOSITE, and the
//                      retraction is the most important line in this header.
//                      It said the tree contains ZERO re-exports and that the
//                      mutation was therefore a no-op. IT CONTAINS SEVEN
//                      (astrolabe/scripts/server.ts:75 ·
//                      imago/scripts/server.ts:1647,1648 ·
//                      magpie/scripts/backend.ts:20 ·
//                      magpie/scripts/server.ts:874,875,876). The author's
//                      grep was anchored to a single line and could not see a
//                      multi-line `export { … } from`, so "no matches" was read
//                      as "no such construct".
//                      The green it produced was MASKING, not emptiness: the
//                      cell compared per-file SETS, and every re-exported
//                      specifier is also imported normally in the same file, so
//                      the set was identical either way. With `export` handling
//                      broken, a real relative escape written
//                      `export type {} from "<outside>"` passed ward 1a and the
//                      suite reported 9 pass / 0 fail. The cell now compares
//                      COUNTS, and a dedicated cell names the seven sites.
//                      ⚠ A wrong FACT gets corrected by the next person who
//                      looks; a wrong WARNING stops them looking. That is why
//                      this is retracted in place rather than quietly deleted.
//   re-export cell     Delete any one of the seven sites, or drop `export` from
//                      STATIC_RE — the named-inventory cell reddens either way.
//   type queries       Delete rule 1 or rule 2 from `isTypePosition` in
//                      lib/import-graph.ts. The type-query cell reddens and
//                      says why; without it the pinned inventory would redden
//                      instead and read as an undeclared runtime escape.
//
// The population-level cells (1a/1b) can also run against a throwaway repo via
// `SPELLBOOK_REPO_ROOT`, but note the PINNED cell names real repo paths and
// will fail there for that reason, not for the planted one.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ImportKind, isRelative, scanSpecifiers } from "./lib/import-graph.ts";

const REPO_ROOT =
  process.env.SPELLBOOK_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The artifact boundary — what the Claude marketplace actually copies. */
const PLUGIN_ROOT = "plugins/spellbook";

/** Repo-relative tracked `.ts`/`.tsx` under a prefix. "Shipped" means TRACKED. */
function trackedSources(prefix: string): string[] {
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files", prefix], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f));
}

/** Resolve a relative specifier against its importer, repo-relative, POSIX-ish. */
function resolveFrom(importer: string, spec: string): string {
  return relative(REPO_ROOT, resolve(REPO_ROOT, dirname(importer), spec)).replaceAll("\\", "/");
}

type Escape = { file: string; spec: string; line: number; resolved: string };

/**
 * Every relative specifier in `files`, of the given KINDS, resolving outside
 * `boundary`.
 *
 * ⛔ WARD 1a CHECKS `static` + `type` FOR ESCAPES AND `dynamic` AGAINST THE PIN,
 * and that partition is exhaustive on purpose: every relative specifier lands in
 * exactly one of the two cells, so no classification mistake inside the scanner
 * can make an escape invisible. It can only put it in the wrong cell.
 */
function relativeEscapes(files: string[], boundary: string, kinds: ImportKind[]): Escape[] {
  const out: Escape[] = [];
  for (const file of files) {
    for (const ref of scanSpecifiers(readFileSync(join(REPO_ROOT, file), "utf8"))) {
      if (!kinds.includes(ref.kind) || !isRelative(ref.spec)) continue;
      const resolved = resolveFrom(file, ref.spec);
      if (resolved.startsWith(`${boundary}/`)) continue;
      out.push({ file, spec: ref.spec, line: ref.line, resolved });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ── WARD 1a ─────────────────────────────────────────────────────────────────

// ⛔ THE PINNED DYNAMIC-ESCAPE INVENTORY. One entry. Read the site before you
// add a second — the question is never "is it dynamic?" but "does it run at the
// DESTINATION?", and static-vs-dynamic is only the mechanical stand-in for that.
// `mind-mapper/scripts/server.ts` reaches `src/` for its dev-mode HTMLBundle;
// release mode is chosen by `dist/` presence and the artifact always has a
// `dist/`, so this line never executes where it cannot resolve.
const PINNED_DYNAMIC_ESCAPES: Escape[] = [
  {
    file: "plugins/spellbook/skills/mind-mapper/scripts/server.ts",
    spec: "../../../../../src/mind-mapper/surface/index.html",
    line: 552,
    resolved: "src/mind-mapper/surface/index.html",
  },
];

describe("R6 ward 1a — the published artifact resolves no relative path outside itself", () => {
  const files = trackedSources(PLUGIN_ROOT);

  test("the sweep actually ran (zero-guard: a dead walk and a clean walk look identical)", () => {
    // 206 at the measurement R6 was ruled on. Asserted as a floor, not a pin —
    // a pin here would fail on every new source file for no invariant reason,
    // and the defect this guards is a sweep that enumerated NOTHING.
    expect(files.length).toBeGreaterThan(150);
    const specifiers = files.flatMap((f) =>
      scanSpecifiers(readFileSync(join(REPO_ROOT, f), "utf8")),
    );
    expect(specifiers.length).toBeGreaterThan(500);
  });

  test("no LOAD-TIME relative import escapes plugins/spellbook/ (statements + type queries)", () => {
    // `type` rides with `static` deliberately. `export type T = import("../out").X`
    // and `import type { X } from "../out"` are the SAME dependency written two
    // ways — same file, same tsc breakage, same nothing at runtime. Covering one
    // and exempting the other would leave a one-line bypass of this entire ward.
    expect(relativeEscapes(files, PLUGIN_ROOT, ["static", "type"])).toEqual([]);
  });

  test("the DYNAMIC escapes are exactly the pinned inventory — a new one fails until re-declared", () => {
    // Compared whole, both directions, so the failure names WHICH site and
    // WHICH direction. A count cannot distinguish a new escape from a moved one.
    // `dynamic` ONLY. A type query is not deferred to a call and has no business
    // in an inventory of runtime escapes — it is checked by the cell above.
    expect(relativeEscapes(files, PLUGIN_ROOT, ["dynamic"])).toEqual(PINNED_DYNAMIC_ESCAPES);
  });
});

// ── WARD 1b ─────────────────────────────────────────────────────────────────

// ⛔ THE EXEMPTION IS DATA, NOT A BOOLEAN EXPRESSION, SO A CELL CAN REFERENCE IT.
// The first version of this ward hid `|| spec === "bun"` inside the predicate
// and "proved" it live with a cell that counted `bun` imports — a cell that
// never touched the predicate at all, and therefore PASSED SILENTLY when the
// exemption was deleted. Splitting the list out is what lets the cell below
// evaluate the ward BOTH WAYS and assert the difference.
const BUILTIN_PREFIXES = ["node:", "bun:"] as const;
/** The bare `bun` types package — type-only, erased, resolvable with no install. */
const BUILTIN_EXACT = ["bun"] as const;

const isBuiltinUnder = (exact: readonly string[]) => (spec: string) =>
  BUILTIN_PREFIXES.some((p) => spec.startsWith(p)) || exact.includes(spec);

const BUILTIN = isBuiltinUnder(BUILTIN_EXACT);

/** The shipped execution path: what actually runs at a destination with no node_modules. */
const onShippedExecutionPath = (file: string): boolean =>
  /\/(scripts|shared)\//.test(file) && !/\.test\.tsx?$/.test(file);

describe("R6 ward 1b — the shipped execution path carries no dependencies", () => {
  const files = trackedSources(PLUGIN_ROOT).filter(onShippedExecutionPath);

  test("the sweep actually ran (zero-guard)", () => {
    expect(files.length).toBeGreaterThan(20);
    const bare = files.flatMap((f) =>
      scanSpecifiers(readFileSync(join(REPO_ROOT, f), "utf8")).filter(
        (r) => r.kind !== "dynamic" && !isRelative(r.spec),
      ),
    );
    // A population with no bare specifiers at all would make the next cell pass
    // for the wrong reason. There are 113 today across 40 files, every one of them a builtin.
    expect(bare.length).toBeGreaterThan(50);
  });

  /** Ward 1b evaluated under a SUPPLIED exemption, so the cell below can run it
   *  with and without `bun` and assert that the difference is the exemption. */
  function violationsUnder(isBuiltin: (spec: string) => boolean): string[] {
    const out: string[] = [];
    for (const file of files) {
      for (const ref of scanSpecifiers(readFileSync(join(REPO_ROOT, file), "utf8"))) {
        // `type` rides with `static`: 1b already governs the non-emitting
        // `import type` form — that IS the `bun` exemption's entire population —
        // so a type query must be governed on the same terms or the ward would
        // exempt by syntax what it forbids by meaning.
        if (ref.kind === "dynamic" || isRelative(ref.spec) || isBuiltin(ref.spec)) continue;
        out.push(`${file}:${ref.line} -> ${ref.spec}`);
      }
    }
    return out.sort();
  }

  test("no bare specifier outside node: / bun: / bun", () => {
    expect(violationsUnder(BUILTIN)).toEqual([]);
  });

  test("the `bun` exemption is LIVE — this cell FAILS if BUILTIN_EXACT loses it", () => {
    // ⛔ REWRITTEN AFTER cassandra CONVICTED THE FIRST VERSION VACUOUS. That one
    // counted `bun` imports and never referenced the predicate, so deleting the
    // exemption reddened the VIOLATION cell while this one — the cell whose
    // TITLE claims to guard the exemption — passed silently. It also
    // false-positived: it pushed one entry per REF while labelling them per
    // FILE, so a second legitimate `bun` import in one file turned it red
    // against correct code. Both halves are fixed here.
    //
    // This is the seams candidate this seat returned last round ("an exemption
    // must carry a cell that fails when the exemption is removed") failing on
    // its own author's implementation. The candidate survives; what it needed
    // was the clause that the cell must EVALUATE the exemption, not describe it.
    expect(violationsUnder(BUILTIN)).toEqual([]);

    // Without `bun`, the same ward reddens on FIVE files.
    // ⚠ R6 says four, and R6 is not wrong — it is COUNTING A NARROWER
    // CONSTRUCT. Its four carry `import type { ServerWebSocket } from "bun"`.
    // The fifth, glamour, writes the same dependency as a TYPE QUERY —
    // `new Set<import("bun").ServerWebSocket<unknown>>()` — which R6's
    // statement-shaped measurement could not see and which this ward now
    // governs on the same terms. Re-derived here, never quoted: the number the
    // ruling carries and the number this cell asserts came from two different
    // frames, and this is the wider one.
    const withoutBun = violationsUnder(isBuiltinUnder([]));
    expect([...new Set(withoutBun.map((v) => v.split(":")[0]))].sort()).toEqual([
      "plugins/spellbook/skills/astrolabe/scripts/server.ts",
      "plugins/spellbook/skills/bounty/scripts/server.ts",
      "plugins/spellbook/skills/glamour/scripts/server.ts",
      "plugins/spellbook/skills/imago/scripts/server.ts",
      "plugins/spellbook/skills/magpie/scripts/server.ts",
    ]);
  });
});

// ── WARD 2 ──────────────────────────────────────────────────────────────────

// ⛔ Overridable so the zero-guard can be calibrated against a fixture, AND THE
// HOOK ACCEPTS AN ABSOLUTE PATH — which is not a detail. The first version of
// this ward resolved the hook with `join(REPO_ROOT, KIT_DIR)`; node's `join`
// does NOT reset on an absolute second argument, so `KIT_DIR=/tmp/fixture`
// became `<repo>/tmp/fixture`, which does not exist, so the ward reported
// ABSENT and both calibration mutations PASSED GREEN. A dead calibration hook
// and an uncalibrated check are the same fact — recorded verbatim in
// `gate-blind-set.ts`'s header about its own `SKILLS_DIR`, one directory away,
// and reproduced here by the author who had just read it. `resolve` is the fix;
// running the mutation is what found it.
const KIT_DIR = process.env.KIT_DIR ?? "src/kit";
const KIT_ABS = resolve(REPO_ROOT, KIT_DIR);

/**
 * `null` means THE KIT DOES NOT EXIST — not an empty set. That distinction is
 * this repo's own rule (`null` not `0`) and it is the entire zero-guard: a walk
 * that returns `[]` for "absent" is indistinguishable from a walk that returns
 * `[]` for "present and broken", and the second is what silently passes through
 * Phases 0–3 and is then trusted in Phase 4.
 */
function kitSources(kitAbs: string): string[] | null {
  if (!existsSync(kitAbs) || !statSync(kitAbs).isDirectory()) return null;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        if (e === "node_modules" || e === "dist") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
  };
  walk(kitAbs);
  return out.sort();
}

/**
 * Ward 2 works in ABSOLUTE paths, unlike 1a/1b. It has to: its boundary is
 * overridable to anywhere on disk for calibration, so a repo-relative
 * comparison would be comparing two different coordinate systems — and it would
 * do so SILENTLY, reporting no escapes because nothing matched either way.
 */
function kitEscapes(kitAbs: string, files: string[], kinds: ImportKind[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    for (const ref of scanSpecifiers(readFileSync(file, "utf8"))) {
      if (!kinds.includes(ref.kind) || !isRelative(ref.spec)) continue;
      const target = resolve(dirname(file), ref.spec);
      if (target === kitAbs || target.startsWith(`${kitAbs}/`)) continue;
      out.push(`${relative(kitAbs, file)}:${ref.line} -> ${ref.spec}`);
    }
  }
  return out.sort();
}

describe("R6 ward 2 — the kit is a leaf (the one-way street)", () => {
  const sources = kitSources(KIT_ABS);

  test("ZERO-GUARD — an ABSENT kit and an EMPTY one are reported differently", () => {
    if (sources === null) {
      // Impossible to not notice, on `gate-honesty`'s model. A ward that is
      // green because its subject does not exist must SAY it is green because
      // its subject does not exist.
      console.warn(
        [
          "",
          `  R6 WARD 2 — \`${KIT_DIR}\` DOES NOT EXIST. This ward is green because it examined NOTHING.`,
          "  That is expected until Sprint 02 creates the kit, and it is not evidence about anything.",
          "  The cell below is vacuous by construction; only this guard is meaningful today.",
          "",
        ].join("\n"),
      );
      expect(sources).toBeNull();
      return;
    }
    // The kit exists. Then it must have been WALKED — a present-but-empty
    // population is a broken walk or a phantom directory, and either way the
    // violation cell below would pass for a reason unrelated to the invariant.
    expect(sources.length).toBeGreaterThan(0);
  });

  test("no relative import leaves the kit", () => {
    // Bare specifiers (react, lucide-react) are unaffected — the kit is allowed
    // dependencies; it is not allowed to know about an APP. Kit modules
    // importing each other is the point.
    expect(kitEscapes(KIT_ABS, sources ?? [], ["static", "type"])).toEqual([]);
    expect(kitEscapes(KIT_ABS, sources ?? [], ["dynamic"])).toEqual([]);
  });
});

// ── CROSS-CHECK ─────────────────────────────────────────────────────────────
// ⛔ THE ENUMERATOR AUDITED BY A FRAME IT DID NOT CHOOSE.
// `lib/import-graph.ts` is a TEXT scan, because `Bun.Transpiler` erases
// `import type` and would kill the `bun` exemption above. The text scan's own
// failure mode is the mirror image: it can MISS an import by mis-tracking a
// string, a template literal or a regex, and a ward that misses imports is
// green for the worst possible reason.
//
// So the transpiler — which cannot be the enumerator — is used as the auditor.
// Over the whole real population, every VALUE import it finds must also be
// found by the scanner. It says nothing about type-only imports (it cannot see
// them); it says everything about whether the scanner desynced.
//
// ⛔ IT IS ONE-DIRECTIONAL, AND THAT IS NOT AN OVERSIGHT. Only "the transpiler
// saw it, the scanner did not" is a failure. The reverse is the NORMAL state —
// the scanner is meant to see the ~50 type-only imports the transpiler erases —
// so a two-way comparison would be red on arrival and would have to be
// suppressed back into this one. The blind spot that leaves is a FALSE POSITIVE
// in the scanner (a phantom specifier), which surfaces as a ward going red
// against correct code and gets found immediately.
describe("the import scanner agrees with Bun's parser on every value import in the tree", () => {
  test("no specifier the transpiler sees is missing from the text scan — compared by COUNT", () => {
    // ⛔ COUNTS, NOT SETS, AND THE SET VERSION WAS MASKED. The first version of
    // this cell compared per-file SETS of specifier strings. Every re-exported
    // specifier in this tree is ALSO imported normally in the same file
    // (imago 3x, magpie 2x/3x, astrolabe 2x, backend 2x), so the set was
    // identical whether or not `export … from` was handled at all — and
    // breaking that handling left this cell green while ward 1a MISSED a real
    // relative escape written as `export type {} from "<outside>"`.
    // A multiset closes it: drop the re-export and the count for that specifier
    // falls below the transpiler's.
    const transpiler = new Bun.Transpiler({ loader: "tsx" });
    const short: string[] = [];
    let audited = 0;
    for (const file of [...trackedSources(PLUGIN_ROOT), ...trackedSources("src")]) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      const mine = new Map<string, number>();
      for (const r of scanSpecifiers(source)) mine.set(r.spec, (mine.get(r.spec) ?? 0) + 1);
      const theirs = new Map<string, number>();
      for (const imp of transpiler.scan(source).imports) {
        theirs.set(imp.path, (theirs.get(imp.path) ?? 0) + 1);
        audited++;
      }
      for (const [spec, n] of theirs) {
        const got = mine.get(spec) ?? 0;
        // `>=`, never `===`: the scanner is MEANT to see more than the parser —
        // it holds the type-only imports the transpiler erases. Only coming up
        // SHORT is a defect. A two-way comparison would be red on arrival and
        // would get suppressed back into this one.
        if (got < n) short.push(`${file} -> ${spec} (parser ${n}, scanner ${got})`);
      }
    }
    // Zero-guard on the auditor itself: a transpiler that threw or returned
    // nothing would report zero missing and read as perfect agreement.
    expect(audited).toBeGreaterThan(500);
    expect(short).toEqual([]);
  });

  test("RE-EXPORTS are in the population and are actually scanned — the masked construct, named", () => {
    // ⛔ The count cell above is INDIRECT: it catches a dropped re-export only
    // because the count falls. This one is DIRECT, and it exists because the
    // header of this file once told the next author that re-exports did not
    // occur in this tree. THEY OCCUR SEVEN TIMES. A cell naming them is what
    // stops that claim being made again from memory.
    const found: string[] = [];
    for (const file of trackedSources(PLUGIN_ROOT)) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const ref of scanSpecifiers(source)) {
        if (ref.kind !== "static") continue;
        // A re-export is a static ref whose line opens with `export`.
        // Keyed on the line the scanner REPORTS, which for a re-export is the
        // `export` keyword — `magpie/scripts/backend.ts:20` opens a five-line
        // statement whose `from` sits on line 25. Do not additionally require
        // `from` on that line; that is what made this cell's first draft miss it.
        if (/^\s*export\b/.test(source.split("\n")[ref.line - 1] ?? "")) {
          found.push(`${file.replace("plugins/spellbook/skills/", "")}:${ref.line}`);
        }
      }
    }
    expect(found.sort()).toEqual([
      "astrolabe/scripts/server.ts:75",
      "imago/scripts/server.ts:1647",
      "imago/scripts/server.ts:1648",
      "magpie/scripts/backend.ts:20",
      "magpie/scripts/server.ts:874",
      "magpie/scripts/server.ts:875",
      "magpie/scripts/server.ts:876",
    ]);
  });

  test("TYPE QUERIES are classified `type`, not `dynamic` — the exemption, with a cell that fails without it", () => {
    // ⛔ Removing the type-query rule from `isTypePosition` reclassifies these as
    // `dynamic`, which puts them in ward 1a's PINNED INVENTORY — an inventory of
    // runtime escapes, which a type query is not. This cell fails first and says
    // why, instead of the pin failing and reading as an undeclared escape.
    //
    // ⚠ These two are BARE (`bun`, `bun:sqlite`), so neither is a relative
    // escape today and ward 1a would not have seen them either way. That is
    // exactly why a cell is needed: the construct is live and the consequence is
    // not, and Contract 4 relocating surfaces to `src/` is the direction that
    // makes one relative.
    const at = (file: string, line: number) =>
      scanSpecifiers(readFileSync(join(REPO_ROOT, file), "utf8")).find((r) => r.line === line)
        ?.kind;
    expect(at("plugins/spellbook/skills/glamour/scripts/server.ts", 77)).toBe("type");
    expect(at("plugins/spellbook/skills/mind-mapper/scripts/propose.test.ts", 463)).toBe("type");

    // And a synthetic RELATIVE type query must still be an ESCAPE, not an
    // exemption. This is the half a literal "exempt type queries" ruling would
    // have lost: the two lines below are the same dependency written twice, and
    // a ward that catches one and not the other has a one-line bypass.
    const query = scanSpecifiers(`export type T = import("../../outside").X;`)[0];
    const stmt = scanSpecifiers(`import type { X } from "../../outside";`)[0];
    expect(query.kind).toBe("type");
    expect(stmt.kind).toBe("static");
    // Both kinds are checked by ward 1a's escape cell — see `relativeEscapes`.
    expect(["static", "type"]).toContain(query.kind);
    expect(["static", "type"]).toContain(stmt.kind);
  });
});
