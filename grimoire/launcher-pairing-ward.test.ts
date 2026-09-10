// ── THE LAUNCHER-PAIRING WARD (D43) ────────────────────────────────────────
//
// ⛔ WHAT THIS EXISTS FOR, IN ONE SENTENCE: **since D43 the set of backend
// entries `src/build.ts` emits is DERIVED from the launchers, so the pairing
// between a launcher and its artifact is now load-bearing for the BUILD and
// nothing checked it.**
//
// D43 replaced two hard-coded entry names (`backend/cli.ts`, `backend/server.ts`)
// with a rule: an entry is `src/<spell>/backend/X.ts` for which a launcher
// `plugins/spellbook/skills/<spell>/scripts/X.ts` exists. That rule is only as
// good as the pairing it reads, and the pairing has three ways to break, all of
// them EXIT-ZERO:
//
//   1. **A launcher imports an artifact the build does not emit.**
//      `scripts/X.ts` does `import { run } from "../dist/X.js"` and no
//      `dist/X.js` exists — because the backend module is named something else,
//      or was never relocated. Nothing type-checks a `.js` specifier into a
//      gitignored `dist/`; the spell dies at SPAWN time, in the caller's
//      terminal, on an installed plugin.
//   2. **An emitted backend artifact has no launcher.** Nothing spawns it. It
//      ships, it is committed under Contract 18, and it is dead weight that
//      reads like a shipped entry point.
//   3. **A launcher exists at the address the build derives from, and imports
//      something else.** This is D43's own failure mode and it did not exist
//      before D43: `src/<spell>/backend/X.ts` plus ANY `scripts/X.ts` makes
//      `X` an entry, so an UNPORTED spell's real `scripts/cli.ts` — a full CLI,
//      not a launcher — would silently promote a half-relocated
//      `backend/cli.ts` into the build and emit a `dist/cli.js` nobody imports.
//      mind-mapper, bounty, digestify and grapevine all ship real
//      `scripts/*.ts` sources today, so all four sit one misplaced file away
//      from this.
//
// ⛔ **BOTH POPULATIONS ARE DERIVED FROM THE TREE, NEVER HAND-KEPT** — the
// launcher side by READING every shipped `scripts/*.ts` for a `../dist/X.js`
// specifier, the artifact side by READING the emitted `dist/` off the DISK and
// subtracting the surface's own reference closure. **The artifact side now
// lives in `grimoire/lib/dist-artifacts.ts`**, shared with the spawn-path ward,
// which was carrying a hand-kept `cli.js`/`server.js` name list for the same
// question; the reasoning for the split travelled to the module with it. Neither is a list, and
// neither is computed from the other; cell C is where `src/build.ts`'s
// derivation is checked against both, which is the only reason a check of a
// derivation is not a check of itself (D36 — a backstop computed from the
// predicate it backstops is not a backstop).
//
// ⛔ **AND D42 GOVERNS EVERY ROW.** A subject this ward NAMES and does not
// EXAMINE must produce a row that says "not looked at" — absence of a finding
// must never be spelled the same way as absence of a subject. Three such
// silences were available here and all three are now rows: a spell with no
// `dist/` at all (nothing to classify), a spell whose `dist/` has no
// `index.html` (no surface closure to subtract), and a `scripts/*.ts` the ward
// cannot read (`null`, never an empty import set).
//
// ⚠ THE DISK, NOT THE INDEX (D42, the third instance). All four remaining ports
// FIRST-EMIT their backend artifacts, so on the commit that ports them the
// artifact is on disk and not yet in the index. An index-derived population
// would name the spell and produce no row for it — which is the exact defect
// D42 repaired in three other instruments. Staging is `scripts/dist-check.ts`'s
// question, not this one.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backendEntryNames, buildableSpells } from "../src/build.ts";
import { classifyDist, distDirFor } from "./lib/dist-artifacts.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDirIn = (root: string) => join(root, "plugins", "spellbook", "skills");
const scriptsDirIn = (root: string, spell: string) => join(skillsDirIn(root), spell, "scripts");

/**
 * `../dist/X.js` specifiers in one shipped script, as the bare names `X`.
 *
 * ⛔ `null` MEANS THE INSTRUMENT COULD NOT READ THIS FILE — never an empty
 * array. That is `entry-points.ts` requirement 6 applied here: a launcher whose
 * text the ward failed to read and a launcher that imports nothing must not
 * answer the same thing, or an unreadable launcher becomes an exempt one.
 *
 * Matched by SPECIFIER, not by filename: the question is "what does this file
 * ask the runtime to load", and only the specifier answers it. A script that is
 * NOT a launcher (an unported spell's real `scripts/cli.ts`) simply yields no
 * specifier and drops out, which is the correct answer rather than an exclusion.
 *
 * ⛔ THE `from`/`import`/`require` ANCHOR IS EARNED, NOT DECORATION. The first
 * draft matched any quoted `../dist/X.js` anywhere in the file, and a launcher
 * IS "a comment block and two lines" (playbook B2) — every launcher in the
 * roster names its own artifact in that comment block. Driven: re-pointing
 * astrolabe's launcher at `../dist/serverX.js` left the comment's
 * `../dist/server.js` behind, the ward reported BOTH specifiers, and cell C's
 * "the launcher at the derived address does not import its artifact" arm — the
 * one failure mode D43 introduced — stayed GREEN on the strength of a comment.
 * Anchoring on the import form is what makes the prose inert; backticks are
 * excluded from the delimiter set for the same reason (prose quotes with them,
 * `biome` never emits them for a specifier).
 */
function distImports(abs: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  return [
    ...new Set(
      [
        ...text.matchAll(
          /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']\.\.\/dist\/([A-Za-z0-9._-]+)\.js["']/g,
        ),
      ].map((m) => m[1] as string),
    ),
  ].sort();
}

type LauncherImport = { file: string; entry: string };

/** Every `<spell>/scripts/*.ts` that imports a `dist/X.js`, one row per
 *  specifier. Tests are excluded: a `*.test.ts` naming the artifact is
 *  asserting about it, not spawning it. */
function launcherImports(
  root: string,
  spell: string,
): { imports: LauncherImport[]; unreadable: string[] } {
  const dir = scriptsDirIn(root, spell);
  const imports: LauncherImport[] = [];
  const unreadable: string[] = [];
  if (!existsSync(dir)) return { imports, unreadable };
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const abs = join(dir, f);
    const names = distImports(abs);
    if (names === null) {
      unreadable.push(relative(root, abs));
      continue;
    }
    for (const entry of names) imports.push({ file: f, entry });
  }
  return { imports, unreadable };
}

// The surface/backend split lives in `grimoire/lib/dist-artifacts.ts` — see that
// module for WHY it is derived from `index.html` rather than from the names
// (D36), and for the D42 shape of its answer (`null` is NOT LOOKED AT, never an
// empty set). It was extracted there when the spawn-path ward turned out to be
// answering the same question with a hand-kept list of two names.

/** The roster, from the tree: a name is a spell iff its deployed skill folder
 *  exists. The SAME criterion `thoth`'s ownership rule already uses, and the
 *  reason `src/kit/` and `src/build.ts` are not spells. */
const roster = (root: string): string[] =>
  existsSync(skillsDirIn(root))
    ? readdirSync(skillsDirIn(root), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];

type Row = {
  spell: string;
  imports: LauncherImport[];
  unreadable: string[];
  derived: string[];
  dist: ReturnType<typeof classifyDist>;
};

const rows: Row[] = roster(REPO_ROOT).map((spell) => ({
  spell,
  ...launcherImports(REPO_ROOT, spell),
  derived: backendEntryNames(spell),
  dist: classifyDist(spell, REPO_ROOT),
}));

/** One line per spell, printed by the coverage cell. This is the D42 surface:
 *  every spell in the roster appears, and a spell nothing could be measured on
 *  says so IN ITS ROW rather than by being missing from the output. */
function describeRow(r: Row): string {
  const launchers =
    r.imports.length > 0
      ? r.imports.map((i) => `${i.file}→dist/${i.entry}.js`).join(" ")
      : "no launcher imports dist";
  const dist = !r.dist.present
    ? "dist/ ABSENT — emitted artifacts NOT LOOKED AT"
    : !r.dist.hasIndex
      ? `dist/ has no index.html — no surface closure; all .js treated as backend: [${r.dist.backend?.join(", ") || "none"}]`
      : `surface=[${r.dist.surface?.join(", ") || "none"}] backend=[${r.dist.backend?.join(", ") || "none"}]`;
  const unread =
    r.unreadable.length > 0 ? ` UNREADABLE(NOT LOOKED AT)=[${r.unreadable.join(", ")}]` : "";
  return `  ${r.spell.padEnd(12)} derived=[${r.derived.join(", ") || "none"}]  ${launchers}  ${dist}${unread}`;
}

describe("launcher-pairing ward — a launcher and its built entry exist together, or neither does", () => {
  test("ZERO-GUARD — both populations are DERIVED, and neither is empty", () => {
    // Three separate emptinesses, because any one of them alone would make the
    // cells below vacuously green: no spells, no launcher importing a dist
    // artifact, no emitted backend artifact to pair with one.
    expect(roster(REPO_ROOT).length).toBeGreaterThan(0);
    expect(buildableSpells().length).toBeGreaterThan(0);
    expect(rows.flatMap((r) => r.imports).length).toBeGreaterThan(0);
    expect(rows.flatMap((r) => r.dist.backend ?? []).length).toBeGreaterThan(0);
  });

  test("COVERAGE — every spell in the roster gets a row, including the ones with nothing to look at", () => {
    console.warn(
      `launcher pairing across ${rows.length} spell(s):\n${rows.map(describeRow).join("\n")}`,
    );
    // The population line and the rows are the SAME list. A spell that is named
    // and not examined is what D42 exists to forbid, so the count is asserted
    // against the roster rather than against the rows that happened to produce
    // a finding.
    expect(rows.map((r) => r.spell)).toEqual(roster(REPO_ROOT));
    // An unreadable script is an instrument failure, not a clean spell.
    expect(rows.flatMap((r) => r.unreadable)).toEqual([]);
  });

  test("A · every launcher's `../dist/X.js` EXISTS on disk", () => {
    const missing: string[] = [];
    for (const r of rows) {
      for (const i of r.imports) {
        const abs = join(distDirFor(r.spell, REPO_ROOT), `${i.entry}.js`);
        if (!existsSync(abs)) {
          missing.push(
            `${r.spell}/scripts/${i.file} imports ../dist/${i.entry}.js — ${relative(REPO_ROOT, abs)} is NOT on disk`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("B · every emitted BACKEND artifact is imported by a launcher", () => {
    const orphans: string[] = [];
    for (const r of rows) {
      // `backend === null` is D42's NOT LOOKED AT — a spell with no `dist/`.
      // It is named as such by the coverage row above; there is no artifact to
      // pair, and treating the null as "no orphans" is exactly the silence the
      // shared helper's return shape exists to make impossible to write by
      // accident.
      if (!r.dist.present || r.dist.backend === null) continue;
      const wanted = new Set(r.imports.map((i) => `${i.entry}.js`));
      for (const f of r.dist.backend) {
        if (!wanted.has(f)) {
          orphans.push(
            `${r.spell}/dist/${f} is emitted and NOTHING under ${r.spell}/scripts/ imports it`,
          );
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  test("C · `src/build.ts`'s derived entry set agrees with the launchers and the artifacts", () => {
    // The two halves of D43's rule, checked against each other. `backendEntryNames`
    // derives from "does `scripts/X.ts` EXIST"; this cell derives from "does it
    // IMPORT `../dist/X.js`". Different predicates over the same file, which is
    // what makes this a backstop rather than a restatement (D36).
    const drift: string[] = [];
    for (const r of rows) {
      const imported = new Set(r.imports.map((i) => i.entry));
      for (const name of r.derived) {
        if (!imported.has(name)) {
          drift.push(
            `${r.spell}: build.ts derives entry "${name}" from ${r.spell}/scripts/${name}.ts, but that file does NOT import ../dist/${name}.js — the emitted artifact would be unreachable`,
          );
        }
        if (r.dist.present && r.dist.backend !== null && !r.dist.backend.includes(`${name}.js`)) {
          drift.push(
            `${r.spell}: build.ts derives entry "${name}" and no ${name}.js is on disk as a backend artifact`,
          );
        }
      }
      // And the reverse: a launcher asking for an artifact the build has no
      // source for. Its cell-A twin catches this once the artifact is missing;
      // this catches it while a STALE artifact is still sitting in dist/.
      for (const i of r.imports) {
        if (!r.derived.includes(i.entry)) {
          drift.push(
            `${r.spell}/scripts/${i.file} imports ../dist/${i.entry}.js, but build.ts derives no entry "${i.entry}" (no src/${r.spell}/backend/${i.entry}.ts)`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });

  test("CONTROL — the two enumerators DISCRIMINATE, against a tree this cell builds", () => {
    // The ruling `trackedBuildInputs` earned, applied here: a green ward proves
    // nothing about the enumerators unless they have been shown answering
    // DIFFERENTLY for worlds that differ. Four worlds, in one synthetic root:
    // a correctly paired spell, a launcher with no artifact, an artifact with
    // no launcher, and a spell with no dist/ at all.
    const root = mkdtempSync(join(tmpdir(), "launcher-pairing-control-"));
    const write = (p: string, s: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s);
    };
    const spellFile = (spell: string, rel: string, s: string) =>
      write(join(skillsDirIn(root), spell, rel), s);

    spellFile("paired", "scripts/cli.ts", 'import { run } from "../dist/cli.js";\n');
    spellFile("paired", "dist/cli.js", "// emitted\n");
    spellFile("paired", "dist/index.html", '<script src="./index-aaaa.js"></script>\n');
    spellFile("paired", "dist/index-aaaa.js", "// surface\n");

    spellFile("launcher-only", "scripts/cli.ts", 'import { run } from "../dist/cli.js";\n');
    spellFile("launcher-only", "dist/index.html", "<html></html>\n");

    spellFile("artifact-only", "scripts/cli.ts", "// a real CLI, not a launcher\n");
    spellFile("artifact-only", "dist/index.html", "<html></html>\n");
    spellFile("artifact-only", "dist/cli.js", "// emitted\n");

    spellFile("nothing-built", "scripts/cli.ts", 'import { run } from "../dist/cli.js";\n');

    expect(roster(root)).toEqual(["artifact-only", "launcher-only", "nothing-built", "paired"]);

    // Cell A's subject: an imported artifact that is or is not on disk.
    const onDisk = (spell: string, entry: string) =>
      existsSync(join(distDirFor(spell, root), `${entry}.js`));
    expect(launcherImports(root, "paired").imports).toEqual([{ file: "cli.ts", entry: "cli" }]);
    expect(onDisk("paired", "cli")).toBe(true);
    expect(launcherImports(root, "launcher-only").imports).toEqual([
      { file: "cli.ts", entry: "cli" },
    ]);
    expect(onDisk("launcher-only", "cli")).toBe(false); // ← cell A would RED
    expect(launcherImports(root, "artifact-only").imports).toEqual([]); // not a launcher
    expect(launcherImports(root, "nothing-built").imports).toEqual([
      { file: "cli.ts", entry: "cli" },
    ]);
    expect(onDisk("nothing-built", "cli")).toBe(false); // ← cell A would RED

    // Cell B's subject: the surface/backend split, and the NOT-LOOKED-AT row.
    expect(classifyDist("paired", root)).toEqual({
      present: true,
      hasIndex: true,
      surface: ["index-aaaa.js"],
      backend: ["cli.js"],
    });
    expect(classifyDist("artifact-only", root).backend).toEqual(["cli.js"]); // ← cell B would RED
    expect(classifyDist("launcher-only", root).backend).toEqual([]);
    expect(classifyDist("nothing-built", root)).toEqual({
      present: false,
      hasIndex: false,
      // ⛔ `null`, NOT `[]` — the D42 shape, now enforced by the shared helper's
      // type rather than by each caller remembering to check `present` first.
      surface: null,
      backend: null,
    });
    // ⛔ AND THE EMPTY MEASUREMENT MUST NOT LOOK LIKE THE CLEAN ONE. Both
    // `launcher-only` and `nothing-built` contribute an empty backend set; only
    // one of them was LOOKED AT, and the row says which.
    const rowOf = (spell: string): Row => ({
      spell,
      ...launcherImports(root, spell),
      derived: [],
      dist: classifyDist(spell, root),
    });
    expect(describeRow(rowOf("nothing-built"))).toContain("NOT LOOKED AT");
    expect(describeRow(rowOf("launcher-only"))).not.toContain("NOT LOOKED AT");
    expect(describeRow(rowOf("launcher-only"))).toContain("backend=[none]");

    // `null` is not `0`: an unreadable script must not read as an empty import
    // set. A directory at a `.ts` path is the cheapest unreadable file.
    mkdirSync(join(scriptsDirIn(root, "paired"), "broken.ts"), { recursive: true });
    expect(distImports(join(scriptsDirIn(root, "paired"), "broken.ts"))).toBeNull();
    expect(launcherImports(root, "paired").unreadable).toEqual([
      "plugins/spellbook/skills/paired/scripts/broken.ts",
    ]);

    rmSync(root, { recursive: true, force: true });
  });
});
