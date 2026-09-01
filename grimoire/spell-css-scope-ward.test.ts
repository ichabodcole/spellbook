// ⛔ THE WARD FOR A LEAK WITH NO IMPORT TO FOLLOW.
//
// Tailwind does not emit by reachability — it emits by TEXT MATCH over a
// content scan. Until 2026-08-31 every spell's `styles.css` opened with a bare
// `@import "tailwindcss"`, which leaves Tailwind's AUTOMATIC content detection
// on; that detection roots at the PROCESS CWD, and `bun run build` runs from
// the repo root. So each spell's stylesheet was compiled out of every spell's
// text — plus the committed `dist/` trees, which `.gitignore` un-ignores.
//
// No import ward, no bundler pass and no dependency manifest can see this,
// because THERE IS NO IMPORT. The coupling is textual.
//
// ── WHAT WAS MEASURED (2026-08-31, this ward's phase) ───────────────────────
//
//   astrolabe   142,977 B / 1,028 class selectors  ->  35,472 B / 199
//   imago       149,930 B / 1,028                  ->  51,036 B / 347
//   magpie      147,035 B / 1,018                  ->  44,233 B / 262
//   mind-mapper 165,843 B / 1,102                  ->  65,739 B / 390
//
// 969 of those selectors were common to all four. The repair is one line per
// spell — `@import "tailwindcss" source(none);` plus an explicit `@source` —
// and it loses ZERO class any spell actually uses. That was checked twice, by
// two instruments that fail in different directions: every dropped selector was
// looked for as boundary-matched literal text in the spell's own source, and
// again in the spell's SHIPPED JS BUNDLE (which also contains every
// node_modules module it renders, so a class living only inside a third-party
// package could not hide). Both came back with nothing but English words and
// numeric literals — `32` from `c.width = 32`, `outline` from a JSX comment,
// `transition` from a React warning string. Those had been REAL RULES in the
// shipped stylesheets: prose was being compiled into CSS.
//
// ── AND IT MADE THE BUILD REPRODUCIBLE, WHICH IS THE HALF THAT ALMOST GOT
//    RECORDED BACKWARDS ─────────────────────────────────────────────────────
//
// `@source not ".../dist"` was present in imago and mind-mapper and absent from
// astrolabe and magpie. Removing it from imago and rebuilding changed NOTHING —
// byte-identical output — which reads as "the guard was always dead" and is
// WRONG. The guard has no subject unless a stale class exists in some spell's
// `dist/`, and `src/build.ts` rm's each spell's own `dist/` before building it.
// The reproduction needs a class that reaches ANOTHER spell's committed output:
//
//   1. add a stock-palette class to an astrolabe COMPONENT (not a bare const —
//      an unused export is tree-shaken out of the bundle and then only the CSS
//      carries it, and Tailwind does not scan CSS)
//   2. `bun run build astrolabe`, then delete the class from the source again
//   3. `bun run build magpie` -> magpie emitted it. imago and mind-mapper,
//      which had the guard, did not.
//
// So the guard was LIVE, and the first measurement was an instrument with no
// failure mode pointed at an empty world. `source(none)` retires it properly:
// the only content source is the spell's own `surface/`, and no `dist/` is
// under it. Re-run step 3 with the fix in place and magpie stays clean, which
// is why the line was deleted from imago and mind-mapper rather than copied
// into astrolabe and magpie. Four dead guards would have been worse than two.
//
// ── HOW A NON-AUTHOR BREAKS THIS WARD (each route hits a different cell) ─────
//   1. Drop `source(none)` from any spell's styles.css -> the DECLARATION cell
//      reds immediately, before anything is rebuilt.
//   2. Drop it AND rebuild -> the CROSS-SPELL cell reds, naming the spell the
//      leaked classes came from. This is the cell that would have caught the
//      original defect.
//   3. Point a spell's `@source` at a parent directory -> same as 2.
//   4. Relocate a fifth spell and it is governed automatically; the population
//      is derived from the tree, never declared here (seams Contract 19).
//
// ⛔ THE DENOMINATOR IS ASSERTED, NOT ASSUMED. A pairwise "B never emits a
// class only A uses" cell is vacuous if A has no class B lacks, and it is
// vacuous in exactly the case where it is needed least. The discrimination cell
// below fails if any ordered pair has an empty candidate set.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC = join(REPO_ROOT, "src");

/** Characters that can be part of a Tailwind candidate. A class only counts as
 *  "used in this text" when it is delimited by something outside this set —
 *  otherwise `bg-amber-500` matches inside `bg-amber-500/20`, whose candidate is
 *  the longer string alone, and the ward reports leaks that are not there. */
const CANDIDATE_CHARS = String.raw`A-Za-z0-9_:/.\-\[\]!%()#,*&<>+~@$`;

/** The TRAILING delimiter set drops `:`, and that is not a rounding error.
 *  Tailwind splits candidates on `:` (that is how `hover:` attaches), so a class
 *  followed by a colon is still extracted — which is why the CSS *property*
 *  `transform:` inside a keyframe and inside a JS style object put a real
 *  `.transform` rule into mind-mapper's stylesheet. Keeping `:` here made the
 *  ward read that rule as a leak from imago, because imago is where the word
 *  next appears in a shape this matcher could see. */
const AFTER_CHARS = String.raw`A-Za-z0-9_/.\-\[\]!%()#,*&<>+~@$`;

/** Does this text account for the class? Two shapes count, and the second is
 *  not optional: a class can reach a spell's stylesheet either as a CANDIDATE
 *  in markup (`className="tile"`) or as a hand-written SELECTOR in that spell's
 *  own `styles.css` (`.tile { @apply … }`). The selector form is preceded by a
 *  `.`, which is itself a candidate character — so the candidate matcher alone
 *  reports every `@layer components` class as unaccounted for, and the
 *  cross-spell cell then flags the ones two spells happen to share as leaks.
 *  Measured: 5 such classes in imago, 2 in magpie. */
const usedIn = (text: string, cls: string): boolean => {
  const c = escapeRe(cls);
  const asCandidate = new RegExp(`(?<![${CANDIDATE_CHARS}])${c}(?![${AFTER_CHARS}])`);
  // NO lookbehind on the selector form: in a COMPOUND selector
  // (`.react-flow__node.draggable`) the character before the dot belongs to the
  // previous class and is therefore a candidate character, so a lookbehind
  // rejects exactly the selectors a third-party stylesheet is full of.
  const asSelector = new RegExp(`\\.${c}(?![${AFTER_CHARS}])`);
  return asCandidate.test(text) || asSelector.test(text);
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Class selectors DEFINED by a stylesheet. Walks the text tracking rule
 *  preludes, so a declaration VALUE (`1.5rem`, `url(./a.png)`) can never be
 *  mistaken for a selector — which a bare `/\.[\w-]+/` sweep does constantly. */
function classSelectors(css: string): Set<string> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  let prelude = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      prelude += c + (text[i + 1] ?? "");
      i++;
    } else if (c === "{") {
      harvest(prelude, out);
      prelude = "";
    } else if (c === "}" || c === ";") {
      prelude = "";
    } else {
      prelude += c;
    }
  }
  return out;
}

function harvest(prelude: string, out: Set<string>): void {
  const p = prelude.trim();
  if (p.startsWith("@")) return; // at-rule preludes hold no class selectors
  for (const m of p.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
    const raw = m[1];
    if (raw !== undefined) out.add(raw.replace(/\\(.)/g, "$1"));
  }
}

/** Relocated spells, DERIVED from the tree. A fifth spell is governed the day
 *  it lands a surface, with no edit here. */
function relocatedSpells(): string[] {
  const spells = readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SRC, e.name, "surface", "styles.css")))
    .map((e) => e.name)
    .sort();
  // A dead walk and a repo with no spells look identical from here.
  expect(spells.length).toBeGreaterThan(1);
  return spells;
}

const stylesFor = (spell: string): string => join(SRC, spell, "surface", "styles.css");

function walkText(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walkText(join(dir, e.name), out);
    } else if (/\.(tsx?|html|css)$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** Everything Tailwind is allowed to see when compiling this spell: its own
 *  `surface/`, plus `src/kit/` when — and only when — the spell imports the kit
 *  stylesheet. That import is what puts the kit in scope (through the kit
 *  sheet's own `@source "../"`); under `source(none)` importing a kit COMPONENT
 *  does not, because Bun's Tailwind plugin discards the module graph when the
 *  content root is `none`. */
async function scannedText(spell: string): Promise<string> {
  const dirs = [join(SRC, spell, "surface")];
  // ⛔ STRIP BEFORE TESTING — a prose mention of the path would otherwise widen
  // this spell's allowed scan scope to all of src/kit/, silently raising the
  // leak detector's tolerance for a spell that imports nothing.
  const styles = (await Bun.file(stylesFor(spell)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
  if (styles.includes("kit/theme/base.css")) dirs.push(join(SRC, "kit"));
  const files = dirs.flatMap((d) => walkText(d));
  expect(files.length).toBeGreaterThan(0);
  const parts = await Promise.all(files.map((f) => Bun.file(f).text()));
  return [...parts, ...(await importedStylesheets(spell, files))].join("\n \n");
}

/** THE SECOND WAY A RULE LEGITIMATELY REACHES A SPELL'S CSS, and leaving it out
 *  made this ward's first green impossible. Tailwind's scan is one input; the
 *  other is a stylesheet the bundle `import`s, whose rules are copied through
 *  verbatim. mind-mapper pulls in `@xyflow/react/dist/style.css`, which defines
 *  `.draggable`, `.dragging`, `.cross`, `.horizontal` — words that also occur in
 *  imago's and magpie's source as English and as prop names, so the cross-spell
 *  cell read all four as leaks from spells that had nothing to do with them.
 *  Resolved from the tree, not declared: the specifier is whatever the source
 *  imports. */
async function importedStylesheets(spell: string, sourceFiles: string[]): Promise<string[]> {
  const surface = join(SRC, spell, "surface");
  const specs = new Set<string>();
  for (const f of sourceFiles) {
    if (!/\.tsx?$/.test(f)) continue;
    for (const m of (await Bun.file(f).text()).matchAll(/import\s+"([^"]+\.css)"/g)) {
      const spec = m[1];
      // The spell's own styles.css is already in the walk; anything else is a
      // stylesheet whose rules this spell ships without ever scanning them.
      if (spec !== undefined && !spec.endsWith("/styles.css")) specs.add(spec);
    }
  }
  const texts: string[] = [];
  for (const spec of specs) {
    try {
      texts.push(await Bun.file(Bun.resolveSync(spec, surface)).text());
    } catch {
      // An unresolvable stylesheet is a different failure with a different
      // repair; the build would already be red. Do not silently widen scope.
      throw new Error(`${spell}: cannot resolve imported stylesheet ${spec}`);
    }
  }
  return texts;
}

async function shippedCss(spell: string): Promise<string> {
  const distDir = join(REPO_ROOT, "plugins", "spellbook", "skills", spell, "dist");
  const files = readdirSync(distDir).filter((f) => f.endsWith(".css"));
  // Contract 18: zero files examined is NO VERDICT, never a pass.
  expect(files.length).toBeGreaterThan(0);
  const first = files.at(0);
  if (first === undefined) throw new Error(`no css emitted for ${spell}`);
  const css = await Bun.file(join(distDir, first)).text();
  expect(css.length).toBeGreaterThan(0);
  return css;
}

describe("spell css scope ward", () => {
  const spells = relocatedSpells();

  test("the instrument can tell a class from a longer class that contains it", () => {
    // Without this the cross-spell cell reports leaks that are not there, and
    // "0 leaks" and "the matcher is broken" are the same output.
    const text = 'className="bg-amber-500/20 text-amber-200"';
    expect(usedIn(text, "bg-amber-500/20")).toBe(true);
    expect(usedIn(text, "bg-amber-500")).toBe(false);
    expect(usedIn(text, "text-amber-200")).toBe(true);
    // A class followed by `:` is still extracted by Tailwind, so a CSS property
    // name counts as a use. Real case: `transform: scaleY(.35)` in a keyframe
    // puts `.transform` in the stylesheet, and treating that as unaccounted-for
    // made the cross-spell cell blame a spell that never touched it.
    expect(usedIn("transform: scaleY(0.35);", "transform")).toBe(true);
    // A variant prefix is not the class it decorates.
    expect(usedIn('className="hover:bg-surface"', "bg-surface")).toBe(false);
    // A compound selector in a third-party stylesheet accounts for its parts.
    expect(usedIn(".react-flow__node.draggable{}", "draggable")).toBe(true);
    const css = classSelectors(".a .b\\:c{color:red}@media x{.d{margin:.5rem}}");
    expect([...css].sort()).toEqual(["a", "b:c", "d"]);
  });

  for (const spell of spells) {
    test(`${spell} — DECLARATION: the scan is scoped, not automatic`, async () => {
      // ⛔ COMMENTS STRIPPED FIRST, and that is not tidiness. These files carry
      // long prose about `source(none)`, so a cell reading the raw text would
      // be satisfied by the paragraph EXPLAINING the rule after someone deleted
      // the rule. Caught here: this ward's first run failed on its own summary
      // sentence in astrolabe's header.
      const styles = (await Bun.file(stylesFor(spell)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
      // The mechanism, asserted where a reader will look for it. This reds the
      // moment the line is dropped — before any rebuild makes the leak visible.
      expect(styles).toContain('@import "tailwindcss" source(none)');
      expect(styles).toMatch(/@source\s+"\.\/"/);
    });
  }

  test("DISCRIMINATION: every ordered pair has something to discriminate WITH", async () => {
    // The cross-spell cell asks "does B emit a class only A uses". If A has no
    // such class the cell cannot fail, and it cannot fail hardest in the case
    // where the two spells have converged — which is the leak itself.
    const text = new Map<string, string>();
    const shipped = new Map<string, Set<string>>();
    for (const s of spells) {
      text.set(s, await scannedText(s));
      shipped.set(s, classSelectors(await shippedCss(s)));
    }
    const thin: string[] = [];
    for (const a of spells) {
      for (const b of spells) {
        if (a === b) continue;
        const aText = text.get(a) ?? "";
        const bText = text.get(b) ?? "";
        const onlyA = [...(shipped.get(a) ?? [])].filter(
          (c) => usedIn(aText, c) && !usedIn(bText, c),
        );
        if (onlyA.length === 0) thin.push(`${a}->${b}`);
      }
    }
    expect(thin).toEqual([]);
  });

  test("CROSS-SPELL: no spell's stylesheet carries a class only another spell uses", async () => {
    const text = new Map<string, string>();
    const shipped = new Map<string, Set<string>>();
    for (const s of spells) {
      text.set(s, await scannedText(s));
      shipped.set(s, classSelectors(await shippedCss(s)));
    }
    const leaks: string[] = [];
    for (const b of spells) {
      const bText = text.get(b) ?? "";
      const bCss = shipped.get(b) ?? new Set<string>();
      for (const a of spells) {
        if (a === b) continue;
        const aText = text.get(a) ?? "";
        // Emitted into B, spelled in A, spelled nowhere B is allowed to look.
        const leaked = [...bCss].filter((c) => !usedIn(bText, c) && usedIn(aText, c));
        if (leaked.length > 0) {
          leaks.push(
            `${b} carries ${leaked.length} class(es) only ${a} uses: ${leaked
              .slice(0, 8)
              .join(", ")}`,
          );
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
