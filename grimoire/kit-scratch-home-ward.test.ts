// enforces: none in house-style — the workspace port's scratch-HOME rule (kit-port-workspace, 2026-10-14): no kit test may see the real home
//
// THE SCRATCH-HOME WARD. Every test process runs with a scratch `HOME`
// (`src/kit/lib/scratchHome.ts`, preloaded by EVERY bunfig.toml in the repo,
// since `bun test` reads the one in its cwd), the kit reaches the home folder
// only through it, and the scratch folders do not pile up.
//
// Why: the workspace daemon reads the home folder (`defaultWorkspace` steps out
// of it; `~` paths expand against it), and Story Studio's kit tests had no
// stand-in home when this code was ported. A foundation-cycle verifier already
// wrote a channel into Cole's real grapevine because nothing isolated `HOME`.
//
// ⛔ WHY THE PRELOAD ALONE IS NOT ENOUGH, MEASURED ON BUN 1.4.0. Setting
// `process.env.HOME` at runtime does not move:
//   - `os.homedir()`, which answers the home the process STARTED with;
//   - `Bun.spawn` with no `env`, whose child gets the STARTING environment.
// It does move `node:child_process` children (they get `process.env`) and any
// `Bun.spawn` given `env: process.env`. So the ward holds the kit to two
// shapes: no kit file but `src/kit/lib/home.ts` names `homedir` at all (it
// reads the home through `homeDir()`), and every `Bun.spawn` in a kit test
// passes an options object with an `env` property.
//
// ⛔ BOTH ARE READ FROM THE SYNTAX TREE, NOT BY REGEX. A regex missed
// `require("os").homedir()`, `const { homedir } = os` and a spawn whose
// arguments merely contained the word "env". The calibration cells plant each
// of those shapes.
//
// What a green here does NOT mean: that a spell's own tests (outside src/kit)
// are isolated. They get the same `HOME`, but nothing checks how they read it.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { homeDir } from "../src/kit/lib/home.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const KIT = join(REPO_ROOT, "src", "kit");
const HOME_HELPER = join(KIT, "lib", "home.ts");
const PRELOAD = join(KIT, "lib", "scratchHome.ts");
const FIXTURES = join(KIT, "lib", "fixtures", "scratchHome");
const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll("\\", "/");

/** The real home, from the password database: `HOME` cannot steer it. */
const REAL_HOME = userInfo().homedir;

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["node_modules", "dist", ".git", ".claude"].includes(e.name)) continue;
      walk(join(dir, e.name), keep, out);
    } else if (keep(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const parse = (src: string, name = "probe.tsx"): ts.SourceFile =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((c) => visit(c, fn));
}

const lineOf = (sf: ts.SourceFile, n: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/**
 * Every place a file names `homedir`: as an identifier anywhere (an import, a
 * property access, a destructured binding, `require("os").homedir`) or as a
 * string (`os["homedir"]`, `{ "homedir": h }`). Comments are not in the tree.
 * Naming it is the offence: the kit has one reader of the home, `homeDir()`.
 */
function homedirReads(src: string, name?: string): number[] {
  const sf = parse(src, name);
  const at: number[] = [];
  visit(sf, (n) => {
    if (ts.isIdentifier(n) && n.text === "homedir") at.push(lineOf(sf, n));
    else if (ts.isStringLiteralLike(n) && n.text === "homedir") at.push(lineOf(sf, n));
  });
  return at;
}

const SPAWNS = new Set(["spawn", "spawnSync"]);

/** Whether `n` is `Bun.spawn`, `Bun.spawnSync`, or either written `Bun["…"]`. */
function isBunSpawn(n: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(n))
    return ts.isIdentifier(n.expression) && n.expression.text === "Bun" && SPAWNS.has(n.name.text);
  if (ts.isElementAccessExpression(n))
    return (
      ts.isIdentifier(n.expression) &&
      n.expression.text === "Bun" &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      SPAWNS.has(n.argumentExpression.text)
    );
  return false;
}

/** Whether an options object literal has an `env` property of its own. */
function hasEnv(o: ts.ObjectLiteralExpression): boolean {
  return o.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) &&
      p.name.text === "env",
  );
}

/**
 * Every `Bun.spawn` / `Bun.spawnSync` that cannot be shown to pass `env`: a
 * call whose options object (its last object-literal argument) has no `env`
 * property, a call with no options object, and any use of the function that is
 * not a direct call (an alias, `const { spawn } = Bun`), which cannot be
 * followed.
 */
function spawnsWithoutEnv(src: string, name?: string): number[] {
  const sf = parse(src, name);
  const at: number[] = [];
  visit(sf, (n) => {
    if (isBunSpawn(n)) {
      const call = n.parent;
      if (!call || !ts.isCallExpression(call) || call.expression !== n) {
        at.push(lineOf(sf, n));
        return;
      }
      const opts = [...call.arguments].reverse().find(ts.isObjectLiteralExpression);
      if (!opts || !hasEnv(opts)) at.push(lineOf(sf, n));
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      ts.isIdentifier(n.initializer) &&
      n.initializer.text === "Bun" &&
      n.name.elements.some((e) => {
        const key = e.propertyName ?? e.name;
        return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && SPAWNS.has(key.text);
      })
    ) {
      at.push(lineOf(sf, n));
    }
  });
  return at;
}

/** The `[test]` section's `preload` entries of a bunfig.toml, as written. */
function preloadsOf(toml: string): string[] {
  const section = toml.split(/^\[/m).find((s) => s.startsWith("test]")) ?? "";
  const list = section.match(/^\s*preload\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

const kitFiles = walk(KIT, (n) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(n));
const isTestish = (f: string) => /\.test\.[cm]?[jt]sx?$/.test(f) || f.includes("/fixtures/");
const bunfigs = walk(REPO_ROOT, (n) => n === "bunfig.toml");

/** The run folders a preload made under `tmp`. */
const runsIn = (tmp: string): string[] => {
  try {
    return readdirSync(join(tmp, "spellbook-test")).filter((n) => n.startsWith("run-"));
  } catch {
    return [];
  }
};

/** One `bun test` of a fixture from the repo root, with `TMPDIR` set to `tmp`. */
function runFixture(file: string, tmp: string): { code: number | null; out: string } {
  const p = Bun.spawnSync([process.execPath, "test", join(FIXTURES, file)], {
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: tmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe("kit scratch-home ward", () => {
  test("this test process runs with a scratch HOME, not the real one", () => {
    const home = process.env.HOME;
    expect(home).toBeDefined();
    expect(home).not.toBe(REAL_HOME);
    // The preload's: `<temp>/spellbook-test/run-<pid>-…/home`, beside its
    // `tmp`, which is the temp folder now. The home is NOT inside it.
    const scratch = dirname(home as string);
    expect(basename(home as string)).toBe("home");
    expect(basename(scratch)).toStartWith(`run-${process.pid}-`);
    expect(basename(dirname(scratch))).toBe("spellbook-test");
    expect(statSync(home as string).isDirectory()).toBe(true);
    expect(realpathSync(tmpdir())).toBe(join(scratch, "tmp"));
    expect((home as string).startsWith(`${realpathSync(tmpdir())}/`)).toBe(false);
    // The real home is a real, different folder: the comparison means something.
    expect(statSync(REAL_HOME).isDirectory()).toBe(true);
  });

  test("the kit's own reading of the home is the scratch one", () => {
    expect(homeDir()).toBe(process.env.HOME as string);
    expect(homeDir()).not.toBe(REAL_HOME);
  });

  test("a child started the kit tests' way sees the scratch home", () => {
    const p = Bun.spawnSync([process.execPath, "-e", "console.log(require('node:os').homedir())"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString().trim()).toBe(process.env.HOME as string);
  });

  test("every bunfig.toml in the repo preloads scratchHome.ts", () => {
    // Calibration: the reader finds a preload only in the `[test]` section.
    expect(preloadsOf('[test]\npreload = ["./a.ts", "./b.ts"]\n')).toEqual(["./a.ts", "./b.ts"]);
    expect(preloadsOf('[serve.static]\nplugins = ["x"]\n')).toEqual([]);
    expect(preloadsOf('[install]\npreload = ["./a.ts"]\n')).toEqual([]);
    // The root's and one per spell, at least.
    expect(bunfigs.length).toBeGreaterThanOrEqual(10);
    expect(bunfigs).toContain(join(REPO_ROOT, "bunfig.toml"));
    const missing = bunfigs
      .filter(
        (f) => !preloadsOf(readFileSync(f, "utf8")).some((p) => resolve(dirname(f), p) === PRELOAD),
      )
      .map(
        (f) =>
          `${rel(f)}: no [test] preload of src/kit/lib/scratchHome.ts, so \`bun test\` run from its folder uses the REAL home`,
      );
    expect(missing).toEqual([]);
  });

  test("CALIBRATION: every way of naming homedir is caught, and comments are not", () => {
    for (const planted of [
      'import { homedir } from "node:os";',
      'import { homedir as h } from "os";',
      'import * as os from "node:os"; os.homedir();',
      'import os from "node:os"; const h = os.homedir;',
      'require("os").homedir();',
      'const { homedir } = require("node:os");',
      'import os from "os"; const { homedir: h } = os;',
      'import os from "os"; os["homedir"]();',
      "const h = userInfo().homedir;",
    ])
      expect(homedirReads(planted), planted).toHaveLength(1);
    for (const clean of [
      "// os.homedir() is fixed at startup",
      "/* const { homedir } = os */",
      'import { homeDir } from "./home.ts"; homeDir();',
      'const s = "the homedir of the user";',
    ])
      expect(homedirReads(clean), clean).toEqual([]);
  });

  test("no kit file names homedir, except home.ts", () => {
    // Positive control: the one permitted reader is found by the same matcher.
    expect(homedirReads(readFileSync(HOME_HELPER, "utf8")).length).toBeGreaterThan(0);
    expect(kitFiles.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const f of kitFiles) {
      if (f === HOME_HELPER) continue;
      for (const line of homedirReads(readFileSync(f, "utf8"), f))
        offenders.push(
          `${rel(f)}:${line} names homedir, which a test preload cannot move: use homeDir() from src/kit/lib/home.ts`,
        );
    }
    expect(offenders).toEqual([]);
  });

  test("CALIBRATION: a spawn passes env only with an env property, and an alias is not followed", () => {
    for (const planted of [
      'Bun.spawn(["x"], { stdout: "pipe" });',
      'Bun.spawn(["env"]);',
      'Bun.spawn(["x"], { stdout: "env" });',
      'Bun.spawnSync(["x"], { cwd: env.dir });',
      'Bun.spawn({ cmd: ["x"] });',
      'Bun["spawn"](["x"], { stdout: "pipe" });',
      'const s = Bun.spawn; s(["x"], { env });',
      'const { spawn } = Bun; spawn(["x"], { env });',
      'Bun.spawn(["x"], opts);',
    ])
      expect(spawnsWithoutEnv(planted), planted).toHaveLength(1);
    for (const clean of [
      'Bun.spawn(["x"], { env, stdout: "pipe" });',
      'Bun.spawnSync(["x"], { env: process.env });',
      'Bun.spawn(["x"], { ...base, env: { ...process.env, A: "1" } });',
      'Bun.spawn({ cmd: ["x"], env });',
      'Bun["spawnSync"](["x"], { "env": process.env });',
      '// Bun.spawn(["x"])',
    ])
      expect(spawnsWithoutEnv(clean), clean).toEqual([]);
  });

  test("every Bun.spawn in a kit test passes env, so its child gets the scratch home", () => {
    const tests = kitFiles.filter(isTestish);
    expect(tests.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    let seen = 0;
    for (const f of tests) {
      const src = readFileSync(f, "utf8");
      visit(parse(src, f), (n) => {
        if (isBunSpawn(n)) seen++;
      });
      for (const line of spawnsWithoutEnv(src, f))
        offenders.push(
          `${rel(f)}:${line} Bun.spawn without an env property: its child starts with the REAL home. Pass env: process.env (or a copy of it).`,
        );
    }
    // The population is not vacuous.
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  test("runs do not pile up: a passing run removes its folder, and the next run removes a dead one's", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "scratch-runs-")));
    try {
      // Two passing runs in a row leave at most one folder (in fact none), and
      // each ran inside a folder of its own under the shared parent.
      for (let i = 0; i < 2; i++) {
        const r = runFixture("noop.ts", tmp);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain(`SCRATCH_HOME=${join(tmp, "spellbook-test")}/run-`);
        expect(runsIn(tmp).length).toBeLessThanOrEqual(1);
      }
      expect(runsIn(tmp)).toEqual([]);
      // A run killed before its cleanup leaves its folder…
      const crashed = runFixture("crash.ts", tmp);
      expect(crashed.code).not.toBe(0);
      expect(runsIn(tmp)).toHaveLength(1);
      // …and the next run removes it, since its process is gone.
      const next = runFixture("noop.ts", tmp);
      expect(next.code, next.out).toBe(0);
      expect(runsIn(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
