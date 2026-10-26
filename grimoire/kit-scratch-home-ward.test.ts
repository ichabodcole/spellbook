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
// The homedir rule also covers the kit-path Scriptorium
// (`src/scriptorium/backend/kit/`), which runs on the kit.
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

const nameOf = (p: ts.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : undefined;

/**
 * Whether an environment expression is shown to carry `HOME`. A child given an
 * environment with no `HOME` falls back to the password database: the REAL
 * home. So it must be `process.env` itself, an object literal that spreads one
 * that is or sets `HOME`, or a name bound in this file (every `const`/`let` of
 * that name) to one of those. `undefined`, `{}` and `{ PATH, X_HOME }` are not;
 * neither is anything this file cannot see into (`rig.env`, a parameter).
 */
function givesHome(e: ts.Expression, sf: ts.SourceFile, depth = 0): boolean {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  if (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "process" &&
    e.name.text === "env"
  )
    return true;
  if (ts.isObjectLiteralExpression(e))
    return e.properties.some(
      (p) =>
        (ts.isSpreadAssignment(p) && givesHome(p.expression, sf, depth)) ||
        ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          nameOf(p) === "HOME"),
    );
  if (ts.isIdentifier(e) && depth < 5) {
    const inits: ts.Expression[] = [];
    let unseeable = false;
    visit(sf, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === e.text) {
        if (n.initializer) inits.push(n.initializer);
        else unseeable = true;
      }
    });
    return !unseeable && inits.length > 0 && inits.every((i) => givesHome(i, sf, depth + 1));
  }
  return false;
}

/** Whether an options object literal has an `env` property that is shown to carry `HOME`. */
function hasEnv(o: ts.ObjectLiteralExpression, sf: ts.SourceFile): boolean {
  return o.properties.some((p) => {
    if (nameOf(p) !== "env") return false;
    if (ts.isShorthandPropertyAssignment(p)) return givesHome(p.name, sf);
    return ts.isPropertyAssignment(p) && givesHome(p.initializer, sf);
  });
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
      if (!opts || !hasEnv(opts, sf)) at.push(lineOf(sf, n));
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
function runFixture(
  file: string,
  tmp: string,
  flags: string[] = [],
): { code: number | null; out: string } {
  const p = Bun.spawnSync([process.execPath, "test", ...flags, join(FIXTURES, file)], {
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

  // The kit-path Scriptorium (`src/scriptorium/backend/kit/`) runs on the kit
  // and is held to the kit's rule: its home comes from homeDir(). The shipped
  // backend beside it is not on the kit, and is not checked here.
  test("no file of the kit-path Scriptorium names homedir", () => {
    const scriptoriumKit = join(REPO_ROOT, "src", "scriptorium", "backend", "kit");
    const files = walk(scriptoriumKit, (n) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(n));
    // Not vacuous: the app declaration, its CLI and its daemon at least.
    expect(files).toContain(join(scriptoriumKit, "app.ts"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    const offenders: string[] = [];
    for (const f of files)
      for (const line of homedirReads(readFileSync(f, "utf8"), f))
        offenders.push(
          `${rel(f)}:${line} names homedir, which a test preload cannot move: use homeDir() from src/kit/lib/home.ts`,
        );
    expect(offenders).toEqual([]);
  });

  test("CALIBRATION: a spawn's env must carry HOME, and an alias is not followed", () => {
    for (const planted of [
      'Bun.spawn(["x"], { stdout: "pipe" });',
      'Bun.spawn(["env"]);',
      'Bun.spawn(["x"], { stdout: "env" });',
      'Bun.spawnSync(["x"], { cwd: env.dir });',
      'Bun.spawn({ cmd: ["x"] });',
      'Bun["spawn"](["x"], { stdout: "pipe" });',
      'const env = process.env; const s = Bun.spawn; s(["x"], { env });',
      'const env = process.env; const { spawn } = Bun; spawn(["x"], { env });',
      'Bun.spawn(["x"], opts);',
      // An env with no HOME: the child falls back to the REAL home.
      'Bun.spawn(["x"], { env: undefined });',
      'Bun.spawn(["x"], { env: {} });',
      'const PATH = "/bin"; Bun.spawn(["x"], { env: { PATH, BOUNTY_HOME: "/b" } });',
      'const env = { PATH: "/bin" }; Bun.spawn(["x"], { env });',
      'Bun.spawn(["x"], { env: rig.env });',
      'function f(env) { Bun.spawn(["x"], { env }); }',
      'Bun.spawn(["x"], { env });',
    ])
      expect(spawnsWithoutEnv(planted), planted).toHaveLength(1);
    for (const clean of [
      'const env = { ...process.env, A: "1" }; Bun.spawn(["x"], { env, stdout: "pipe" });',
      'Bun.spawnSync(["x"], { env: process.env });',
      'Bun.spawn(["x"], { ...base, env: { ...process.env, A: "1" } });',
      'const env = { ...process.env }; Bun.spawn({ cmd: ["x"], env: { ...env, B: "2" } });',
      'Bun.spawn(["x"], { env: { ...rig.env, HOME: process.env.HOME } });',
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
          `${rel(f)}:${line} Bun.spawn with no env shown to carry HOME: its child starts with the REAL home. Pass env: process.env, or an object that spreads it or sets HOME.`,
        );
    }
    // The population is not vacuous.
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  // ⛔ THE GUARD MUST NOT FIRE OUTSIDE A TEST RUN. Its first version also keyed
  // on `Bun.jest`, which is a function in EVERY Bun process: a plain run
  // refused the real home, and so would every spell on the kit. The gate never
  // saw it, because everything it runs is a test run. These two cells run the
  // kit the way a user does: no `NODE_ENV`, and a home that is not a scratch
  // one (a stand-in folder, so nothing here can reach the real home).
  const plainEnv = (home: string, extra: Record<string, string> = {}) => {
    const { NODE_ENV: _testRun, ...env } = process.env;
    return { ...env, HOME: home, ...extra };
  };

  test("outside a test run, homeDir() answers HOME and does not refuse it", () => {
    const fake = realpathSync(mkdtempSync(join(tmpdir(), "plain-home-")));
    try {
      const p = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { homeDir } from ${JSON.stringify(HOME_HELPER)}; console.log(process.env.NODE_ENV ?? "unset"); console.log(homeDir());`,
        ],
        { env: plainEnv(fake), stdout: "pipe", stderr: "pipe" },
      );
      expect(p.exitCode, p.stderr.toString()).toBe(0);
      expect(p.stdout.toString().trim().split("\n")).toEqual(["unset", fake]);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test("outside a test run, the fixture CLI's open is not refused the home", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plain-open-")));
    const home = join(root, "home");
    const docs = join(root, "docs");
    const CLI = join(KIT, "workspace", "fixtures", "cli.ts");
    const env = plainEnv(home, {
      KIT_FIXTURE_HOME: join(root, "fixture"),
      TMPDIR: `${join(root, "tmp")}/`,
    });
    for (const d of [home, join(docs, "set"), join(root, "tmp")])
      Bun.spawnSync(["mkdir", "-p", d], { env });
    const cli = (...args: string[]) =>
      Bun.spawnSync([process.execPath, CLI, ...args], {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    try {
      // One folder: it becomes a set and the workspace steps out of it, which
      // is the path that reads the home folder.
      const r = cli("open", "--no-open", join(docs, "set"));
      const out = r.stdout.toString() + r.stderr.toString();
      expect(out).not.toContain("refusing the real home folder");
      expect(r.exitCode, out).toBe(0);
    } finally {
      cli("close");
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a kit test run with no preload is refused the home, loudly, before it touches it", () => {
    // `bun test` reads only the bunfig.toml in its cwd, and src/kit/ has none.
    // HOME is a stand-in for the real home here (any folder that is not a
    // scratch one is refused the same way), so a broken guard writes nowhere
    // that matters. Bun's transpiler cache is turned off so the stand-in stays
    // empty unless the test itself touches it.
    const fake = realpathSync(mkdtempSync(join(tmpdir(), "not-a-scratch-home-")));
    const run = (extra: string[]) =>
      Bun.spawnSync(
        [
          process.execPath,
          "test",
          ...extra,
          "./workspace/verbs.test.ts",
          "-t",
          "a new session's workspace holds the one folder",
        ],
        {
          cwd: KIT,
          env: { ...process.env, HOME: fake, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    try {
      const bare = run([]);
      const out = bare.stdout.toString() + bare.stderr.toString();
      expect(bare.exitCode, out).not.toBe(0);
      expect(out).toContain(`refusing the real home folder (${fake}) in a test run`);
      expect(out).toContain("scratchHome.ts");
      expect(readdirSync(fake)).toEqual([]);
      // Control: the same run with the preload passes, so the refusal above is
      // the guard and not a broken command.
      const preloaded = run(["--preload", "./lib/scratchHome.ts"]);
      expect(preloaded.exitCode, preloaded.stdout.toString() + preloaded.stderr.toString()).toBe(0);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  }, 60_000);

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

  test("under --rerun-each, every rerun finds its temp folder, and the next run prunes what is left", () => {
    // The preload's cleanup fires after each rerun while the preload runs once:
    // without the folders made again, rerun 2 of a file that makes a temp folder
    // as it loads dies with ENOENT. `--rerun-each=50` is how a parallel-only
    // flake is proven fixed (the test-speed playbook), so it must work here.
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "scratch-rerun-")));
    try {
      const r = runFixture("loadTemp.ts", tmp, ["--rerun-each=3"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(" 3 pass");
      expect(runsIn(tmp).length).toBeLessThanOrEqual(1);
      const next = runFixture("noop.ts", tmp);
      expect(next.code, next.out).toBe(0);
      expect(runsIn(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
