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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildableSpells } from "../src/build.ts";
import { classifyDist, distDirFor, isBackendArtifact } from "./lib/dist-artifacts.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = join(REPO_ROOT, "plugins", "spellbook");

// `distDirFor` — where a spell's build emits, the same expression `src/build.ts`
// uses — comes from `lib/dist-artifacts.ts` along with the backend/surface
// split. Its `root` parameter is what lets the calibration cells below drive
// these enumerators against a throwaway repo whose index and disk THEY chose,
// rather than proving only that they can read this one.

/** One emitted `.js` file, and whether the INDEX has it yet. */
type Emitted = { abs: string; staged: boolean };

/**
 * The emitted JavaScript for one spell — **READ FROM THE DISK, then labelled
 * against the index.**
 *
 * ⛔ THIS FUNCTION READ `git ls-files` AND THAT WAS THE THIRD INSTANCE OF ONE
 * DEFECT (D42). The population line is derived from `buildableSpells()`, so a
 * spell arrives in it on the commit that relocates it — but its emitted backend
 * arrives in `dist/` from the BUILD, and `dist/` is gitignored with a hand-kept
 * un-ignore list, so on the commit that FIRST EMITS a backend the artifact is on
 * disk and not in the index. The ward then printed that spell in its population
 * line and produced **no coverage row for it at all** — not `pins=0`, no row.
 * Driven: a corrupted pin (`join(SCRIPT_DIR, "..", "NOWHERE", "server.ts")`) in
 * an on-disk-but-untracked `bounty/dist/cli.js` produced **not one new failure**,
 * 7 pass / 0 fail, while the population line said `across 8 spell(s): … bounty …`.
 * A missing row reads as "nothing to cover". It meant "not looked at".
 *
 * ⛔ AND ALL FOUR REMAINING PORTS PASS THROUGH THAT WINDOW — bounty, digestify,
 * grapevine and mind-mapper each first-emit their backend artifacts.
 *
 * **THE DISK IS THE HONEST SOURCE FOR THIS WARD'S QUESTION.** The question is
 * "does the anchor arithmetic in the artifact the build just produced resolve?",
 * and the artifact the build just produced is on disk whether or not anyone has
 * run `git add` yet. Staging is a fact about shipping, which is `dist-check`'s
 * question, not this one.
 *
 * ⚠ THE FALSE-POSITIVE THIS COULD HAVE CREATED, AND WHY IT DOES NOT.
 * "Read the disk" invites stale build leftovers into the population. It cannot
 * accumulate them: `src/build.ts` `rm`s each `dist/` before every build, so the
 * disk holds exactly the last build's output and nothing older, and `bun run
 * gate` builds before it tests. A leftover from a foreign checkout, examined by
 * a bare `bun test` with no build, would produce a RED naming a path — loud and
 * one `bun run build` from resolved — which is the direction this repo prefers
 * to be wrong in.
 *
 * ⚠ AN INDEX-ONLY FILE (tracked, absent from disk) drops out here, as it always
 * did — a rebuild renames a hashed chunk and the old name lingers in the index
 * until staged. Before, reading it threw ENOENT from inside `pinnedPaths` and
 * three cells failed with a stack trace about nothing (Playbook Gotcha 4). It is
 * not this ward's subject; `dist-check`'s ARM 2 is what has an opinion about it.
 * It is now REPORTED rather than merely skipped — see the population cell.
 */
function emittedFiles(spell: string, root: string = REPO_ROOT): Emitted[] {
  const dir = distDirFor(spell, root);
  if (!existsSync(dir)) return [];
  const staged = new Set(
    execFileSync("git", ["-C", root, "ls-files", relative(root, dir)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((f) => join(root, f)),
  );
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, f))
    .sort()
    .map((abs) => ({ abs, staged: staged.has(abs) }));
}

/** Tracked emitted `.js` the DISK does not have — the other side of the
 *  divergence, reported so it cannot be confused with "there is nothing here". */
function indexOnlyEmitted(spell: string, root: string = REPO_ROOT): string[] {
  const dir = distDirFor(spell, root);
  if (!existsSync(dir)) return [];
  return execFileSync("git", ["-C", root, "ls-files", relative(root, dir)], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(root, f))
    .filter((f) => !existsSync(f));
}

const emittedJs = (spell: string): string[] => emittedFiles(spell).map((e) => e.abs);

// ⛔ WHICH EMITTED FILES ARE THE BACKEND'S — `isBackendArtifact`, IMPORTED, NOT
// WRITTEN HERE. This ward carried its own answer until D43's follow-through:
//
//     const isBackendArtifact = (abs) =>
//       abs.endsWith("/cli.js") || abs.endsWith("/server.js");
//
// — a hand-kept list of two names, which is the exact hard-coding D43 had just
// removed from `src/build.ts`, surviving one instrument over. It was correct
// today for the wrong reason (the derived entry set happens to be `cli` +
// `server` for all four built spells) and went **silently blind** on bounty's
// `join.js`, digestify's `review.js` and grapevine's `daemon.js` the day they
// land: an unrecognised backend artifact simply produces NO COVERAGE ROW, which
// is the D42 silence in the very cell written to end it. The shared derivation
// in `lib/dist-artifacts.ts` reads the split off `index.html`'s reference
// closure instead — see that module for the reasoning, which travelled with it.

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

// ⛔ THE INGREDIENTS OF LOCATION-ANCHORING — the backstop for the two patterns
// above, and it is deliberately NOT COMPUTED FROM THEM.
//
// D27 added a coverage cell whose subject was "a file that declares an anchor
// must yield a pin", and computed "declares an anchor" with `ANCHOR_DIR ||
// ANCHOR_URL` — **the same two regexes the cell exists to backstop.** A
// spelling neither regex reads therefore made the file EXEMPT rather than LOUD,
// which is the exact failure the cell was written to end. Four spellings were
// driven against it, each leaving a `dist/cli.js` that spawns a nonexistent
// `dist/server.ts`, and all four passed 6/0:
//
//   var __fileName = Bun.fileURLToPath(import.meta.url); var SCRIPT_DIR = dirname(__fileName);
//   var SCRIPT_DIR = import.meta.dirname;
//   var SCRIPT_DIR = path.posix.dirname(node_url.fileURLToPath(import.meta.url));
//   var SCRIPT_DIR = dirname(fileURLToPath(new URL(import.meta.url)));
//
// The first is what esbuild/Bun emit for a `__filename` shim; the second is a
// real Bun/Node API. Neither is exotic.
//
// **A backstop computed from the same predicate it backstops is not a
// backstop.** So this pattern is written at a level the anchor patterns cannot
// reach past: a module CANNOT ask where it is without naming one of
// `import.meta.url`, `import.meta.dir`, `import.meta.dirname`, or
// `fileURLToPath` — under any qualifier, in any arrangement. Those four are the
// ingredients. The cell below requires that every line carrying one be READ:
// either recognised as an anchor, or itself yielding a pin. A line that carries
// an ingredient and is neither is a spelling this ward cannot read, and it goes
// RED naming the line rather than passing in silence.
//
// ⛔ AND THE FIRST DRAFT OF THIS LIST WAS BROKEN BY ITS OWN AUTHOR, which is the
// only reason to trust the second. A fifth spelling was hunted for immediately
// after the four above went red, and one was found: `var SCRIPT_DIR =
// dirname(__filename);` — the CJS pair. It names none of the four ingredients,
// so it scored `ingredients=0 anchor=no pins=0` and the cell was silent. (The
// escape-enumeration cell below happened to red on it, because glamour has an
// escape that then vanished — incidental, and a spell with no escape would have
// been fully green.) `__filename`/`__dirname` and `Bun.main` are therefore
// ingredients too: none appears in ANY of the eight emitted artifacts today, so
// the cost of naming them is zero and the cost of omitting them was a hole.
// `process.argv[1]` is the known REMAINING hole and is deliberately NOT here —
// a CLI bundle reads `process.argv` for ordinary arg parsing, so it would red
// every artifact. Anchoring off the entry path is wrong in a bundle a launcher
// imports anyway, and B3 is what says so.
const ANCHOR_INGREDIENT =
  /import\.meta\.(?:url|dir|dirname)\b|\bfileURLToPath\d*\s*\(|\b__(?:dirname|filename)\b|\bBun\.main\b/;
// A line that merely BINDS the helper anchors nothing — `import { fileURLToPath }
// from "url";` is Bun's own emitted preamble in five of six artifacts today. It
// names no `import.meta.*` and calls nothing, so the ingredient pattern above
// already misses it; this is belt-and-braces for a `require`-shaped emit.
const HELPER_BINDING = /^\s*import\s|=\s*(?:require|__toESM|__require)\s*\(/;

/** Every line of `text` that carries a location-anchoring ingredient and is
 *  READ BY NOBODY — neither recognised as an anchor nor yielding a pin of its
 *  own. `pinnedLines` is 1-based, as `pinnedPaths` reports. Returned as
 *  `line:text` so the caller can name it; naming the line is the whole point,
 *  because the next agent's repair is to teach `ANCHOR_DIR`/`ANCHOR_URL` the
 *  spelling and it cannot do that without seeing it. */
function unreadAnchorLines(text: string, pinnedLines: Set<number>): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (!ANCHOR_INGREDIENT.test(line) || HELPER_BINDING.test(line)) return;
    if (ANCHOR_DIR.test(line) || ANCHOR_URL.test(line)) return;
    if (pinnedLines.has(i + 1)) return;
    out.push(`${i + 1}:${line.trim()}`);
  });
  return out;
}

/** Does any line of `text` yield an anchor either pattern can READ? */
const hasReadableAnchor = (text: string): boolean =>
  text.split("\n").some((line) => ANCHOR_DIR.test(line) || ANCHOR_URL.test(line));

/** Does `text` ask where it is at all? A backend that anchors nothing is exempt
 *  from the coverage cell, and must stay exempt. */
const asksWhereItIs = (text: string): boolean =>
  text.split("\n").some((line) => ANCHOR_INGREDIENT.test(line) && !HELPER_BINDING.test(line));

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
    const files = spells.flatMap((s) => emittedFiles(s));
    expect(files.length).toBeGreaterThan(0);

    // ⛔ A SPELL THIS WARD NAMES BUT CANNOT SEE MUST SAY SO. Before D42 the line
    // below printed `across 8 spell(s)` while contributing no row at all for the
    // spell whose artifact was on disk and not in the index — a silence that read
    // as "nothing to cover". The population is now the DISK, so there is no such
    // spell; what remains is the reverse divergence, and it is PRINTED rather
    // than merely skipped.
    const unstaged = files.filter((f) => !f.staged).map((f) => relative(REPO_ROOT, f.abs));
    const indexOnly = spells.flatMap((s) => indexOnlyEmitted(s)).map((f) => relative(REPO_ROOT, f));
    console.warn(
      [
        "",
        `  SPAWN-PATH WARD — ${files.length} emitted file(s) across ${spells.length} spell(s): ${spells.join(", ")}`,
        `  read from the DISK · ${files.length - unstaged.length} staged · ${unstaged.length} NOT STAGED (examined anyway — staging is dist-check's question)`,
        ...unstaged.map((f) => `      NOT STAGED  ${f}`),
        ...indexOnly.map(
          (f) =>
            `      INDEX-ONLY, absent from disk — not looked at (dist-check ARM 2 owns it)  ${f}`,
        ),
        "",
      ].join("\n"),
    );
  });

  test("the scanner actually resolves anchors (calibration on the REAL tree)", () => {
    // A scanner that matched nothing would make the cell below pass for the
    // wrong reason — the vacuity failure this repo has been bitten by twice.
    const found = spells.flatMap((s) => emittedJs(s).flatMap(pinnedPaths));
    expect(found.length).toBeGreaterThan(3);
  });

  test("⛔ COVERAGE, NOT POPULATION — a backend that ASKS WHERE IT IS must be READ, not exempted", () => {
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
    // ⛔ AND THE FIRST ASSERTION WAS ITSELF THE SAME BUG ONE LEVEL UP (D36). It
    // gated on "declares an anchor", computed with `ANCHOR_DIR || ANCHOR_URL` —
    // the two regexes it exists to backstop — so a THIRD spelling was exempt
    // rather than loud, and four real ones were driven that proved it. The gate
    // is now the INGREDIENTS (see `ANCHOR_INGREDIENT`), which no location-aware
    // module can avoid naming, and the requirement is two-part:
    //
    //   1. every ingredient-bearing line is READ — recognised as an anchor, or
    //      yielding a pin of its own;
    //   2. a file that carries any ingredient yields AT LEAST ONE pin.
    //
    // A backend that legitimately anchors nothing carries no ingredient, is
    // exempt, and stays exempt.
    const unread: string[] = [];
    const blind: string[] = [];
    const notLookedAt: string[] = [];
    const coverage: string[] = [];
    for (const spell of spells) {
      // ⛔ `null` FROM THE SPLIT IS "NOT LOOKED AT", NEVER "NOT A BACKEND". It
      // is unreachable by construction here — `spells` is filtered to those
      // whose `dist/` yielded emitted `.js` off the disk — so treating it as
      // `false` would cost nothing today and be a silence the day it is
      // reachable. It goes in a list that is asserted empty.
      const backendOf = (abs: string): boolean => {
        const verdict = isBackendArtifact(abs);
        if (verdict === null) {
          notLookedAt.push(`${relative(REPO_ROOT, abs)} — dist/ vanished mid-run, NOT CLASSIFIED`);
          return false;
        }
        return verdict;
      };
      for (const emitted of emittedFiles(spell).filter((e) => backendOf(e.abs))) {
        const file = emitted.abs;
        const rel = relative(REPO_ROOT, file);
        const text = readFileSync(file, "utf8");
        const pins = pinnedPaths(file);
        const anchoring = asksWhereItIs(text);
        for (const hit of unreadAnchorLines(text, new Set(pins.map((p) => p.line)))) {
          unread.push(`${rel}:${hit.replace(":", "  UNREAD ANCHOR SPELLING  ")}`);
        }
        coverage.push(
          `${rel}  ${emitted.staged ? "staged    " : "NOT STAGED"}  anchors=${
            anchoring ? "yes" : "no "
          }  anchor-read=${hasReadableAnchor(text) ? "yes" : "no "}  pins=${pins.length}`,
        );
        if (anchoring && pins.length === 0) blind.push(rel);
      }
    }
    console.warn(`\n  SPAWN-PATH WARD — coverage:\n    ${coverage.join("\n    ")}\n`);
    expect(notLookedAt).toEqual([]);
    expect(unread).toEqual([]);
    expect(blind).toEqual([]);
    // ⛔ AND THE COVERAGE SET IS NOT EMPTY. The split is now DERIVED, so a
    // derivation that answered "no backend artifacts anywhere" would empty this
    // cell's population and leave it green — the vacuity failure, one level up
    // from the one the cell itself asserts against.
    expect(coverage.length).toBeGreaterThan(0);
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
      // bounty's `SURFACE_CWD` — the FOURTH instance of this one escape, and
      // the first that was PREDICTED IN WRITING before the spell was touched
      // (Phase 4's brief said "`dist/` and `scripts/` sit at the same depth, so
      // it should survive — assert it rather than reasoning about it"). This
      // row IS that assertion: the ward resolved the five-level climb from the
      // EMITTED location and it lands on `src/bounty`, the same directory the
      // pre-port source computed from `scripts/`.
      "plugins/spellbook/skills/bounty/dist/cli.js -> src/bounty",
      // digestify's `DEV_SURFACE_CWD` — the FIFTH instance of this one escape,
      // and the first that is NOT in a `cli.js`, because digestify has no
      // `cli.ts`: `review.js` is its whole entry set. The escape is also the
      // first that no spawner pins. Every other spell's CLI sets this directory
      // as the daemon's cwd; digestify's entry IS the process the agent runs, so
      // the pin exists only to be NAMED in a refusal — the daemon checks its own
      // cwd for a bunfig that loads the Tailwind plugin and exits 2 otherwise.
      // ⚠ AND THAT REFUSAL'S MESSAGE IS COMPUTED FROM THIS ARITHMETIC, which is
      // why the row matters more here than elsewhere: run from the wrong anchor
      // the daemon prints a confident, specific, WRONG directory (D57). This
      // ward resolves the climb from the EMITTED location, which is the only
      // address the arithmetic is true at.
      "plugins/spellbook/skills/digestify/dist/review.js -> src/digestify",
      // glamour's `SURFACE_CWD`, the dev-mode daemon cwd Contract 5 pins. It
      // arrived here in Phase 2 — and note it arrived only once the anchor
      // pattern learned `Bun.fileURLToPath`: before that this cell was green
      // because it could not see the escape at all, which is the same blindness
      // the coverage cell above now asserts against.
      "plugins/spellbook/skills/glamour/dist/cli.js -> src/glamour",
      // grapevine's `SURFACE_CWD` — the SIXTH instance of this one Contract 5
      // dev-cwd pin, arriving in Phase 6 with the same bare `fileURLToPath`
      // spelling the pattern has always read. Six instances across six spells is
      // what makes it a house shape rather than a spell's quirk: every CLI that
      // fronts a bundling daemon has to name the directory whose bunfig.toml
      // loads the Tailwind plugin, and that directory is outside the plugin.
      // ⚠ The five `..` are resolved here from the EMITTED location, which is the
      // only address the arithmetic is true at — and the port did not change the
      // expression, because `dist/` and `scripts/` sit at the same depth.
      "plugins/spellbook/skills/grapevine/dist/cli.js -> src/grapevine",
      // imago's `SURFACE_CWD` — the same Contract 5 dev-mode cwd pin, arriving
      // in Phase 3 for the same reason and with the same bare anchor spelling
      // the pattern has always read. It is the third instance of this one
      // escape, which is what makes it a shape rather than a spell's quirk.
      "plugins/spellbook/skills/imago/dist/cli.js -> src/imago",
      "plugins/spellbook/skills/magpie/dist/cli.js -> src/magpie",
    ]);
  });

  test("⛔ CALIBRATION — an anchor spelling this ward CANNOT READ is LOUD, not exempt", () => {
    // ⛔ THE MUTATION THAT WAS DRIVEN BY HAND, MADE PERMANENT. Each of these was
    // planted in glamour's real `dist/cli.js` beside a `SERVER_SCRIPT` pointing
    // at a nonexistent `dist/server.ts`; against D27's predicate all five passed
    // 6/0, and against this one all five red. Driving is what found them; this
    // cell is what stops the property rotting. **Add the next spelling here the
    // day you teach the ward to read it.**
    const spellings = [
      // esbuild/Bun's `__filename` shim — a two-step anchor, and the likeliest
      // of the five to arrive on its own.
      "var __fileName = Bun.fileURLToPath(import.meta.url); var SCRIPT_DIR = dirname(__fileName);",
      // a real Bun/Node API, and the shortest thing an author would write.
      "var SCRIPT_DIR = import.meta.dirname;",
      // TWO qualifier segments; `QUALIFIER` allows one.
      "var SCRIPT_DIR = path.posix.dirname(node_url.fileURLToPath(import.meta.url));",
      // an interposed `new URL(...)` inside the pair `ANCHOR_URL` matches.
      "var SCRIPT_DIR = dirname(fileURLToPath(new URL(import.meta.url)));",
      // the CJS pair — and the one that broke the FIRST version of this cell's
      // ingredient list, found by hunting for a fifth after the four above.
      "var SCRIPT_DIR = dirname(__filename);",
    ];
    const root = mkdtempSync(join(tmpdir(), "spawn-path-anchor-"));
    mkdirSync(join(root, "dist"));
    for (const [i, anchor] of spellings.entries()) {
      const text = [anchor, 'var SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");', ""].join("\n");
      const file = join(root, "dist", `cli${i}.js`);
      writeFileSync(file, text);
      // Unreadable, so nothing computed from it is a pin — which is precisely
      // why D27's "declares an anchor" predicate made the file EXEMPT: no
      // readable anchor, no pins, no complaint, over a spawn target that is not
      // there.
      expect(hasReadableAnchor(text)).toBe(false);
      expect(pinnedPaths(file)).toEqual([]);
      // …and the ingredient gate sees it anyway, and names the line.
      expect(asksWhereItIs(text)).toBe(true);
      expect(unreadAnchorLines(text, new Set())).toEqual([`1:${anchor}`]);
    }

    // ⭐ AND THE OTHER HALF OF THE CONTRACT: a backend that legitimately anchors
    // NOTHING carries no ingredient, is exempt, and stays exempt. Bun's own
    // emitted preamble binds the helper without anchoring anything, and must not
    // count — it is present in five of the six real artifacts today.
    const inert = ['import { fileURLToPath } from "url";', 'var X = join(A, "b");', ""].join("\n");
    expect(asksWhereItIs(inert)).toBe(false);
    expect(unreadAnchorLines(inert, new Set())).toEqual([]);
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

  test("⛔ CALIBRATION — A BACKEND ARTIFACT THIS WARD HAS NEVER SEEN A NAME FOR IS COVERED", () => {
    // ⛔ THE BLIND SPOT D43 FILED, CLOSED AND THEN PINNED. Until this branch the
    // backend set was `endsWith("/cli.js") || endsWith("/server.js")` — so
    // bounty's `join.js`, digestify's `review.js` and grapevine's `daemon.js`
    // would each have been emitted, scanned by NOTHING in the coverage cell, and
    // reported green. The split is now the reference closure from `index.html`,
    // and this cell drives the three real shapes the remaining ports produce
    // against a tree it builds, through the SAME function the ward calls.
    const root = mkdtempSync(join(tmpdir(), "spawn-path-derived-split-"));
    const dist = distDirFor("probe", root);
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), '<script src="./index-aaaa.js"></script>\n');
    writeFileSync(join(dist, "index-aaaa.js"), 'import "./index-bbbb.js";\n'); // a chunk of the surface
    writeFileSync(join(dist, "index-bbbb.js"), "// reached transitively\n");
    for (const name of ["join.js", "review.js", "daemon.js"]) {
      writeFileSync(join(dist, name), "// a backend entry with a name nobody listed\n");
    }

    const split = classifyDist("probe", root);
    expect(split.surface).toEqual(["index-aaaa.js", "index-bbbb.js"]);
    // ⭐ THE THREE ROWS THAT DID NOT EXIST BEFORE — and note that the OLD
    // predicate is asserted here too, so this cell states the defect rather than
    // merely being green over its repair.
    expect(split.backend).toEqual(["daemon.js", "join.js", "review.js"]);
    for (const name of split.backend ?? []) {
      expect(isBackendArtifact(join(dist, name), root)).toBe(true);
      expect(name.endsWith("cli.js") || name.endsWith("server.js")).toBe(false); // the old list: blind
    }
    // …and the surface chunks still do not count toward coverage, which is what
    // the name test got right and what the derivation must not lose.
    expect(isBackendArtifact(join(dist, "index-aaaa.js"), root)).toBe(false);

    // ⛔ AND A SPELL WITH NO `dist/` IS `null` — NOT LOOKED AT, never `false`.
    expect(isBackendArtifact(join(distDirFor("no-such-spell-6f3a1c", root), "cli.js"), root)).toBe(
      null,
    );

    rmSync(root, { recursive: true, force: true });
  });

  test("⛔ CALIBRATION — AN UNSTAGED EMITTED ARTIFACT IS IN THE POPULATION, NOT MISSING FROM IT", () => {
    // ⛔ THE THIRD INSTANCE OF ONE DEFECT, MADE PERMANENT (D42). `emittedFiles`
    // read `git ls-files`, so a spell whose backend artifact was on disk and not
    // yet in the index contributed NO coverage row — while still being counted in
    // the population line above. Driven by hand: a corrupted pin in an untracked
    // `bounty/dist/cli.js` produced not one new failure. This cell is what stops
    // the enumerator quietly returning to the index.
    //
    // ⛔ AND IT GOES THROUGH THE ENUMERATOR, AGAINST A REPO THE CELL BUILT.
    // Asserting that `git ls-files` can read an index proves nothing about which
    // set this ward walks (`dist-roster-ward`'s positive control records the same
    // ruling, and the pathspec typo that earned it).
    const root = mkdtempSync(join(tmpdir(), "spawn-path-population-"));
    const dist = distDirFor("probe", root);
    mkdirSync(dist, { recursive: true });
    const git = (...a: string[]) =>
      Bun.spawnSync(["git", ...a], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q").exitCode).toBe(0);
    writeFileSync(join(dist, "server.js"), "// staged\n");
    writeFileSync(join(dist, "index-oldhash.js"), "// about to be replaced\n");
    // `-f`, because the real tree's `dist` is gitignored and a throwaway repo
    // should not have to reproduce the un-ignore list to model the index.
    expect(git("add", "-f", "--", "plugins").exitCode).toBe(0);
    // …and now the two divergences a port actually produces:
    writeFileSync(join(dist, "cli.js"), "// emitted, NOT yet staged\n"); // disk only
    rmSync(join(dist, "index-oldhash.js")); // index only — the renamed chunk

    const found = emittedFiles("probe", root);
    expect(found.map((f) => `${relative(dist, f.abs)} staged=${f.staged}`)).toEqual([
      // ⭐ THE ROW THAT DID NOT EXIST BEFORE. Present, labelled, and therefore
      // scanned by every cell above.
      "cli.js staged=false",
      "server.js staged=true",
    ]);
    // The reverse divergence is REPORTED, not silently absent.
    expect(indexOnlyEmitted("probe", root).map((f) => relative(dist, f))).toEqual([
      "index-oldhash.js",
    ]);
    // …and the enumerator CAN measure empty, so the two rows above came from it
    // discriminating rather than from a walk that returns everything.
    expect(emittedFiles("no-such-spell-6f3a1c", root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
