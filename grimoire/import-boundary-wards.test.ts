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
// ⛔ DYNAMIC ESCAPES ARE EXEMPT BUT PINNED — NOT ALLOWLISTED. There are two
// (mind-mapper, astrolabe) and both are the same thing: Contract 1's dev-only
// mode resolution. A release daemon must never pull the surface build graph
// into its load path, so that import is dynamic ON PURPOSE. A ward phrased over all imports would be red against correct code.
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
//   1b TYPE POSITIONS  ⛔ THE R8 MUTATION. In a NON-test file under `scripts/`,
//                      write the bare dependency in a position the type
//                      heuristic does NOT recognise, so `kind` comes back
//                      `dynamic`. Any of these, all verified to reach the ward:
//                        let a: Record<string, import("sharp").S>;
//                        const b: typeof import("sharp") = 0 as never;
//                      Before the fix each of these passed 11/0 — 1b skipped
//                      `dynamic` and so its coverage rode on the heuristic.
//                      It now ignores `kind` entirely, so no position can hide.
//   heuristic drift    Delete a rule from `isTypePosition`. The audit cell
//                      reddens by DISAGREEING WITH THE PARSER, naming the file.
//   dedupe key         Change the scanner's `seen` key from the byte offset back
//                      to `line`. ⚠ The real corpus CANNOT show this — zero refs
//                      collapse there — so the dedupe cell carries its own
//                      synthetic two-statements-on-one-line population, and that
//                      is what reddens.
//   count slack        Mutate the scanner to drop ONE occurrence of a specifier
//                      that also appears as a type-only import in the same file
//                      (e.g. imago/scripts/server.ts:37). Under the old `>=`
//                      this was silent; the comparison is now exact equality on
//                      the value population and it reddens.
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
import { builtinModules } from "node:module";
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
 * ⛔ CANON RULING (thoth, 2026-08-31) — A LINE NUMBER IS CONTEXT, NOT ASSERTION.
 *
 * **A pinned site's IDENTITY is `(file, spec, resolved)`. The line is REPORTED
 * and never COMPARED.**
 *
 * The evidence, all inside one sprint: `astrolabe:75 -> :70`,
 * `imago:1647 -> :1723`, and the re-export fixture twice — four false reds, every
 * one from a cell that had no opinion about the change that moved it. circe hit a
 * fifth variant from the opposite direction: biome reflowed an import past its
 * 100-char `lineWidth` and moved a pre-existing error four lines. Insertions
 * above a site are the single most common edit in a growing file, so a
 * line-keyed pin has a false-red rate proportional to unrelated activity.
 *
 * **And it buys nothing, which is what settles it.** The thing a line COULD tell
 * you — "this site moved somewhere semantically different" — is not something a
 * line number can distinguish from "someone added an import above it." It has no
 * discriminating power for the only question that would justify the cost.
 *
 * ⚠ THE ONE THING THE LINE WAS DOING, AND HOW IT IS REPLACED. A line made two
 * otherwise-identical sites in one file distinguishable.
 * `exit-site-inventory.test.ts:130` records exactly this problem going the other
 * way — its `:673` and `:860` are byte-identical, the `(file, text)` key cannot
 * tell them apart, and a comment is the only thing that does. So dropping the
 * line REINTRODUCES that collision risk, and it is closed explicitly: every cell
 * below asserts its identities are UNIQUE before comparing them, so two sites
 * can never silently collapse into one and hide an addition.
 */
type EscapeIdentity = { file: string; spec: string; resolved: string };
const identityOf = ({ file, spec, resolved }: Escape): EscapeIdentity => ({
  file,
  spec,
  resolved,
});
const keyOf = (e: EscapeIdentity): string => `${e.file}\t${e.spec}\t${e.resolved}`;

/**
 * Every relative specifier in `files`, of the given KINDS, resolving outside
 * `boundary`.
 *
 * ⛔ WARD 1a CHECKS `static` + `type` FOR ESCAPES AND `dynamic` AGAINST THE PIN.
 * Every ref THE SCANNER EMITS lands in exactly one of the two cells, so no
 * classification mistake can make an emitted escape invisible — it can only put
 * it in the wrong cell.
 *
 * ⚠ THAT IS A CLAIM ABOUT CLASSIFICATION, NEVER ABOUT COVERAGE, and an earlier
 * wording of it ("every relative specifier lands in exactly one of the two
 * cells") overreached into the second. A partition argument is only ever as
 * wide as its classifier's input. FOUR CONSTRUCTS EMIT NO REF AT ALL and are
 * therefore in NEITHER cell:
 *     import(`./x`)          template-literal specifier
 *     require(`./x`)         ditto
 *     import("./x" + s)      concatenated specifier
 *     require(("./x"))       a LITERAL argument that is merely PARENTHESISED
 * The first three are documented as scanner blind spots in `import-graph.ts`.
 * ⛔ THE FOURTH WAS DOCUMENTED NOWHERE until cassandra found it — and it is the
 * one that matters most, because the other three are visibly not-a-literal
 * while this one looks exactly like a construct the scanner handles.
 *
 * Before trusting a partition argument, ask what the classifier never sees.
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

// ⛔ THE PINNED DYNAMIC-ESCAPE INVENTORY. FOUR entries, the same site in four
// spells. Read the site before you add a fifth — the question is never "is it
// dynamic?" but "does it run at the DESTINATION?", and static-vs-dynamic is
// only the mechanical stand-in for that.
//
// All four are one spell's server.ts reaching `src/` for its DEV-mode
// HTMLBundle. The reasoning that admits them is identical and it is about the
// DESTINATION, not the syntax: release mode is chosen by `dist/index.html`, the
// published artifact always has one, so the line never executes where it
// cannot resolve. Verified INDEPENDENTLY for astrolabe and for imago
// (2026-08-31), each by booting a copied tree with a dist/ and NO surface/ —
// see their release-serve gates (astrolabe/scripts/, imago/tests/), whose
// override cells show the other direction too: forced into dev mode, those same
// trees die at exactly this import. Neither was admitted on mind-mapper's
// say-so.
//
// ⚠ MAGPIE (2026-08-31, Phase 6) IS THE ONE ENTRY WHERE `dist/` PRESENCE WOULD
// HAVE BEEN THE WRONG DISCRIMINATOR, AND IT IS WHY THE SENTENCE ABOVE NOW SAYS
// `dist/index.html`. magpie has shipped a `dist/` since Slice 2 holding only
// `cli.js` — so "the published artifact always has a dist/" was already true of
// magpie while its daemon correctly resolved to DEV. Its admission was verified
// the same way as the other two: a copy of the tracked subtree with no
// node_modules up-tree and no surface/, daemon reporting mode "release" on both
// transports, the board driven in a browser and rendering styled.
//
// ⚠ THE `line` FIELD IS PART OF THE PINNED VALUE AND IT HAS NOW COST THREE
// FALSE REDS IN ONE SPRINT — astrolabe :75→:70, imago :1647→:1723, and the
// re-export fixture below twice — every one of them an edit ABOVE the site with
// no opinion about the escape. The cell earns its keep on the
// file/spec/resolved triple; `line` is a reader's pointer riding inside an
// assertion, which is why it fires. Re-pin it and move on. A structural fix
// (compare the triple, report the line) is proposed and NOT applied here — it
// changes what this ward asserts, and that is the canon seat's call.
const PINNED_DYNAMIC_ESCAPES: EscapeIdentity[] = [
  {
    file: "plugins/spellbook/skills/astrolabe/scripts/server.ts",
    spec: "../../../../../src/astrolabe/surface/index.html",
    resolved: "src/astrolabe/surface/index.html",
  },
  {
    file: "plugins/spellbook/skills/imago/scripts/server.ts",
    spec: "../../../../../src/imago/surface/index.html",
    resolved: "src/imago/surface/index.html",
  },
  {
    file: "plugins/spellbook/skills/magpie/scripts/server.ts",
    spec: "../../../../../src/magpie/surface/index.html",
    resolved: "src/magpie/surface/index.html",
  },
  {
    file: "plugins/spellbook/skills/mind-mapper/scripts/server.ts",
    spec: "../../../../../src/mind-mapper/surface/index.html",
    resolved: "src/mind-mapper/surface/index.html",
  },
];

describe("R6 ward 1a — the published artifact resolves no relative path outside itself", () => {
  const files = trackedSources(PLUGIN_ROOT);

  test("the sweep actually ran (zero-guard: a dead walk and a clean walk look identical)", () => {
    // ⛔ THIS GUARD NO LONGER COUNTS ANYTHING, AND THAT IS THE POINT.
    //
    // It was a floor on file count, and it had already decayed twice: calibrated
    // at 206 when every spell's surface still lived under `plugins/spellbook/`,
    // it tripped at 149 against a floor of 150 after astrolabe and imago
    // relocated — by ONE, which reads as noise and was structure. Recalibrating
    // 150 -> 80 bought time and nothing else: full relocation lands this
    // population near 101, and the sibling floor (specifiers > 500) sits at 670
    // heading for 541. Both were clocks. THIS PROJECT EXISTS TO SHRINK THIS
    // POPULATION, so any magnitude asserted over it is measuring the work.
    //
    // ⭐ A GUARD'S DENOMINATOR MUST BE SOMETHING THE PROJECT IS NOT CHANGING.
    // The defect a zero-guard actually catches is a walk that enumerated the
    // WRONG WORLD — a dead glob, a steered `SPELLBOOK_REPO_ROOT`, a `git` that
    // returned nothing. A magnitude cannot tell that from shrinking-by-design;
    // MEMBERSHIP can. `gate-honesty.test.ts` already solved this by asserting
    // `r.roots` — WHICH WORLD, not how big — and this is that same guard ported
    // to a population that has no roots field to assert.
    //
    // What cannot shrink: Contract 4 relocates `surface/` and NOTHING ELSE, and
    // Contract 3 keeps every backend shipping as source in the deployed folder.
    // So every spell on the roster contributes `scripts/*.ts` to this population
    // for as long as it exists — and a spell that is retired leaves BOTH sides
    // of the comparison at once, which is why this cannot decay the way a count
    // does.
    const spellOf = (f: string) => /skills\/([^/]+)\//.exec(f)?.[1];

    // The roster, DERIVED from the same tree — never a hand-written list, which
    // would be a second denominator free to drift from the first.
    const roster = [
      ...new Set(
        execFileSync("git", ["-C", REPO_ROOT, "ls-files", "plugins/spellbook/skills"], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .filter((f) => /\/scripts\/[^/]+\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
          .map(spellOf)
          .filter((x): x is string => Boolean(x)),
      ),
    ].sort();

    // The only magnitude left, and it has no clock: a roster of zero means git
    // returned nothing at all.
    expect(roster.length).toBeGreaterThan(0);

    // Every spell reached the ward's population. A dead walk fails this with the
    // whole roster named; relocation cannot, because relocation does not move
    // `scripts/`.
    const enumerated = new Set(files.map(spellOf));
    expect(roster.filter((spell) => !enumerated.has(spell))).toEqual([]);

    // And the SCANNER ran over every spell, not merely the enumerator. This
    // replaces the `specifiers > 500` floor with the same membership shape.
    const scanned = new Set(
      files
        .filter((f) => scanSpecifiers(readFileSync(join(REPO_ROOT, f), "utf8")).length > 0)
        .map(spellOf),
    );
    expect(roster.filter((spell) => !scanned.has(spell))).toEqual([]);
  });

  test("no LOAD-TIME relative import escapes plugins/spellbook/ (statements + type queries)", () => {
    // `type` rides with `static` deliberately. `export type T = import("../out").X`
    // and `import type { X } from "../out"` are the SAME dependency written two
    // ways — same file, same tsc breakage, same nothing at runtime. Covering one
    // and exempting the other would leave a one-line bypass of this entire ward.
    expect(relativeEscapes(files, PLUGIN_ROOT, ["static", "type"])).toEqual([]);
  });

  test("the DYNAMIC escapes are exactly the pinned inventory — a new one fails until re-declared", () => {
    // `dynamic` ONLY. A type query is not deferred to a call and has no business
    // in an inventory of runtime escapes — it is checked by the cell above.
    const found = relativeEscapes(files, PLUGIN_ROOT, ["dynamic"]);

    // The line is CONTEXT — printed so a human can navigate straight to the
    // site, never compared. See the ruling beside `EscapeIdentity`.
    console.warn(
      `\n  R6 WARD 1a — pinned dynamic escapes, as found today:\n${found
        .map((e) => `    ${e.file}:${e.line}  ->  ${e.spec}`)
        .join("\n")}\n`,
    );

    // ⛔ UNIQUENESS BEFORE COMPARISON. Dropping the line means two escapes with
    // the same (file, spec, resolved) would collapse into one entry, and a
    // SECOND escape could then hide behind the first while this cell stayed
    // green. That is the `exit-site-inventory:130` collision, and this is the
    // clause that closes it rather than documenting it.
    const keys = found.map((e) => keyOf(identityOf(e)));
    expect(new Set(keys).size).toBe(keys.length);

    // Compared whole, both directions, so the failure names WHICH site and
    // WHICH direction. A count cannot distinguish a new escape from a moved one.
    expect(found.map(identityOf)).toEqual(PINNED_DYNAMIC_ESCAPES);
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

/**
 * ⛔ THE EMITTED-FILE EXEMPTION (P2) — WHY IT EXISTS, AND WHY IT IS SCOPED.
 *
 * **Bun's bundler STRIPS the `node:` prefix.** MEASURED 2026-08-31, twice
 * independently (prospero, and again here):
 *
 *     import { join } from "node:path"   --bundle-->   from "path"
 *     node:fs -> "fs" · node:child_process -> "child_process"
 *
 * So the moment a backend ships BUILT (Option 3), its shipped `scripts/` carry
 * bare `path` / `fs` / `child_process`, and this ward's `node:`/`bun:` predicate
 * reads every one as a shipped dependency. **REPRODUCED against a real bundled
 * tree via `SPELLBOOK_REPO_ROOT`: 17 violations — 6 astrolabe, 11 magpie.** It is
 * a PREDICATE MISMATCH, not a runtime defect; Bun resolves a bare builtin fine.
 *
 * ⚠ **daedalus's hazard, and it is the whole design.** Widening the predicate
 * globally would weaken this ward for HAND-AUTHORED files — where a bare `path`
 * is a genuine finding, because nothing stripped it. So the exemption is scoped
 * to files THE BUILD EMITS, and nowhere else.
 *
 * ⛔ **AND IT IS AN EXEMPTION TO A NAMED BUILTIN SET, NOT TO "ANY BARE
 * SPECIFIER IN AN EMITTED FILE."** That distinction is load-bearing: an emitted
 * artifact that still reaches for a REAL dependency (a `sharp` the bundler failed
 * to inline) is the exact failure this ward exists to catch, and it is at its
 * most dangerous in precisely the file class the exemption covers. Exempting the
 * file wholesale would blind the ward where it matters most.
 *
 * ⛔ **THE ROOT LIST IS DECLARED AND CURRENTLY EMPTY, ON PURPOSE.** The emission
 * ruling has not landed, so nothing is emitted yet and this exemption applies to
 * nothing. It is NOT hardcoded to `dist/`: the emission's output location is
 * daedalus's unmade call, and a guard's denominator must not be a value the
 * project is about to change (the same ruling that took ward 1a's floor out).
 * When the emission lands, ONE line here turns the exemption on for exactly the
 * root it names.
 */
const DECLARED_EMITTED_ROOTS: string[] = [
  "plugins/spellbook/skills/astrolabe/dist",
  "plugins/spellbook/skills/magpie/dist",
];

/** Env override for calibration. `filter(Boolean)` closes the `"".split(",")`
 *  → `[""]` trap — an empty var would otherwise declare a root matching every
 *  file, which is the widest possible exemption arriving by accident. */
const EMITTED_ROOTS: string[] = process.env.WARD_EMITTED_ROOTS
  ? process.env.WARD_EMITTED_ROOTS.split(",")
      .map((r) => r.trim())
      .filter(Boolean)
  : DECLARED_EMITTED_ROOTS;

/** Node/Bun builtins, DERIVED from the runtime rather than hand-listed — a
 *  hand-kept copy of this set is exactly the drift `gate-blind-set` records
 *  having shipped once. These are the bare names a bundler leaves behind. */
const BARE_BUILTINS = new Set(builtinModules);

/**
 * The ward's predicate, as a FACTORY over its two exemptions, so a cell can
 * evaluate it with each one removed and assert the difference. An exemption
 * whose effect a cell cannot evaluate is one the next author deletes.
 */
const makeIsBuiltin =
  (exact: readonly string[], emittedRoots: readonly string[]) =>
  (spec: string, file: string): boolean => {
    if (BUILTIN_PREFIXES.some((p) => spec.startsWith(p)) || exact.includes(spec)) return true;
    const emitted = emittedRoots.some((r) => file.startsWith(r.endsWith("/") ? r : `${r}/`));
    return emitted && BARE_BUILTINS.has(spec);
  };

const BUILTIN = makeIsBuiltin(BUILTIN_EXACT, EMITTED_ROOTS);

/** The hand-authored shipped execution path. */
const onShippedExecutionPath = (file: string): boolean =>
  /\/(scripts|shared)\//.test(file) && !/\.test\.tsx?$/.test(file);

/**
 * ⛔ THE POPULATION FOLLOWS THE EXECUTION PATH TO WHEREVER THE EMISSION PUTS IT,
 * AND THIS IS THE HALF NOBODY ASKED FOR.
 *
 * The card framed P2 as "widen the builtin predicate." That is necessary and it
 * is NOT the dangerous half. Contract 4's amendment rules the emitted bundle to
 * `plugins/spellbook/skills/<spell>/dist/cli.js`, and **ward 1b would not see it
 * at all** — MEASURED: that path fails BOTH of 1b's filters, the `.ts`/`.tsx`
 * extension filter and the `scripts|shared` path filter.
 *
 * So on the day the backend ships built, the code that actually executes at a
 * deps-free destination leaves this ward's population entirely, and the ward
 * goes green because it stopped looking — while its title still claims to
 * govern "the shipped execution path". **A shrunk population is not a red cell**
 * (Contract 4's amendment says exactly this about `walkSpellSources`), and this
 * is the same failure one ward over.
 *
 * The predicate widening alone would have shipped that. Both halves are here:
 * the population extends into the declared emitted roots, AND the bare-builtin
 * exemption applies there.
 */
function emittedSources(roots: readonly string[]): string[] {
  if (roots.length === 0) return [];
  return roots.flatMap((root) =>
    execFileSync("git", ["-C", REPO_ROOT, "ls-files", root], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((f) => /\.(js|mjs|cjs|ts|tsx)$/.test(f)),
  );
}

describe("R6 ward 1b — the shipped execution path carries no dependencies", () => {
  const files = [
    ...trackedSources(PLUGIN_ROOT).filter(onShippedExecutionPath),
    ...emittedSources(EMITTED_ROOTS),
  ];

  test("the sweep actually ran (zero-guard)", () => {
    expect(files.length).toBeGreaterThan(20);
    const bare = files.flatMap((f) =>
      scanSpecifiers(readFileSync(join(REPO_ROOT, f), "utf8")).filter((r) => !isRelative(r.spec)),
    );
    // A population with no bare specifiers at all would make the next cell pass
    // for the wrong reason. There are 113 today across 40 files, every one of them a builtin.
    expect(bare.length).toBeGreaterThan(50);
  });

  /** Ward 1b evaluated under a SUPPLIED exemption, so the cell below can run it
   *  with and without `bun` and assert that the difference is the exemption. */
  function violationsUnder(isBuiltin: (spec: string, file: string) => boolean): string[] {
    const out: string[] = [];
    for (const file of files) {
      for (const ref of scanSpecifiers(readFileSync(join(REPO_ROOT, file), "utf8"))) {
        // ⛔ 1b DOES NOT CONSULT `kind`, AND THAT IS THE FIX FOR R8.
        // It used to skip `dynamic`, which made its coverage depend on a
        // POSITION HEURISTIC — so every type position the heuristic missed
        // (`Record<string, import("x").T>`, `typeof import("x")`, …) was a
        // bare dependency on the shipped execution path that this ward could
        // not see. cassandra planted one and the suite passed 11/0.
        //
        // Patching the heuristic would have been whack-a-mole against a class
        // nobody can enumerate. Dropping the filter removes the dependency
        // instead: whatever `kind` says, 1b sees the specifier.
        //
        // ⚠ THIS IS WIDER THAN R6's LETTER, WHICH SAYS "statically imports",
        // AND IT IS FAITHFUL TO R6's PURPOSE. A runtime `await import("sharp")`
        // in `scripts/` breaks a deps-free destination just as hard as a static
        // one — arguably harder, since it fails at request time rather than at
        // boot. MEASURED BEFORE ADOPTING IT: the widening adds exactly ONE ref
        // to the population, `magpie/scripts/discover.ts:262 -> node:util`,
        // which is a builtin and therefore exempt. Zero new violations.
        if (isRelative(ref.spec) || isBuiltin(ref.spec, file)) continue;
        out.push(`${file}:${ref.line} -> ${ref.spec}`);
      }
    }
    return out.sort();
  }

  test("no bare specifier outside node: / bun: / bun", () => {
    expect(violationsUnder(BUILTIN)).toEqual([]);
  });

  test("ZERO-GUARD — the emitted-root list is DECLARED EMPTY, and says so rather than passing quietly", () => {
    // ⛔ ward 2's discipline, applied to an exemption instead of a population.
    // An exemption that currently covers NOTHING is green for a reason that has
    // nothing to do with the invariant, and this seat has now been bitten twice
    // by a cell trusted later because its vacuity was silent at the time.
    if (EMITTED_ROOTS.length === 0) {
      console.warn(
        [
          "",
          "  R6 WARD 1b — the EMITTED-FILE exemption covers NOTHING: no emitted roots are declared.",
          "  Expected until the emission ruling lands (Slice 2, Option 3). Until then this ward's",
          "  predicate is exactly `node:` / `bun:` / `bun`, and the exemption below is inert.",
          "  The cell after this one is what proves the mechanism works, on a SYNTHETIC root.",
          "",
        ].join("\n"),
      );
      expect(DECLARED_EMITTED_ROOTS).toEqual([]);
      return;
    }
    // A root is declared. Then it must actually match something, or it is a
    // typo that reads as a working exemption.
    // ⛔ Checked with `emittedSources` — THE SAME ENUMERATOR THE POPULATION USES.
    // A first draft checked against `trackedSources`, which is `.ts`/`.tsx` only,
    // so a root holding exactly what this exemption exists for (a `.js` bundle)
    // reported as an empty typo. A guard that does not share its subject's
    // enumerator is measuring a different set.
    for (const root of EMITTED_ROOTS) {
      expect(emittedSources([root]).length).toBeGreaterThan(0);
    }
  });

  test("the emitted exemption is SCOPED — it does not reach hand-authored files, and never covers a real dependency", () => {
    // ⛔ SYNTHETIC POPULATION, because the real one is empty by design. The
    // corpus cannot calibrate an exemption for a file class that does not exist
    // yet, and declaring the mechanism "correct but uncalibrated" is the weaker
    // option — this seat ruled that last round and mints the population instead.
    const emitted = "plugins/spellbook/skills/zzz/emitted";
    const probe = makeIsBuiltin(BUILTIN_EXACT, [emitted]);

    // 1. A stripped builtin IS exempt inside an emitted root — the bug P2 fixes.
    expect(probe("path", `${emitted}/cli.ts`)).toBe(true);
    expect(probe("child_process", `${emitted}/cli.ts`)).toBe(true);

    // 2. ⛔ THE HAZARD daedalus NAMED. The SAME specifier in a hand-authored
    // file is NOT exempt. If this ever returns true, the widening has weakened
    // the ward everywhere and the whole scoping was theatre.
    expect(probe("path", "plugins/spellbook/skills/zzz/scripts/cli.ts")).toBe(false);
    expect(probe("child_process", "plugins/spellbook/skills/zzz/scripts/cli.ts")).toBe(false);

    // 3. A REAL dependency is still caught INSIDE an emitted root. This is the
    // clause that keeps the exemption a builtin-set exemption rather than a
    // file-class blindfold — a bundled artifact still reaching for `sharp` is
    // the failure this ward exists for, at its most dangerous.
    expect(probe("sharp", `${emitted}/cli.ts`)).toBe(false);
    expect(probe("react", `${emitted}/cli.ts`)).toBe(false);

    // 4. The prefix match is on a PATH SEGMENT, not a string prefix — a sibling
    // directory whose name merely starts with the root must not inherit it.
    expect(probe("path", `${emitted}-notmine/cli.ts`)).toBe(false);
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
    const withoutBun = violationsUnder(makeIsBuiltin([], EMITTED_ROOTS));
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

// ── WARD 3 ──────────────────────────────────────────────────────────────────
//
// ⛔ NO SPELL'S BUILD INPUT MAY REACH ANOTHER SPELL.
//
// **Scheduled into Sprint 02, not 03, and daedalus's argument for the move is
// the right one:** Contract 17 records that a cross-spell reach inside `src/` is
// "absorbed into the bundle" — and **that absorption is STRONGER for a backend
// and therefore worse.** A bundled backend inlines the other spell's code
// completely: nothing left for 1a (no relative path survives), nothing for 1b
// (no bare specifier survives), nothing for 2. What ships is a spell carrying a
// silent copy of another spell — a SHIPPING ARTIFACT, not a dev-tree mistake.
// And backends are where shared logic actually wants to live, so this is the
// direction the pressure comes from.
//
// ⚠ WIDER THAN THE STATEMENT I WAS HANDED, DELIBERATELY, AND HERE IS THE
// MEASUREMENT. The card says "no file under `src/<spell>/` may relatively import
// a different `src/<other-spell>/`". That is green today — and it has a live
// bypass, because a spell can reach another spell **through `plugins/`** instead:
//
//     src/imago/surface/… -> ../../../plugins/spellbook/skills/imago/shared/types
//
// **36 instances of that route exist today** (astrolabe 4, imago 32), every one
// of them SAME-spell and correct under R1 — which is exactly what makes it
// dangerous: the route is proven, ergonomic, and one directory-name away from
// being cross-spell, and the narrow ward would not see it because the specifier
// resolves into `plugins/`, not `src/`.
//
// So the predicate is stated by **OWNER**, not by path prefix: a file owned by
// spell A may not relatively import anything owned by spell B, wherever B's file
// physically lives. MEASURED BEFORE ADOPTING IT: narrow 0, wide 0, over 170
// tracked files — the wider ward costs nothing today.
//
// ⛔ OWNERSHIP IS DERIVED, NEVER A LIST. A name is a spell iff
// `plugins/spellbook/skills/<name>/` exists. That is what correctly classifies
// `src/build.ts` — circe's shared build delegator, which three spells import as
// `../build` — as NOT a spell, so those three imports are not violations. A
// hand-written spell list would have had to remember that, and a first draft of
// this ward (written as a throwaway script) flagged all three.

/** A directory name is a SPELL iff it has a deployed skill folder. Derived. */
function spellNames(): Set<string> {
  const names = new Set<string>();
  for (const f of execFileSync("git", ["-C", REPO_ROOT, "ls-files", "plugins/spellbook/skills"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")) {
    const name = f.split("/")[3];
    if (name) names.add(name);
  }
  return names;
}

/** Which spell owns this repo-relative path — `src/<spell>/…` or the deployed
 *  `plugins/spellbook/skills/<spell>/…`. `null` for anything spell-agnostic
 *  (`src/build.ts`, a future `src/kit/`, repo tooling). */
function ownerSpell(path: string, spells: Set<string>): string | null {
  const seg = path.split("/");
  if (seg[0] === "src" && seg[1] && spells.has(seg[1])) return seg[1];
  if (path.startsWith("plugins/spellbook/skills/") && seg[3] && spells.has(seg[3])) return seg[3];
  return null;
}

describe("R6 ward 3 — a spell's build input may not reach another spell", () => {
  const spells = spellNames();
  const files = trackedSources("src").filter((f) => ownerSpell(f, spells) !== null);

  test("ZERO-GUARD — the population was walked, and cross-spell is structurally POSSIBLE", () => {
    // ⛔ Ward 2's discipline, and this ward needs BOTH halves of it. A ward over
    // `src/` could be green because nothing was walked, OR because only one
    // spell lives there — and with one spell, "cross-spell" cannot be expressed
    // at all, so a pass is a statement about the tree's shape, not about
    // anyone's discipline. Both must be said out loud, not inferred from green.
    const owners = [...new Set(files.map((f) => ownerSpell(f, spells)))].sort();
    console.warn(
      `\n  R6 WARD 3 — ${files.length} build-input files across ${owners.length} spell(s): ${owners.join(", ")}\n`,
    );
    expect(spells.size).toBeGreaterThan(0);
    // Every spell WITH build input under src/ contributed files — membership,
    // not a magnitude, because this project's whole job is moving files INTO
    // `src/` and any floor here would decay on that schedule.
    for (const owner of owners)
      expect(files.some((f) => ownerSpell(f, spells) === owner)).toBe(true);
    // The one that makes a green meaningful rather than structural.
    expect(owners.length).toBeGreaterThan(1);
  });

  test("no relative import crosses from one spell to another", () => {
    const violations: string[] = [];
    for (const file of files) {
      const owner = ownerSpell(file, spells);
      for (const ref of scanSpecifiers(readFileSync(join(REPO_ROOT, file), "utf8"))) {
        if (!isRelative(ref.spec)) continue;
        const target = ownerSpell(resolveFrom(file, ref.spec), spells);
        if (target === null || target === owner) continue;
        violations.push(`${file}:${ref.line} -> ${ref.spec} (${owner} reaches ${target})`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the OWNER rule classifies the spell-agnostic files correctly — `src/build.ts` is not a spell", () => {
    // ⛔ A SYNTHETIC-ADJACENT CELL over the real discriminator, because getting
    // this wrong is red-on-arrival against three correct imports and the first
    // draft did exactly that.
    expect(ownerSpell("src/build.ts", spells)).toBeNull();
    expect(ownerSpell("src/kit/theme/tokens.ts", spells)).toBeNull();
    expect(ownerSpell("src/imago/surface/App.tsx", spells)).toBe("imago");
    expect(ownerSpell("plugins/spellbook/skills/magpie/shared/types.ts", spells)).toBe("magpie");
    // And the reach the WIDE predicate exists for: same-spell through plugins/
    // is legal, cross-spell through plugins/ is not.
    expect(ownerSpell("plugins/spellbook/skills/imago/shared/types", spells)).toBe("imago");
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
      // Both sides are the VALUE-STATEMENT population and nothing else:
      // non-erased `static` refs here, `import-statement` there. Dynamic refs
      // are excluded on BOTH sides — the parser cannot see `require()` at all
      // (measured: one disagreement corpus-wide, and that is its cause), and a
      // lost dynamic import is already covered exactly by ward 1a's pinned
      // inventory, which names its one entry and reddens if it disappears.
      const mine = new Map<string, number>();
      for (const r of scanSpecifiers(source)) {
        if (r.kind !== "static" || r.erased) continue;
        mine.set(r.spec, (mine.get(r.spec) ?? 0) + 1);
      }
      const theirs = new Map<string, number>();
      for (const imp of transpiler.scan(source).imports) {
        if (imp.kind !== "import-statement") continue;
        theirs.set(imp.path, (theirs.get(imp.path) ?? 0) + 1);
        audited++;
      }
      for (const [spec, n] of theirs) {
        const got = mine.get(spec) ?? 0;
        // ⛔ EXACT EQUALITY, AND THE `>=` IT REPLACED WAS A REAL HOLE.
        // `>=` was chosen because the scanner sees MORE than the parser — it
        // holds the type-only imports the parser erases. But that slack is
        // capacity for a loss to hide in: cassandra measured 16 of 980 pairs
        // carrying exactly 1 of slack, then mutated the scanner to lose one
        // occurrence per slack pair and 14 REAL VALUE IMPORTS vanished with the
        // suite at 11 pass / 0 fail — including `imago/scripts/server.ts:37`
        // and `astrolabe/scripts/server.ts:64`, both on the shipped execution
        // path. Same shape as the set-vs-count defect one layer down.
        //
        // The slack was never necessary. It existed only because a MIXED
        // population was being compared against a value-only one. `erased`
        // splits them, so both sides now count the same thing and there is no
        // slack at all: 977 pairs, 0 mismatches, measured before adopting it.
        if (got !== n) short.push(`${file} -> ${spec} (parser ${n}, scanner-value ${got})`);
      }
    }
    // Zero-guard on the auditor itself: a transpiler that threw or returned
    // nothing would report zero missing and read as perfect agreement.
    expect(audited).toBeGreaterThan(900);
    expect(short).toEqual([]);
  });

  test("the type/dynamic HEURISTIC agrees with the parser on every file — the tripwire for R8's class", () => {
    // ⛔ `isTypePosition` is a peephole heuristic and cannot be exhaustive. This
    // cell is what stops that being an UNWATCHED fact: the parser is the
    // authority on which `import()` actually emits, and any position the
    // heuristic gets wrong shows up here as a disagreement rather than as a
    // silent reclassification. It is the reason `,`-position type arguments can
    // be left unhandled rather than guessed at.
    const transpiler = new Bun.Transpiler({ loader: "tsx" });
    const disagreements: string[] = [];
    let files = 0;
    for (const file of [...trackedSources(PLUGIN_ROOT), ...trackedSources("src")]) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      const lines = source.split("\n");
      // `require()` is excluded: the parser does not report it at all, so it is
      // an asymmetry between the two instruments, never a classification error.
      const mine = scanSpecifiers(source)
        .filter((r) => r.kind === "dynamic" && !(lines[r.line - 1] ?? "").includes("require("))
        .map((r) => r.spec)
        .sort();
      const theirs = transpiler
        .scan(source)
        .imports.filter((i) => i.kind === "dynamic-import")
        .map((i) => i.path)
        .sort();
      files++;
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
        disagreements.push(
          `${file}: scanner ${JSON.stringify(mine)} vs parser ${JSON.stringify(theirs)}`,
        );
      }
    }
    expect(files).toBeGreaterThan(300);
    expect(disagreements).toEqual([]);
  });

  test("the scanner dedupes by BYTE OFFSET, not by line — calibrated on a SYNTHETIC population", () => {
    // ⛔ THIS CELL EXISTS BECAUSE THE FIX IT GUARDS IS UNCALIBRATABLE ON THE REAL
    // TREE. Reverting the dedupe key from offset to line is INVISIBLE against
    // this corpus — zero refs collapse under a line key, so the mutation passes
    // 11/0. That is this file's own recorded finding (a mutation planted in an
    // empty population proves nothing) landing on its author's own patch, and
    // the honest response is not to claim the fix was calibrated but to MINT a
    // population for it.
    //
    // Two statements, one line, one specifier. A line-keyed dedupe returns 1.
    const oneLine = scanSpecifiers(`import a from "./x"; export { b } from "./x";`);
    expect(oneLine.length).toBe(2);
    expect(oneLine.map((r) => r.spec)).toEqual(["./x", "./x"]);
    // The count cell upstream depends on exactly this: collapse them and the
    // scanner's value count for "./x" falls to 1 while the parser still says 2.
    expect(oneLine.filter((r) => !r.erased).length).toBe(2);
  });

  test("RE-EXPORTS are in the population and are actually scanned — the masked construct, named", () => {
    // ⛔ The count cell above is INDIRECT: it catches a dropped re-export only
    // because the count falls. This one is DIRECT, and it exists because the
    // header of this file once told the next author that re-exports did not
    // occur in this tree. THEY OCCUR SEVEN TIMES. A cell naming them is what
    // stops that claim being made again from memory.
    //
    // ⛔ KEYED ON (file, spec, erased) — NOT ON THE LINE. This cell produced TWO
    // of the sprint's false reds on its own (`astrolabe:75 -> :70`,
    // `imago:1647 -> :1723`), which makes it the ruling's own worked example.
    // `erased` is what keeps the two sibling re-exports of ONE specifier
    // distinguishable (`imago` re-exports `../surface/state/types` twice, once
    // as `export type` and once as a value; so does `magpie`), so the identity
    // survives dropping the line without collapsing.
    const found: { file: string; spec: string; erased: boolean }[] = [];
    const context: string[] = [];
    for (const file of trackedSources(PLUGIN_ROOT)) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      const lines = source.split("\n");
      for (const ref of scanSpecifiers(source)) {
        if (ref.kind !== "static") continue;
        // A re-export is a static ref whose statement opens with `export`.
        // The scanner reports the `export` KEYWORD's line, which for a
        // multi-line clause is not the `from` line — `magpie/scripts/backend.ts`
        // opens a five-line statement. Do not additionally require `from` here;
        // that is what made this cell's first draft miss it.
        if (!/^\s*export\b/.test(lines[ref.line - 1] ?? "")) continue;
        const short = file.replace("plugins/spellbook/skills/", "");
        found.push({ file: short, spec: ref.spec, erased: ref.erased });
        context.push(`    ${short}:${ref.line}  ${ref.erased ? "type" : "value"}  ${ref.spec}`);
      }
    }
    console.warn(`\n  RE-EXPORTS, as found today:\n${context.join("\n")}\n`);

    const key = (r: { file: string; spec: string; erased: boolean }) =>
      `${r.file}\t${r.spec}\t${r.erased}`;
    const keys = found.map(key);
    expect(new Set(keys).size).toBe(keys.length);

    // ⚠ `imago` re-exports from `../shared/` — R1's per-spell shared folder,
    // which did not exist when this cell was written. That is Phase 1b landing,
    // not drift, and it is the kind of change a line-keyed pin would have
    // reported as a mystery instead of as a specifier moving.
    //
    // ⚠ `magpie` moved the same way in Phase 6's seam half (sprint 03), and
    // its three rows are the three-way sort made visible IN THE PIN: the
    // two-sided contracts went to `../shared/` (types, alpha), while `reduce`
    // is daemon-only — no browser file imports it — so it landed BESIDE
    // server.ts and its specifier is `./reduce`, not `../shared/reduce`. A pin
    // that showed only `../shared/` here would be hiding the distinction the
    // sort exists to make.
    expect(found.sort((a, b) => key(a).localeCompare(key(b)))).toEqual([
      { file: "astrolabe/scripts/server.ts", spec: "./state.ts", erased: true },
      { file: "imago/scripts/server.ts", spec: "../shared/types", erased: false },
      { file: "imago/scripts/server.ts", spec: "../shared/types", erased: true },
      { file: "magpie/scripts/backend.ts", spec: "../shared/alpha", erased: false },
      { file: "magpie/scripts/server.ts", spec: "../shared/types", erased: false },
      { file: "magpie/scripts/server.ts", spec: "../shared/types", erased: true },
      { file: "magpie/scripts/server.ts", spec: "./reduce", erased: false },
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
    // ⛔ SYNTHETIC POPULATION FOR THE HEURISTIC ITSELF. The corpus-wide audit
    // cell above cannot calibrate a rule for a position the corpus does not
    // contain: deleting the `typeof` rule is INVISIBLE against 317 real files
    // and passes 13/0 — the same empty-population trap as the dedupe key, found
    // the same way, by running the mutation instead of trusting the green.
    // Each rule therefore gets a synthetic instance here.
    // `firstRef` throws rather than returning undefined, so a synthetic input
    // the scanner fails to see AT ALL fails loudly here instead of comparing
    // `undefined` against a string and reading as an ordinary assertion miss.
    const firstRef = (source: string) => {
      const ref = scanSpecifiers(source)[0];
      if (!ref) throw new Error(`the scanner found NO specifier in: ${source}`);
      return ref;
    };
    expect(firstRef(`const a: typeof import("x") = 0 as never;`).kind).toBe("type");
    expect(firstRef(`const b = new Set<import("x").S>();`).kind).toBe("type");
    expect(firstRef(`function c(p: import("x").S) {}`).kind).toBe("type");
    expect(firstRef(`interface I { m: import("x").S }`).kind).toBe("type");

    // ⚠ AND THE ACKNOWLEDGED LIMIT, PINNED AS THE PROPERTY THAT ACTUALLY
    // MATTERS RATHER THAN AS A CLASSIFICATION. A type argument after a COMMA
    // still reads `dynamic`, and that is tolerable ONLY because ward 1b no
    // longer consults `kind`. So assert THAT: whatever this comes back as, 1b's
    // filter keeps it. If someone re-introduces a kind filter in 1b, this
    // reddens and names the reason.
    const comma = firstRef(`let d: Record<string, import("sharp").S>;`);
    // ⛔ The file argument is REQUIRED and it is not decoration: `BUILTIN` is
    // now file-aware (the emitted-root exemption), and the answer differs by
    // file class. A hand-authored path is the right one to assert here.
    expect(
      isRelative(comma.spec) || BUILTIN(comma.spec, "plugins/spellbook/skills/z/scripts/c.ts"),
    ).toBe(false);

    const query = firstRef(`export type T = import("../../outside").X;`);
    const stmt = firstRef(`import type { X } from "../../outside";`);
    expect(query.kind).toBe("type");
    expect(stmt.kind).toBe("static");
    // Both kinds are checked by ward 1a's escape cell — see `relativeEscapes`.
    expect(["static", "type"]).toContain(query.kind);
    expect(["static", "type"]).toContain(stmt.kind);
  });
});
