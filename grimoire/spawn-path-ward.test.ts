// ── THE SPAWN-PATH WARD (D15, ruled by Cole; brief-1b A2) ───────────────────
//
// ⛔ WHAT THIS EXISTS FOR, IN ONE SENTENCE: **bundling changes what a module
// knows about its own location, and every symptom of getting that wrong is
// quiet and exit-zero.**
//
// Phase 1b chapter 1 produced two defects of exactly one class:
//
//   1. `magpie/scripts/backend.ts` resolved `remove.py` as
//      `join(import.meta.dir, "remove.py")`. Bundled into `dist/cli.js`,
//      `import.meta.dir` became `dist/` and `remove.py` stayed in `scripts/`.
//      **Dead for eight days in the SHIPPED plugin**, answering
//      `{"ok":true,...,"failed":1}` at exit 0 the whole time.
//   2. The relocated daemon had no entry, because `import.meta.main` is false
//      in a module the launcher imports — it booted, served nothing, exited 0.
//
// ⛔ **NOTHING IN THIS REPO COULD SEE EITHER ONE.** The gate type-checks, the
// wards text-scan, the unit tests import — and a `join(import.meta.dir, …)`
// pointing at empty air passes all three, because the path is a STRING until
// something opens or spawns it. Only running the verb found it. This ward is
// the instrument that closes that gap: it resolves the anchor arithmetic the
// way the RUNTIME will, from the EMITTED file's own directory, and asserts the
// file is there.
//
// ⛔ **THE POPULATION IS DERIVED FROM THE TREE, NEVER HAND-KEPT.** It reads
// `buildableSpells()` — the same function `src/build.ts` uses to decide what to
// build, and the same one `scripts/dist-check.ts` uses for its denominator — so
// a spell that arrives in the build arrives in this ward on the same commit.
// The alternative is the defect `grimoire/daemon-lifecycle-ward.test.ts`
// already had: a list that goes quietly blind on exactly the spell that lands
// next. Two spells ship a built backend today; the roll puts eight here.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildableSpells } from "../src/build.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = join(REPO_ROOT, "plugins", "spellbook");
const SKILLS_ROOT = join(PLUGIN_ROOT, "skills");

/** Where a spell's build emits — the same expression `src/build.ts` uses. */
const distDirFor = (spell: string) => join(SKILLS_ROOT, spell, "dist");

/** The TRACKED emitted JavaScript for one spell. Tracked, because an untracked
 *  file in `dist/` is a local build artifact and not something that ships —
 *  `dist-check` draws the same line for the same reason. */
function emittedJs(spell: string): string[] {
  const dir = distDirFor(spell);
  if (!existsSync(dir)) return [];
  return (
    execFileSync("git", ["-C", REPO_ROOT, "ls-files", relative(REPO_ROOT, dir)], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((f) => f.endsWith(".js"))
      .map((f) => join(REPO_ROOT, f))
      // ⚠ THE INDEX AND THE DISK DIVERGE DURING A PORT, and this ward used to
      // CRASH on that rather than report it. A rebuild replaces a hashed chunk;
      // until the result is staged, `git ls-files` still names the old chunk and
      // `readFileSync` throws ENOENT from inside `pinnedPaths` — three cells fail
      // with a stack trace that says nothing about paths. Playbook Gotcha 4, in a
      // new file. A tracked-but-absent emitted file is not this ward's subject, so
      // it is skipped; `dist-check`'s reproduction arm is what has an opinion about
      // it, and the zero-guard below still refuses an empty population.
      .filter((f) => existsSync(f))
  );
}

/** The emitted files a spell's BACKEND produces — the ones whose anchor
 *  arithmetic this ward exists to check. A surface chunk is emitted too and
 *  pins nothing, so it must not count toward coverage. */
const isBackendArtifact = (abs: string): boolean =>
  abs.endsWith("/cli.js") || abs.endsWith("/server.js");

type Pin = { file: string; line: number; expr: string; resolved: string };

// `join(X, "a", "b")` where X is an anchor we have resolved and every other
// argument is a string literal. A non-literal argument (`join(DIST_DIR, rel)`)
// is deliberately NOT a candidate: it is not a pinned path, it is a router.
const JOIN_CALL =
  /\bjoin\d*\(\s*([A-Za-z_$][\w$]*|import\.meta\.dir)\s*,\s*((?:"[^"]*"\s*,?\s*)+)\)/g;
// `var X = import.meta.dir` and `var X = dirname(fileURLToPath(import.meta.url))`
// — the two ways a bundled module asks where it is. Bun's bundler renames the
// imported helpers (`dirname2`, `join3`), hence the digit-tolerant names.
//
// ⛔ AND THE CALLEE MAY BE QUALIFIED. `Bun.fileURLToPath` is the same function
// under a namespace, and glamour's CLI has always written it that way. The first
// draft of this pattern required a BARE identifier, so glamour's `SCRIPT_DIR` was
// never registered as an anchor, so every pin computed from it — `SERVER_SCRIPT`,
// `SKILL_ROOT`, `DIST_DIR`, `SURFACE_CWD` — was silently dropped, and this ward
// passed 5/0 over a `dist/cli.js` that spawned a daemon at `dist/server.ts`, a
// path that does not exist. Measured in Phase 2, on the first spell this ward had
// never seen: it printed EIGHT pins, none of them glamour's, and reported green.
// **That is the ward's own failure mode — a regex that recognises the two spellings
// it was written against and reports silence for a third.** The optional
// `(?:[A-Za-z_$][\w$]*\d*\s*\.\s*)?` prefix is the repair; the coverage cell below
// is the instrument that would have made it loud without anyone reading the regex.
const QUALIFIER = String.raw`(?:[A-Za-z_$][\w$]*\d*\s*\.\s*)?`;
const ANCHOR_DIR = /\b(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*import\.meta\.dir\s*;/;
const ANCHOR_URL = new RegExp(
  String.raw`\b(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*${QUALIFIER}dirname\d*\(\s*${QUALIFIER}fileURLToPath\d*\(\s*import\.meta\.url\s*\)\s*\)\s*;`,
);
const ASSIGNED_JOIN = /\b(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(join\d*\(.*)$/;

const literals = (args: string): string[] =>
  [...args.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);

/**
 * Every path this emitted file pins, resolved the way the RUNTIME will resolve
 * it: from the emitted file's own directory.
 *
 * ⚠ WHAT IT CANNOT SEE, SAID OUT LOUD. A path built by concatenation, from a
 * variable that is not an anchor, or across a function boundary is invisible
 * here — the same blind spot `import-graph.ts` declares for specifiers. This
 * ward is not a proof that every runtime path is good; it is the instrument for
 * the ANCHOR-ARITHMETIC class, which is the class that bundling breaks and the
 * class both of chapter 1's defects belonged to.
 */
function pinnedPaths(absFile: string): Pin[] {
  const here = dirname(absFile);
  const anchors = new Map<string, string>();
  const out: Pin[] = [];

  const resolveCall = (anchor: string, args: string): string | null => {
    const base = anchor === "import.meta.dir" ? here : anchors.get(anchor);
    if (base === undefined) return null;
    return join(base, ...literals(args));
  };

  const lines = readFileSync(absFile, "utf8").split("\n");
  lines.forEach((line, i) => {
    const dir = ANCHOR_DIR.exec(line) ?? ANCHOR_URL.exec(line);
    if (dir?.[1]) {
      anchors.set(dir[1], here);
      return;
    }
    // An assignment is recorded as an anchor AND reported as a pin: `SKILL_ROOT`
    // is both the base of later arithmetic and, for `SERVER_SCRIPT`, a spawn
    // target in its own right.
    const assigned = ASSIGNED_JOIN.exec(line);
    for (const m of line.matchAll(JOIN_CALL)) {
      const resolved = resolveCall(m[1] as string, m[2] as string);
      if (resolved === null) continue;
      if (assigned?.[1] && m.index === (assigned.index ?? -1) + assigned[0].indexOf("join")) {
        anchors.set(assigned[1], resolved);
      }
      out.push({
        file: relative(REPO_ROOT, absFile),
        line: i + 1,
        expr: m[0],
        resolved,
      });
    }
  });
  return out;
}

/** A pin that must resolve to a real FILE: it names a file (it has an
 *  extension) and it lands inside WHAT THE MARKETPLACE COPIES.
 *
 *  ⚠ **THE BOUNDARY IS THE PLUGIN, NOT THE SKILL, AND THE TREE IS WHAT SAID
 *  SO.** The first draft drew it at `plugins/…/skills/<spell>/` and the scanner
 *  immediately turned up a pin both CLIs make one level above it —
 *  `.claude-plugin/plugin.json`, read for the version they report. That is a
 *  shipped sibling by every criterion this ward has, and a skill-scoped
 *  boundary would have exempted it. Contract 3's boundary is the plugin.
 *
 *  ⚠ Outside the plugin the ward cannot assert anything from this repo:
 *  `SURFACE_CWD` points at `src/<spell>/`, which exists HERE and does not exist
 *  at the destination — a marketplace clone ships no `src/`. Asserting it would
 *  assert the opposite of Contract 4. Those pins are enumerated and PINNED by
 *  the cell below instead, so a new one is loud rather than silently exempt. */
const isShippedFile = (p: Pin): boolean =>
  p.resolved.startsWith(`${PLUGIN_ROOT}/`) &&
  /\.[a-z0-9]+$/i.test(p.resolved.split("/").pop() ?? "");

const spells = buildableSpells().filter((s) => emittedJs(s).length > 0);

describe("spawn-path ward — every path a BUILT backend pins resolves from the EMITTED location", () => {
  test("ZERO-GUARD — the population is DERIVED, and it is not empty", () => {
    // `buildableSpells()` is `src/build.ts`'s own function. If the build learns
    // a spell, this ward learns it on the same commit; there is no list here to
    // forget. The zero-guard is what stops "no spell emits a backend yet" from
    // reading as "every emitted backend is correct".
    expect(buildableSpells().length).toBeGreaterThan(0);
    expect(spells.length).toBeGreaterThan(0);
    const files = spells.flatMap(emittedJs);
    expect(files.length).toBeGreaterThan(0);
    console.warn(
      `\n  SPAWN-PATH WARD — ${files.length} emitted file(s) across ${spells.length} spell(s): ${spells.join(", ")}\n`,
    );
  });

  test("the scanner actually resolves anchors (calibration on the REAL tree)", () => {
    // A scanner that matched nothing would make the cell below pass for the
    // wrong reason — the vacuity failure this repo has been bitten by twice.
    const found = spells.flatMap((s) => emittedJs(s).flatMap(pinnedPaths));
    expect(found.length).toBeGreaterThan(3);
  });

  test("⛔ COVERAGE, NOT POPULATION — every emitted backend that DECLARES an anchor yields at least one pin", () => {
    // ⛔ THIS CELL EXISTS BECAUSE THE WARD WENT SILENTLY BLIND ON THE FIRST
    // SPELL IT HAD NEVER SEEN. Phase 1b's own closing finding was that a ward
    // whose POPULATION is derived can still have ZERO COVERAGE of the thing it
    // was written for, and that population and coverage are different
    // measurements — "print both". Phase 2 paid for the half that was only
    // printed: glamour arrived in the population automatically, contributed no
    // pins because its anchor is written `Bun.fileURLToPath`, and the ward
    // reported green over a `dist/cli.js` spawning a nonexistent
    // `dist/server.ts`. Printing would not have caught it; ASSERTING does.
    //
    // The predicate is deliberately narrow and mechanical: a file that declares
    // an anchor — `import.meta.dir`, or a (possibly qualified) dirname/
    // fileURLToPath pair — is a file that asks where it is, and a file that asks
    // where it is and then pins NOTHING is either a scanner that failed to read
    // it or a backend that has genuinely stopped resolving siblings. Both are
    // worth a human. A backend with no anchor at all is exempt and stays exempt.
    const blind: string[] = [];
    const coverage: string[] = [];
    for (const spell of spells) {
      for (const file of emittedJs(spell).filter(isBackendArtifact)) {
        const text = readFileSync(file, "utf8");
        const declaresAnchor = text
          .split("\n")
          .some((line) => ANCHOR_DIR.test(line) || ANCHOR_URL.test(line));
        const pins = pinnedPaths(file).length;
        coverage.push(
          `${relative(REPO_ROOT, file)}  anchor=${declaresAnchor ? "yes" : "no "}  pins=${pins}`,
        );
        if (declaresAnchor && pins === 0) blind.push(relative(REPO_ROOT, file));
      }
    }
    console.warn(`\n  SPAWN-PATH WARD — coverage:\n    ${coverage.join("\n    ")}\n`);
    expect(blind).toEqual([]);
  });

  test("⛔ EVERY SHIPPED PIN RESOLVES — this is the cell `remove.py` would have reddened", () => {
    const missing: string[] = [];
    const inventory: string[] = [];
    for (const spell of spells) {
      for (const file of emittedJs(spell)) {
        for (const pin of pinnedPaths(file)) {
          if (!isShippedFile(pin)) continue;
          const rel = relative(REPO_ROOT, pin.resolved);
          inventory.push(`${pin.file}:${pin.line}  ${pin.expr}  ->  ${rel}`);
          if (!existsSync(pin.resolved) || !statSync(pin.resolved).isFile()) {
            missing.push(`${pin.file}:${pin.line} -> ${rel} (${pin.expr})`);
          }
        }
      }
    }
    // CONTEXT, printed so a human can see what is actually governed — never
    // compared, so this ward does not need editing when a path legitimately
    // moves. The comparison that matters is the one below it.
    console.warn(
      `\n  SPAWN-PATH WARD — shipped pins, as found today:\n    ${inventory.join("\n    ")}\n`,
    );
    expect(missing).toEqual([]);
  });

  test("a pin that leaves the skill folder is ENUMERATED, not silently exempt", () => {
    // These cannot be asserted from this repo (see `isShippedFile`). Pinning the
    // SET is what stops the exemption growing quietly: a new escape fails here
    // and has to be justified, which is ward 1a's discipline applied to a path
    // instead of to a specifier.
    const escapes = new Set<string>();
    for (const spell of spells) {
      for (const file of emittedJs(spell)) {
        for (const pin of pinnedPaths(file)) {
          if (pin.resolved.startsWith(`${PLUGIN_ROOT}/`)) continue;
          escapes.add(`${pin.file} -> ${relative(REPO_ROOT, pin.resolved)}`);
        }
      }
    }
    expect([...escapes].sort()).toEqual([
      "plugins/spellbook/skills/astrolabe/dist/cli.js -> src/astrolabe",
      // glamour's `SURFACE_CWD`, the dev-mode daemon cwd Contract 5 pins. It
      // arrived here in Phase 2 — and note it arrived only once the anchor
      // pattern learned `Bun.fileURLToPath`: before that this cell was green
      // because it could not see the escape at all, which is the same blindness
      // the coverage cell above now asserts against.
      "plugins/spellbook/skills/glamour/dist/cli.js -> src/glamour",
      "plugins/spellbook/skills/magpie/dist/cli.js -> src/magpie",
    ]);
  });

  test("CALIBRATION — the mechanism reddens on a synthetic emitted file", () => {
    // ⛔ CALIBRATED ON A SYNTHETIC, NOT ON THE ROSTER. Breaking a real path to
    // prove the ward works means committing a broken artifact for the length of
    // the experiment; minting the subject is this repo's ruling for exactly that
    // situation (ward 1b's synthetic emitted root). The real mutation was ALSO
    // driven by hand at authoring time — `remove.py` re-broken in `dist/cli.js`,
    // ward red, restored — and the drive is in the phase journal.
    // The synthetic tree mirrors a real skill: an emitted `dist/` beside a
    // `scripts/` holding the spawn target, which is the layout the whole
    // up-and-back-down convention exists for.
    const root = mkdtempSync(join(tmpdir(), "spawn-path-ward-"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "scripts"));
    const file = join(root, "dist", "cli.js");
    writeFileSync(
      file,
      [
        "var SCRIPT_DIR = import.meta.dir;",
        'var SKILL_ROOT = join(SCRIPT_DIR, "..");',
        'var GOOD = join(SCRIPT_DIR, "there.py");',
        'var BAD = join(import.meta.dir, "nowhere.py");',
        'var SPAWN = join(SKILL_ROOT, "scripts", "server.ts");',
        "var ROUTED = join(SKILL_ROOT, someVariable);",
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "dist", "there.py"), "# a sibling that is really there\n");
    writeFileSync(join(root, "scripts", "server.ts"), "// the spawn target\n");

    const pins = pinnedPaths(file);
    const byName = (n: string) => pins.find((p) => p.expr.includes(n));

    // The anchor arithmetic is EVALUATED, not merely matched.
    expect(byName("there.py")?.resolved).toBe(join(root, "dist", "there.py"));
    expect(byName("nowhere.py")?.resolved).toBe(join(root, "dist", "nowhere.py"));
    // ⛔ UP AND BACK DOWN RESOLVES THROUGH A NAMED ANCHOR — the shape every
    // correct path in this repo uses, and the shape `remove.py` did not use.
    expect(byName("server.ts")?.resolved).toBe(join(root, "scripts", "server.ts"));
    // A non-literal argument is not a pin — it is a router, not a path.
    expect(pins.some((p) => p.expr.includes("someVariable"))).toBe(false);

    // And the verdict: exactly the absent one is missing. This is the assertion
    // that would have gone red on `remove.py` for eight days.
    const missing = pins.filter((p) => /\.[a-z0-9]+$/i.test(p.resolved) && !existsSync(p.resolved));
    expect(missing.map((p) => p.resolved.replace(root, "<tmp>"))).toEqual([
      "<tmp>/dist/nowhere.py",
    ]);
  });
});
