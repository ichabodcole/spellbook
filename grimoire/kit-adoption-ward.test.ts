// ⛔ THE WARD FOR A RULE THAT WAS PROSE.
//
// seams Contract 21 says a spell adopts `src/kit/` by importing the kit's
// STYLESHEET, and that importing a kit COMPONENT alone is not adoption. Until
// this file, nothing enforced it. cassandra measured the gap rather than
// arguing it (Amendment to Contract 21, 2026-08-31): a shipped, registered
// spell made to import `src/kit/ui/Dot.tsx` WITHOUT `src/kit/theme/base.css`
// ships the component in its JS bundle — all four of its class strings present
// — and ZERO of its utilities. `bun run check` green, `bun test` 1528 pass / 0
// fail, no cell red anywhere in the gate. The rendered element is a zero-size,
// unrounded, uncoloured span. A minted 5th spell reproduced it: emitted CSS
// byte-identical to the pre-adoption build.
//
// The mechanism is in Contract 21 and is not restated here. The single line
// that matters for reading this file: under `@import "tailwindcss" source(none)`
// Bun's Tailwind plugin DISCARDS the module graph, so a kit component's text is
// scanned only when the kit stylesheet's own `@source "../"` is in the cascade —
// i.e. only when the spell's `styles.css` imports it.
//
// ── ⛔ THE TRIGGER IS "IMPORTS A KIT MODULE THAT CONTRIBUTES CLASSES", NEVER
//    "IMPORTS A KIT MODULE" ─────────────────────────────────────────────────
//
// The obvious predicate — *any* `src/kit/**` import demands the stylesheet — is
// WRONG, and shipping it would have been worse than shipping nothing. The kit
// already holds two kinds of module and they are not alike:
//
//   src/kit/lib/cn.ts   10 lines, pure JS, no class literal, emits no CSS and
//                       reads no token. A spell importing only this needs NO
//                       stylesheet: every class it joins came from the caller,
//                       and the caller's own surface is already in scan scope.
//   src/kit/ui/Dot.tsx  authors class text and renders it, and defaults to an
//                       L0 token (`ink-faint`) imago does not define. A spell
//                       importing this MUST have the stylesheet.
//
// A ward that reds on the first case cries wolf, and a ward that cries wolf is
// weakened by the next person who meets it. That cell — a spell importing only
// `cn` stays GREEN — is run below in the route list and is the one this file
// most needed to get right.
//
// ── WHERE THE "CONTRIBUTES CLASSES" JUDGEMENT IS MADE, AND WHY IT IS CONTENT
//    AND NOT A PATH LIST ────────────────────────────────────────────────────
//
// `contributesClasses()`. Contract 19: extend the walk, never pin a list — so
// this reads the module's own text and there is no `KIT_STYLED_MODULES` array,
// no `ui/` vs `lib/` directory convention and no filename rule. The kit is
// about to take the shadcn set and a shared Button; a hand-kept list would be
// wrong within a week and would be wrong SILENTLY, which is the failure this
// whole sprint is about.
//
// A `.ts`/`.tsx` module contributes classes when BOTH hold on comment-stripped,
// specifier-stripped text:
//   (1) it AUTHORS class text — a string literal holding a Tailwind-shaped
//       token (a lowercase-initial word carrying a `-`, `:`, `/` or `[`), and
//   (2) it USES class text — a `className`/`class` attribute or property, or a
//       call to a class-composition helper (`cn`, `clsx`, `cva`, `tv`, …).
// A `.css` module contributes when it defines a class selector.
//
// ⚠ BOTH HALVES ARE LOAD-BEARING AND EACH ALONE OVER-REPORTS. (1) alone reds on
// `"application/json"` and on `id="a-b"`. (2) alone reds on a pure pass-through
// wrapper that only forwards the caller's `className` — which authors nothing
// and needs no kit CSS. Requiring both says the module both writes class text
// and puts class text into markup, which is what "contributes classes" means.
//
// ⛔ AND HERE IS WHAT IT CANNOT SEE — read this before hanging anything else on
// it. A kit module that EXPORTS class strings for a consumer to place without
// using them itself (`export const TONE = { ok: "bg-…-500" }`) satisfies (1) and
// not (2), and would be missed. That is a real hazard and it does not exist in
// the tree today; the repair is to widen CLASS_SITE, not to drop the AND. So is
// a component whose entire class string is a single bare utility
// (`className="flex"`) — no structural marker, so (1) misses it. Both are stated
// because a predicate's blind set is part of its result.
//
// ── COMMENT-STRIPPING IS THE ASSERTION, ON BOTH SIDES ───────────────────────
//
// Not a style preference. Two sibling wards carried exactly this defect and it
// was fixed at 456b973 after cassandra demonstrated both directions on the
// bench: a spell that deletes its `@import` but keeps the prose stays
// "governed" (that false negative was LIVE — imago's styles.css line 2 still
// carries the path in a comment), and a spell that merely MENTIONS the path in
// a comment is admitted to the kit's scan scope. So:
//   • the styles.css side uses the same block-comment strip the two sibling
//     wards now use;
//   • the module side uses `blankComments()` from lib/import-graph.ts, which is
//     strictly stronger — it tracks strings, templates and regex literals and
//     also blanks LINE comments, which the CSS-shaped strip cannot.
// Amendment finding 3 (kit PROSE launders classes into every consumer) is NOT
// addressed here and is not this card's to rule on. This ward neither improves
// nor worsens it: stripping comments on the kit side means a class that exists
// only in a kit COMMENT does not make a spell owe the stylesheet — which is the
// same direction the finding points, one layer up.
//
// ── HOW A NON-AUTHOR BREAKS THIS WARD (all four routes were run) ────────────
//   1. Remove `@import "../../kit/theme/base.css"` from mind-mapper's
//      styles.css while it still imports Dot -> the ADOPTION cell reds naming
//      mind-mapper. No rebuild needed; this cell reads only source.
//   2. Add a `Dot` import to any astrolabe surface component -> the ADOPTION
//      cell reds naming astrolabe, which imports no kit base today.
//   3. Reduce a spell's kit-base `@import` to a comment -> the ADOPTION cell
//      reds. This is route 1 wearing prose, and it is the route the two sibling
//      wards were once blind to.
//   4. Make astrolabe import ONLY `cn` -> STAYS GREEN. The cell that proves the
//      predicate is not "any kit import"; a red here is a defect.
//   5. Break the import walk. Return early from `reachedKitModules` -> REACH and
//      TRANSITIVE red; stop it at the kit boundary (never recurse THROUGH a kit
//      module) -> TRANSITIVE alone reds. An import walk that silently finds
//      nothing and a repo with no adopters produce the same empty offender
//      list, and only those two cells can tell them apart. Both breaks were run;
//      the second is the one that caught the FIRST version of TRANSITIVE, which
//      stayed 4/4 green under it.
//
// ⛔ WHAT THIS FILE MAY NOT WRITE. `grimoire/` is no longer a Tailwind content
// source (every spell scans only its own surface under `source(none)`), but
// kit-styling-ward.test.ts asserts its sentinel utility appears in NO tracked
// text file outside `src/kit/` — this file included. Fixtures below therefore
// use ordinary palette utilities and never that class. If you add a fixture,
// keep it away from the sentinel.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { blankComments, isRelative, scanSpecifiers } from "./lib/import-graph";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC = join(REPO_ROOT, "src");
const KIT_ABS = resolve(SRC, "kit");

/** The adoption unit (Contract 21). Matched against comment-stripped CSS. */
const KIT_BASE_SPEC = "kit/theme/base.css";

/**
 * A class-EMITTING site: the module puts class text into markup. `className?:`
 * in a props type does NOT match — the `?` sits between the name and the colon —
 * which is deliberate: declaring the prop is not using it.
 */
const CLASS_SITE = /\bclassName\s*[=:]|\bclass\s*=\s*["'{]|\b(?:cn|clsx|cva|tv|twMerge)\s*\(/;

/**
 * A Tailwind-SHAPED token: lowercase-initial, optionally negated, carrying at
 * least one structural marker (`-` `:` `/` `[`). The marker requirement is what
 * keeps English words, identifiers and MIME-less literals out; it is also this
 * predicate's stated blind spot for bare single-word utilities (see header).
 */
const CLASS_TOKEN = /^-?[a-z][a-z0-9]*(?:[-:/[][^\s]*)+$/;

/** Class selector in a stylesheet — a `.name` in a SELECTOR position. Preceded
 *  by start/whitespace/combinator so `1.5rem` and `url(./a.png)` cannot match. */
const CSS_CLASS_SELECTOR = /(?:^|[\s,>+~])\.[a-zA-Z_-][\w-]*/;

/** The strip the two sibling wards use, applied to the CSS side. */
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll("\\", "/");

/**
 * Every spell with a `src/<spell>/surface/`, DERIVED FROM THE TREE — a spell
 * that ports its surface later is governed the day it lands, with nobody
 * remembering to edit this file (Contract 19). Note the population key is the
 * DIRECTORY, not `styles.css`: a surface with no stylesheet at all is a spell
 * that cannot possibly have adopted the kit, and it must be IN the population
 * so the ADOPTION cell can say so.
 */
function surfaceSpells(): string[] {
  const spells = readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SRC, e.name, "surface")))
    .map((e) => e.name)
    .sort();
  // ⛔ ZERO-GUARD. An empty population and a clean repo produce the same empty
  // offender list, and only this line distinguishes them.
  expect(spells.length).toBeGreaterThan(0);
  return spells;
}

/** Every `.ts`/`.tsx` under a spell's surface. The whole directory, because
 *  that is exactly what Tailwind's bare `@source "./"` scans — an entry-point
 *  walk would be a narrower population than the mechanism's. */
function surfaceSources(spell: string, dir = join(SRC, spell, "surface"), out: string[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      surfaceSources(spell, join(dir, e.name), out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/**
 * Every kit module reachable from `roots`, TRANSITIVELY — through kit modules
 * (Dot -> cn) and through a spell's own non-kit modules, so a surface that
 * reaches the kit via a local helper is not invisible.
 *
 * ⛔ `erased` REFS ARE SKIPPED, and that is the difference between a ward and a
 * nuisance. `import type { X } from "…/kit/ui/button"` emits nothing, renders
 * nothing and needs no stylesheet; counting it would red a spell for a type
 * annotation. `scanSpecifiers` is used rather than a fresh regex because it is
 * the house's shared enumerator (lib/import-graph.ts) and is already
 * cross-checked against `Bun.Transpiler` over the whole tree by
 * import-boundary-wards.test.ts — a second hand-rolled scan would be a second
 * denominator that cannot be audited. Bare specifiers are skipped because this
 * repo has no path aliases (tsconfig declares no `paths`), so nothing but a
 * relative specifier can land in `src/kit/`.
 */
function reachedKitModules(roots: string[], throughKit = true): Set<string> {
  const kit = new Set<string>();
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined) continue;
    for (const ref of scanSpecifiers(readFileSync(file, "utf8"))) {
      if (ref.erased || !isRelative(ref.spec)) continue;
      let target: string;
      try {
        target = Bun.resolveSync(ref.spec, dirname(file));
      } catch {
        throw new Error(`${rel(file)}: cannot resolve ${ref.spec}`);
      }
      if (target.includes("/node_modules/") || !target.startsWith(`${SRC}/`)) continue;
      if (target.startsWith(`${KIT_ABS}/`)) kit.add(target);
      if (!/\.(tsx?|css)$/.test(target)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      // Only `.ts`/`.tsx` can be scanned for further imports; a `.css` module is
      // a leaf for this walk (its own `@import`s are the CSS side's business).
      // `throughKit` exists ONLY so the TRANSITIVE cell can run this walk against
      // its own depth-1 self and prove the difference is non-empty — never pass
      // `false` from a real caller.
      if (/\.tsx?$/.test(target) && (throughKit || !target.startsWith(`${KIT_ABS}/`))) {
        queue.push(target);
      }
    }
  }
  return kit;
}

/** ⛔ THE JUDGEMENT. See the header for why it is an AND and what it cannot see. */
function contributesClasses(source: string, ext: string): boolean {
  if (ext === "css") return CSS_CLASS_SELECTOR.test(stripCssComments(source));
  const code = blankComments(source);
  // Module specifiers are not class text — and one of them, `lucide-react`, is
  // Tailwind-SHAPED. Removed using the shared scanner's own answers rather than
  // a second pattern, so the two cannot drift apart.
  let text = code;
  for (const ref of scanSpecifiers(source)) {
    text = text.split(`"${ref.spec}"`).join(" ").split(`'${ref.spec}'`).join(" ");
  }
  if (!CLASS_SITE.test(text)) return false;
  for (const m of text.matchAll(
    /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
  )) {
    const literal = m[1] ?? m[2] ?? m[3] ?? "";
    for (const token of literal.split(/\s+/)) {
      if (token !== "" && CLASS_TOKEN.test(token)) return true;
    }
  }
  return false;
}

const contributesFile = (abs: string): boolean =>
  contributesClasses(readFileSync(abs, "utf8"), abs.split(".").pop() ?? "");

/** Does this spell's stylesheet DECLARE adoption? Comment-stripped, because
 *  the prose naming this path outlives the line that does the work. */
function declaresKitBase(spell: string): boolean {
  const styles = join(SRC, spell, "surface", "styles.css");
  if (!existsSync(styles)) return false;
  return stripCssComments(readFileSync(styles, "utf8")).includes(KIT_BASE_SPEC);
}

type Row = { spell: string; contributing: string[]; declares: boolean };

function survey(): Row[] {
  return surfaceSpells().map((spell) => ({
    spell,
    contributing: [...reachedKitModules(surfaceSources(spell))]
      .filter(contributesFile)
      .map(rel)
      .sort(),
    declares: declaresKitBase(spell),
  }));
}

describe("kit adoption ward", () => {
  test("the instrument can tell a class-contributing kit module from one that is not", () => {
    // Without this cell, "no spell owes the stylesheet" and "the predicate
    // stopped recognising classes" are the same output.
    const c = (src: string, ext = "tsx") => contributesClasses(src, ext);

    // The live shapes, in miniature. A joiner that authors nothing:
    expect(
      c('export function j(...i: string[]) { return i.filter(Boolean).join(" "); }', "ts"),
    ).toBe(false);
    // A component that authors class text and renders it:
    expect(
      c('export const D = () => <span className={cn("rounded-full bg-emerald-500")} />;'),
    ).toBe(true);
    // A variants export with no JSX at all — the shadcn shape that is about to
    // land, and the reason CLASS_SITE lists the composition helpers.
    expect(c('export const v = cva("inline-flex items-center gap-2");')).toBe(true);

    // ⛔ COMMENT-STRIPPED, BOTH COMMENT SYNTAXES. A class named only in prose
    // does not make a consumer owe the stylesheet.
    expect(c('/* className={cn("rounded-full bg-emerald-500")} */ export const N = 1;', "ts")).toBe(
      false,
    );
    expect(c('// className={cn("rounded-full bg-emerald-500")}\nexport const N = 1;', "ts")).toBe(
      false,
    );

    // SPECIFIER-STRIPPED. `lucide-react` is Tailwind-shaped; a pass-through
    // wrapper that imports an icon and forwards the caller's className authors
    // nothing and must not be reported.
    expect(
      c(
        'import { Dot } from "lucide-react";\nexport const W = ({ className }) => <Dot className={className} />;',
      ),
    ).toBe(false);
    // Half of the predicate is not the predicate: authoring without a class
    // site (a hyphenated id, a MIME type) is not a contribution…
    expect(c('export const H = { "Content-Type": "application/json", id: "a-b" };', "ts")).toBe(
      false,
    );
    // …and a class site without authored class text is not one either.
    expect(c("export const P = ({ className }) => <div className={className} />;")).toBe(false);

    // A type-only import is not a reach: `erased` refs are dropped by the walk.
    expect(scanSpecifiers('import type { X } from "./x";')[0]?.erased).toBe(true);

    // The CSS branch: a rule-defining sheet contributes, a token sheet does not.
    expect(c(".tile { color: red }", "css")).toBe(true);
    expect(c('@theme { --color-x: #fff; }\n[data-theme="light"] { --color-x: #000; }', "css")).toBe(
      false,
    );
    expect(c("/* .tile { color: red } */\n@theme { --color-x: #fff; }", "css")).toBe(false);
    // Not fooled by a declaration value or a url().
    expect(c("a { margin: .5rem; background: url(./a.png) }", "css")).toBe(false);
  });

  test("REACH: the import walk actually reaches a class-contributing kit module", () => {
    // The offender cell below cannot fail if nothing reaches the kit — and a
    // walk that silently returns nothing looks exactly like a repo where no
    // spell has adopted anything. This is the cell that tells them apart.
    const rows = survey();
    const owing = rows.filter((r) => r.contributing.length > 0);
    expect(owing.length).toBeGreaterThan(0);
    // …and the predicate is discriminating on the LIVE kit, not just fixtures:
    // something is reached that does NOT contribute (today, the class-free
    // joiner). If this stops holding the ward is not wrong, but its negative
    // branch is then only covered by the fixtures above.
    const reached = new Set(rows.flatMap((r) => [...reachedKitModules(surfaceSources(r.spell))]));
    expect([...reached].some((m) => !contributesFile(m))).toBe(true);
  });

  test("TRANSITIVE: at least one surface file reaches a kit module ONLY through another kit module", () => {
    // ⛔ THE COMPARISON IS AGAINST THIS WALK'S OWN DEPTH-1 SELF, and the first
    // version of this cell was weaker in a way that PASSED ITS OWN ROUTE. It
    // compared the closure against the root's DIRECT kit imports, which an
    // App.tsx -> components/Header -> Dot chain satisfies without ever recursing
    // through a kit module — so stopping the walk at the kit boundary left this
    // cell green. Measured, not reasoned: the break was run and 4/4 passed.
    //
    // Nor can the comparison be made per SPELL: no spell has a depth-2-only kit
    // module today (both adopters import the joiner directly as well as through
    // the component), so a spell-level difference is empty and the cell would
    // red on a correct walk. Per FILE it is non-empty — imago's Header reaches
    // the joiner only via the component — and that is the grain this runs at.
    const deeper = surfaceSpells()
      .flatMap((s) => surfaceSources(s))
      .filter((f) => reachedKitModules([f]).size > reachedKitModules([f], false).size);
    expect(deeper.length).toBeGreaterThan(0);
  });

  test("ADOPTION: no spell imports a class-contributing kit module without the kit STYLESHEET", () => {
    const offenders = survey()
      .filter((r) => r.contributing.length > 0 && !r.declares)
      .map(
        (r) =>
          `${r.spell}: reaches ${r.contributing.join(", ")} but its surface/styles.css does not ` +
          `@import ${KIT_BASE_SPEC} — the component ships with none of its utilities`,
      );
    expect(offenders).toEqual([]);
  });
});
