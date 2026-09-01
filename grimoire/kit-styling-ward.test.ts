// ⛔ THE WARD FOR A LAYER NO OTHER CHECK READS.
//
// `src/kit/` ships styled components into more than one spell. `bun run check`
// reads NO CSS at all and `bun test` builds nothing, so a kit component whose
// styling silently stopped resolving is invisible to the entire gate — the
// board renders wrong at HTTP 200 and every other signal stays green.
//
// ── WHAT THE HAZARD IS *NOT*, MEASURED RATHER THAN ASSUMED (2026-08-31) ──────
//
// The expected hazard was "Tailwind cannot SEE src/kit/, so it emits zero
// utilities with no error", on the reasoning that `src/kit/` sits outside every
// surface's `@source` root. THAT IS FALSE HERE, and a ward built on it is
// vacuous. Three measurements, each falsifying a step:
//
//   1. Tailwind v4's automatic content detection roots at the PROCESS CWD.
//      `bun run build` runs from the repo root, so `src/kit/` is scanned there
//      anyway — an UNIMPORTED, CSS-less file dropped into `src/kit/` had its
//      utility emitted into mind-mapper's shipped stylesheet.
//   2. A dev daemon differs (seams Contract 5 pins cwd to `src/<spell>/`, which
//      cannot see a sibling `src/kit/`) — but only for files NOT in the bundle.
//   3. THE DECIDING ONE: under Bun's Tailwind plugin the BUNDLE'S MODULE GRAPH
//      is a content source. A kit component that a spell imports is scanned
//      with no `@source`, no kit CSS import, and from the dev content root.
//      Verified by removing each in turn and rebuilding: the utility survived
//      all three.
//
// A kit COMPONENT is by definition imported, so the utility half cannot fail
// this way. An earlier draft of this file asserted it could, and CALIBRATION
// CAUGHT IT: the cell stayed green with the mechanism deleted. It is recorded
// here because the shape — a check that reports success on the empty case — is
// this sprint's whole subject, and it very nearly shipped inside the ward
// written to prevent it.
//
// ── WHAT THE HAZARD ACTUALLY IS ─────────────────────────────────────────────
//
// TOKENS, not utilities. A kit component names L0 tokens (`border-edge`,
// `bg-ink-faint`). Emitting the utility is free; RESOLVING it is not. A spell
// that adopts a kit component without importing the kit's stylesheet gets a
// utility referencing an undefined custom property — no error, no missing
// class, just a colour that silently does not apply. imago is the live case:
// it defines `--color-faint` and NOT `--color-ink-faint`, so it inherits that
// token from the kit and would lose it.
//
// ── HOW A NON-AUTHOR BREAKS IT (each route hits a different cell) ────────────
//   1. Remove `@import "../../kit/theme/base.css"` from imago's styles.css and
//      rebuild imago -> the TOKEN RESOLUTION cell goes red (--color-ink-faint
//      undefined). This is the route that matters; it is the real failure.
//   2. Swap the square-size shorthand in src/kit/ui/Dot.tsx for the
//      width+height pair, and rebuild
//      -> the RELEASE cells go red (the sentinel stops existing).
//   3. Give imago its own `--color-edge` equal to mind-mapper's and rebuild
//      -> the DIVERGENCE cell goes red (override no longer demonstrated).
//   4. Have a third spell import the kit base without adding it to
//      KIT_CONSUMERS -> the membership cell goes red.
//   5. Use the sentinel class anywhere outside src/kit/ -> the discrimination cell goes
//      red, because the sentinel would no longer prove anything.
//
// ⛔ AND NOTE WHAT THIS FILE MAY NOT SAY. The sentinel class is never spelled
// literally anywhere in this ward — not in the routes above, not in the
// constant, which is assembled from fragments. Tailwind's content root for
// `bun run build` is the REPO ROOT, so this file is scanned; an earlier draft
// named the class in prose and thereby EMITTED IT, and the release cells then
// passed on the strength of the sentence describing them. The ward was
// asserting the existence of its own text. If you add a route here, describe
// the class — do not write it.
//
// EVERY CELL BELOW WAS RUN RED BY ITS OWN ROUTE BEFORE THIS FILE LANDED.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const KIT_CSS = join(REPO_ROOT, "src", "kit", "theme", "base.css");

/** Spells consuming the kit's styling. Declared, then RE-DERIVED from the tree
 *  by the membership cell — a spell that adopts the kit and is not added here
 *  would otherwise leave this ward silently narrower than its title claims
 *  (seams Contract 19: a ward's population must follow its subject). */
const KIT_CONSUMERS = ["imago", "mind-mapper"] as const;

/** A utility used by a KIT component and by NOTHING else in the roster — the
 *  hand-written dots all spell it `w-2 h-2`. Its discrimination is asserted
 *  below rather than trusted. */
const KIT_ONLY_UTILITY = ["size", "2"].join("-");

/** At least one L0 token must resolve DIFFERENTLY in the two spells, or
 *  "override" is a claim with no evidence behind it. */
const DIVERGENT_TOKEN = "--color-edge";

const shippedCss = async (spell: string): Promise<string> => {
  const distDir = join(REPO_ROOT, "plugins", "spellbook", "skills", spell, "dist");
  const files = readdirSync(distDir).filter((f) => f.endsWith(".css"));
  // Contract 18: zero files examined is NO VERDICT, never a pass. `.at(0)` +
  // an explicit guard rather than `[0]!` — the assertion has to hold at RUNTIME,
  // and a non-null assertion only silences the type checker.
  expect(files.length).toBeGreaterThan(0);
  const first = files.at(0);
  if (first === undefined) throw new Error(`no css emitted for ${spell}`);
  const css = await Bun.file(join(distDir, first)).text();
  expect(css.length).toBeGreaterThan(0);
  return css;
};

/** The kit's L0 token names, PARSED from the kit's own @theme rather than
 *  hand-listed — a hand-kept copy drifts from the thing it describes. */
async function kitTokens(): Promise<string[]> {
  const css = await Bun.file(KIT_CSS).text();
  const theme = css.match(/@theme\s*\{([\s\S]*?)\}/)?.[1];
  // A kit stylesheet with no @theme block is a different failure from a kit
  // stylesheet whose tokens went missing, and they need different repairs.
  if (theme === undefined) throw new Error(`${KIT_CSS} declares no @theme block`);
  const names = [...theme.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  expect(names.length).toBeGreaterThan(0); // zero-guard on the ward's denominator
  return names;
}

const definitionOf = (css: string, token: string): string | null => {
  return css.match(new RegExp(`${token}\\s*:\\s*([^;]+);`))?.[1]?.trim() ?? null;
};

describe("kit styling ward", () => {
  test("the sentinel utility is genuinely kit-only (a hit elsewhere makes every cell vacuous)", async () => {
    // ⛔ `-c -o --exclude-standard`, NOT a bare `git ls-files`: a bare listing
    // reads the INDEX, so an UNTRACKED file using the sentinel is invisible and
    // this cell passes while the sentinel has already stopped discriminating
    // (playbook Gotcha 4). Measured — a planted untracked offender did not
    // register until this flag set was added.
    //
    // ⛔ AND THE WALK IS THE WHOLE REPO, not src + plugins. Tailwind's content
    // root for `bun run build` is the repo root, so ANY tracked text file can
    // feed the scan — including this ward. An earlier draft spelled the
    // sentinel literally here and KEPT IT EMITTED BY ITSELF: the assertion was
    // satisfied by the assertion's own source text.
    const out = Bun.spawnSync(["git", "ls-files", "-c", "-o", "--exclude-standard"], {
      cwd: REPO_ROOT,
    });
    const files = out.stdout
      .toString()
      .split("\n")
      .filter(
        (f) =>
          /\.(tsx|ts|html|css|md)$/.test(f) && !f.startsWith("src/kit/") && !f.includes("/dist/"),
      );
    expect(files.length).toBeGreaterThan(0); // a dead walk and a clean walk look identical
    const offenders: string[] = [];
    for (const f of files) {
      const text = await Bun.file(join(REPO_ROOT, f)).text();
      if (new RegExp(`\\b${KIT_ONLY_UTILITY}\\b`).test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("every spell importing the kit base is governed here", async () => {
    const importing: string[] = [];
    for (const dir of readdirSync(join(REPO_ROOT, "src"), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const styles = join(REPO_ROOT, "src", dir.name, "surface", "styles.css");
      if (!existsSync(styles)) continue;
      if ((await Bun.file(styles).text()).includes("kit/theme/base.css")) importing.push(dir.name);
    }
    expect(importing.sort()).toEqual([...KIT_CONSUMERS].sort());
  });

  for (const spell of KIT_CONSUMERS) {
    test(`${spell} — the kit's utility reaches the SHIPPED css`, async () => {
      const css = await shippedCss(spell);
      expect(new RegExp(`\\.${KIT_ONLY_UTILITY}\\s*\\{`).test(css)).toBe(true);
    });

    test(`${spell} — TOKEN RESOLUTION: every kit L0 token is DEFINED in the shipped css`, async () => {
      const css = await shippedCss(spell);
      const missing = (await kitTokens()).filter((t) => definitionOf(css, t) === null);
      // The real failure: the utility ships, the custom property does not, and
      // the colour silently does not apply.
      expect(missing).toEqual([]);
    });
  }

  test("OVERRIDE is demonstrated, not merely claimed — the two spells resolve a shared token differently", async () => {
    const values = await Promise.all(
      KIT_CONSUMERS.map(async (s) => definitionOf(await shippedCss(s), DIVERGENT_TOKEN)),
    );
    for (const v of values) expect(v).not.toBeNull();
    // Same component file, same token name, two different computed values —
    // that is the whole point of the L0/L2 split, and without this cell the
    // suite would pass on a kit nobody had actually overridden.
    expect(new Set(values).size).toBe(KIT_CONSUMERS.length);
  });
});
