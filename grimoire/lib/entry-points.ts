/**
 * The shared BEHAVIOURAL enumerator for spell entry points.
 *
 * Extracted from `flag-invariant.test.ts` (sprint 05, card s5-H) so that every
 * conformance cell drives the SAME population. The roadmap's instruction was
 * explicit and is the reason this file exists: *extract flag-invariant's
 * behavioural enumerator as a shared module — do not write new scans against a
 * glob.* A second hand-rolled scan is a second denominator, and two denominators
 * that drift apart cannot both be right while both stay green.
 *
 * ── Requirements, each earned by RUNNING a wrong version ────────────────────
 * Moved here verbatim in substance from flag-invariant.test.ts. They are the
 * repeal criteria for every line below; deleting one is how this gets rebuilt
 * wrong a fourth time.
 *
 *  1. Enumerate by WHAT PARSES ARGS. Not by filename; not by `process.argv`
 *     alone (blind to `Bun.argv`); not by static import (blind to
 *     `await import("node:util")`). All three were used and all three were wrong.
 *  2. CALLER-FACING is a separate axis from parsing. An entry point spawned only
 *     by a sibling has a private argv; treating it as public published an
 *     interface the spell does not offer (a 6-item false positive on glamour's
 *     daemon).
 *  3. Anchor the flag registry on a STRUCTURAL SIBLING (`strict:` /
 *     `allowPositionals:` beside `options:`), never on a name. Matching
 *     `options:` hit a flag literally named `options`; matching `/parseArgs\s*\(/`
 *     hit the function DECLARATION and produced 46 plausible findings.
 *  4. Resolve `options: <identifier>` to its declaration — bounty and glamour
 *     use named consts, and a literal-only scan reports all their flags as drift.
 *  5. Read EVERY options map, not the first: mind-mapper/cli.ts has 27.
 *  6. `null` means THE INSTRUMENT COULD NOT READ THIS FILE. Never an empty set —
 *     that is `null` not `0` (the project's own rule) applied to the instrument.
 *
 * ⚠ WHY THE WALK AND NOT A GLOB — a divergence found while extracting this.
 *   `flag-invariant` enumerated with a glob of `<spell>/scripts/*.ts`.
 *   (Written that way on purpose: the literal pattern begins with the two
 *   characters that CLOSE a block comment, so writing it verbatim here ends this
 *   comment and hands the rest of the sentence to the parser as code —
 *   `ReferenceError: scripts is not defined`, which is how this line was found.
 *   principles.md #2, live, inside the module written to enforce it.)
 *   `exit-site-inventory` enumerated with a recursive walk, and its own comment
 *   rejects the glob by name: *"a hand-written glob is a silent filter
 *   (house-style, the 63-vs-37 scar)."*
 *   Two wards in one directory, anchored on the SAME scar, choosing opposite
 *   things. Measured at extraction: today the two agree exactly — every
 *   arg-parsing source in the roster happens to sit at `<spell>/scripts/*.ts`,
 *   so the glob's filter currently costs nothing. It is a latent filter, not a
 *   live defect. This module takes the WIDER of the two (the walk), because a
 *   filter that costs nothing today is exactly the one nobody re-checks — and
 *   `globEntryPointsForComparison()` below exists so the day they diverge is a
 *   red cell in `flag-invariant.test.ts` rather than a silence.
 *
 * ⛔ WHAT THIS ENUMERATOR CANNOT SEE — read this before hanging a rule on it.
 *   **It is `.ts` ONLY.** `walkSpellSources` filters on `.endsWith(".ts")`, so
 *   every hand-authored `.html` / inline-script surface in the roster is outside
 *   the population — a hard JS syntax error in a shipped surface passes both
 *   arms of `bun run check` green (circe, #978).
 *
 *   ⛔ FOR THE SIZE OF THAT BLIND SET, RUN THE DERIVATION — this comment
 *   deliberately carries NO number:
 *
 *       bun scripts/instruments/gate-blind-set.ts
 *
 *   This block previously quoted "~4,182 lines / ~1,001 unguarded", marked TAKEN
 *   ON REPORT. **thoth then measured that figure inflated by exactly one per
 *   file (#1028)** — so the marking worked and the number was still wrong in a
 *   committed file. The fix is not a better number: it is the anchor-card lesson
 *   applied here, **state the INVOCATION, not the value**. A number in prose
 *   must be converted by its reader and cannot be re-run; a command re-derives
 *   itself and cannot go stale without saying so.
 *
 *   It is a COVERAGE set, never a defect count — nobody has classified those
 *   files. If the instrument is missing when you look, that absence IS the
 *   finding; do not reconstruct a figure from this comment.
 *
 *   That filter is CORRECT for the question this module asks ("which entry
 *   points parse arguments?" — those are `.ts`), and the 16/7 counts do not
 *   change. It is stated here because this module is sprint 05's shared
 *   instrument, so **every rule mechanised on top of it inherits this axis**, and
 *   a sprint can otherwise end with "the rules are enforced" true of the
 *   agent-facing half and false of the human-facing half with nothing saying
 *   which half was measured.
 *
 *   Found by circe (#982), and the turn in it is the reason it is written HERE
 *   rather than in a card: the paragraph directly above cites the glob scar
 *   while REPRODUCING that scar on a different axis. house-style already carries
 *   the governing sentence — *name the question before the behaviour; "by
 *   behaviour, not by name" is necessary and NOT sufficient, because two
 *   behaviour-shaped predicates over one file can both be correct for different
 *   questions and silently wrong for each other's.*
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SKILLS_DIR = join(import.meta.dir, "..", "..", "plugins", "spellbook", "skills");

/**
 * The SECOND root, added in spell-kit Slice 2 (2026-08-31).
 *
 * ⛔ THE POPULATION FOLLOWS ITS SUBJECT, OR THE WARDS GO QUIET. Contract 4's
 * built-backend amendment moves a spell's CLI SOURCE to `src/<spell>/backend/`
 * and ships a launcher at `<spell>/scripts/cli.ts`. The launcher parses no
 * arguments, so on the day a backend ships built, every ward built on this
 * module loses that spell's real entry point — and a shrunk population is not
 * a red cell. Measured when it happened: `strict-parse-invariant` went 17 -> 15
 * invocations, `terminator-invariant` 8 -> 6 files, and `flag-invariant`
 * reported astrolabe's and magpie's documented flags as UNRESOLVED.
 *
 * Those pins failing is the ward working. This root is what makes them pass
 * again for the right reason: the entry point moved, so the walk moved with it.
 */
export const BACKEND_SRC_DIR = join(import.meta.dir, "..", "..", "src");

/**
 * Requirement 1, as a single named regex so every cell shares one definition of
 * "this file parses arguments". The two spellings after `node:util` are the ones
 * that defeated earlier classifiers: `Bun.argv` and a dynamic `await import`.
 */
export const PARSES_ARGS = /nodeParseArgs\(|parseArgs\(\s*\{|node:util|Bun\.argv|process\.argv/;

/** Recursive walk for non-test `.ts`. Never a fixed depth, never a layout guess. */
export function walkSpellSources(dir: string = SKILLS_DIR, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      walkSpellSources(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * Non-test `.ts` under `src/<spell>/backend/`, keyed as `<spell>/backend/...`.
 *
 * ⛔ THE KEY IS DELIBERATELY NOT REPO-RELATIVE. `spellsOf` and
 * `INTERNAL_ENTRY_POINTS` both read the FIRST path segment as the spell name, so
 * a `src/magpie/backend/cli.ts` key would attribute the entry point to a spell
 * called "src" — silently, and in the one function every ward trusts for
 * attribution. `<spell>/backend/cli.ts` keeps that read correct and cannot
 * collide with `<spell>/scripts/...`.
 */
export function backendSources(): string[] {
  if (!existsSync(BACKEND_SRC_DIR)) return [];
  const out: string[] = [];
  for (const spell of readdirSync(BACKEND_SRC_DIR)) {
    const dir = join(BACKEND_SRC_DIR, spell, "backend");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const abs of walkSpellSources(dir))
      out.push(`${spell}/backend/${abs.slice(dir.length + 1)}`);
  }
  return out.sort();
}

/** Every arg-parsing entry point in the roster, across BOTH roots. */
export function argParsingEntryPoints(): string[] {
  const shipped = walkSpellSources()
    .filter((abs) => PARSES_ARGS.test(readFileSync(abs, "utf8")))
    .map((abs) => abs.slice(SKILLS_DIR.length + 1));
  const built = backendSources().filter((rel) => PARSES_ARGS.test(readEntryPoint(rel)));
  return [...shipped, ...built].sort();
}

/** The `<spell>/scripts/*.ts` glob `flag-invariant` used, kept ONLY so the two
 *  strategies can be asserted equal. Not for enumeration — use the walk. */
export function globEntryPointsForComparison(): string[] {
  return [
    ...[...new Bun.Glob("*/scripts/*.ts").scanSync({ cwd: SKILLS_DIR })].filter(
      (p) => !p.endsWith(".test.ts"),
    ),
    // The second root's glob twin — without it the two strategies disagree by
    // exactly the files Slice 2 moved, and the comparison cell would report a
    // drift that is really just one strategy having been taught the new root.
    ...[...new Bun.Glob("*/backend/*.ts").scanSync({ cwd: BACKEND_SRC_DIR })].filter(
      (p) => !p.endsWith(".test.ts"),
    ),
  ]
    .filter((p) => PARSES_ARGS.test(readEntryPoint(p)))
    .sort();
}

/**
 * Requirement 2. Internal = spawned only by a sibling inside the same spell, so
 * its argv is private. Keyed by path and verifiable BY LISTING, which is the
 * only completeness claim available for an exclusion set.
 */
export const INTERNAL_ENTRY_POINTS: ReadonlySet<string> = new Set([
  "astrolabe/scripts/server.ts",
  "bounty/scripts/server.ts",
  "glamour/scripts/server.ts",
  "imago/scripts/server.ts",
  "magpie/scripts/server.ts",
  "mind-mapper/scripts/server.ts",
  "magpie/scripts/discover.ts",
]);

export const isCallerFacing = (rel: string) => !INTERNAL_ENTRY_POINTS.has(rel);

function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

/**
 * The flag names one source recognises.
 *
 * Requirements 3, 4, 5 and 6 all live in this function.
 * @returns the flag names, or `null` when the instrument could not read the
 *          file. NEVER an empty array — an unreadable file and a file with no
 *          flags must not answer the same thing.
 */
export function recognizedFlags(src: string): string[] | null {
  const names = new Set<string>();
  let sawMap = false;
  // `options: {…}`, `options: IDENT`, or the SHORTHAND `options,` inside the
  // argument object (grapevine's acc registry refactor spells it that way —
  // the invocation receives a per-command SUBSET local named `options`).
  for (const m of src.matchAll(/options\s*(?::\s*(\{|([A-Za-z_$][\w$]*))|(,))/g)) {
    // Requirement 3: a real parseArgs argument object carries these siblings.
    if (!/\bstrict\s*:|\ballowPositionals\s*:/.test(src.slice(m.index, m.index + 1200))) continue;
    sawMap = true;
    let block: string;
    if (m[1] === "{") {
      block = braceBlock(src, src.indexOf("{", m.index));
    } else {
      const ident = m[3] === "," ? "options" : (m[2] as string);
      const declRe = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*`);
      const declMatch = declRe.exec(src);
      if (declMatch === null) return null; // Requirement 4 failed — instrument, not "clean"
      const after = src.slice(declMatch.index + declMatch[0].length);
      if (after.startsWith("{")) {
        block = braceBlock(src, declMatch.index + declMatch[0].length);
      } else {
        // Requirement 4b (grapevine, acc registry refactor): the declaration is
        // a COMPUTED per-command subset — `Object.fromEntries(cmd.flags.map((k)
        // => [k, CLI_OPTIONS[k]]))`. The subset is not a literal, but its
        // SOURCE registry is, and the union across commands IS the recognized
        // set (magpie's stage-1 semantics: a flag outside the registry is
        // refused as unknown; a registry flag at the wrong command is refused
        // as misplaced — both are "recognized" for this ward's two halves).
        // Resolve the registry the subset indexes into, or answer null.
        const fromEntries = /Object\.fromEntries\([\s\S]{0,200}?\b([A-Z][A-Za-z0-9_$]*)\s*\[/.exec(
          after.slice(0, 400),
        );
        if (fromEntries === null) return null;
        const regDecl = src.search(
          new RegExp(`(?:const|let|var)\\s+${fromEntries[1]}\\s*=\\s*\\{`),
        );
        if (regDecl < 0) return null;
        block = braceBlock(src, src.indexOf("{", regDecl));
      }
    }
    for (const k of block.matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{\s*type\s*:/g))
      names.add(k[1] ?? k[2]);
  }
  return sawMap ? [...names] : null;
}

/**
 * Does this entry point accept POSITIONALS alongside flags?
 *
 * Structural, and deliberately narrow: it matches the literal
 * `allowPositionals: true` that must appear in the parseArgs argument object for
 * `node:util` to accept free text at all. That is the same class of anchor as
 * requirement 3 — a property the behaviour cannot exist without — rather than a
 * guess at how someone spelled a helper.
 *
 * ⚠ It answers ONLY "can free text and flags coexist here", which is the
 * precondition for the `--` demotion hazard. It says NOTHING about whether the
 * entry point guards that hazard; a guard can be spelled countless ways and any
 * regex for one would be `by name, not by behaviour` — the thing requirement 1
 * forbids. Do not grow this into a guard detector.
 */
export const allowsPositionals = (src: string) => /allowPositionals\s*:\s*true/.test(src);

/**
 * Every parseArgs INVOCATION in a source, returned as its argument-object text.
 *
 * ⚠ INVOCATIONS, NOT PROPERTY NAMES, and that distinction is not pedantry — it
 * is requirement 3 restated at the call-site level, and it bit during sprint 05.
 * A quick count keyed on `options\s*:` reported two unaccounted maps in
 * imago/cli.ts and magpie/cli.ts. Both were `options: { type: "string" }` — a
 * FLAG LITERALLY NAMED `options` inside the flag map — matched because a real
 * parseArgs call sat within the lookahead window further down the file. That is
 * the same false positive requirement 3 already records, reproduced by someone
 * who had just read requirement 3.
 *
 * Anchoring on `parseArgs(` + a brace-matched argument object cannot make that
 * mistake: a flag named `options` is not a call.
 */
export function parseArgsInvocations(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:nodeParseArgs|parseArgs)\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    out.push(braceBlock(src, open));
  }
  return out;
}

/** Read an entry point's source by its SKILLS_DIR-relative path. */
export const readEntryPoint = (rel: string) =>
  readFileSync(
    // `<spell>/backend/...` resolves against `src/`, everything else against the
    // shipped skills tree. Keyed on the SECOND segment because the first is the
    // spell name in both shapes.
    rel.split("/")[1] === "backend"
      ? join(BACKEND_SRC_DIR, rel.replace("/backend/", "/backend/"))
      : join(SKILLS_DIR, rel),
    "utf8",
  );

/** The spells that own at least one arg-parsing entry point. */
export const spellsOf = (entryPoints: string[]) =>
  [...new Set(entryPoints.map((p) => p.split("/")[0] as string))].sort();
