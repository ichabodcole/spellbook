// enforces: none in house-style — the workspace port's scratch-HOME rule (kit-port-workspace, 2026-10-14): no kit test may see the real home
//
// THE SCRATCH-HOME WARD. Every test process runs with a scratch `HOME`
// (`src/kit/lib/scratchHome.ts`, preloaded by the root bunfig.toml), and the
// kit reaches the home folder only through it.
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
// shapes: its code reads the home through `homeDir()` (src/kit/lib/home.ts),
// and its tests pass `env` to every `Bun.spawn`.
//
// What a green here does NOT mean: that a spell's own tests (outside src/kit)
// are isolated. They get the same `HOME`, but nothing checks how they read it.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { homeDir } from "../src/kit/lib/home.ts";
import { blankComments } from "./lib/import-graph";

const REPO_ROOT = join(import.meta.dir, "..");
const KIT = join(REPO_ROOT, "src", "kit");
const HOME_HELPER = join(KIT, "lib", "home.ts");
const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll("\\", "/");

/** The real home, from the password database: `HOME` cannot steer it. */
const REAL_HOME = userInfo().homedir;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(join(dir, e.name), out);
    } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** The text of a call from its `(` to the matching `)`. */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

const lineOf = (src: string, at: number): number => src.slice(0, at).split("\n").length;

/** Every place a file reads the OS's home directly: a `homedir` import or call through an `os` namespace. */
function homedirReads(raw: string): number[] {
  // Comments may name it; only code reads it. Blanking keeps the offsets.
  const src = blankComments(raw);
  const at: number[] = [];
  for (const m of src.matchAll(/import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*["'](?:node:)?os["']/g))
    at.push(m.index ?? 0);
  for (const m of src.matchAll(/\b\w+\.homedir\s*\(/g)) at.push(m.index ?? 0);
  return at;
}

/** Every `Bun.spawn` / `Bun.spawnSync` call whose arguments never name `env`. */
function spawnsWithoutEnv(raw: string): number[] {
  const src = blankComments(raw);
  const at: number[] = [];
  for (const m of src.matchAll(/\bBun\.spawn(?:Sync)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (!/\benv\b/.test(callText(src, open))) at.push(m.index ?? 0);
  }
  return at;
}

const kitFiles = walk(KIT);
const isTestish = (f: string) => /\.test\.[cm]?[jt]sx?$/.test(f) || f.includes("/fixtures/");

describe("kit scratch-home ward", () => {
  test("this test process runs with a scratch HOME, not the real one", () => {
    const home = process.env.HOME;
    expect(home).toBeDefined();
    expect(home).not.toBe(REAL_HOME);
    // The preload's: `<scratch>/home`, beside `<scratch>/tmp`, which is the
    // temp folder now. The home is NOT inside the temp folder.
    const scratch = dirname(home as string);
    expect(basename(home as string)).toBe("home");
    expect(basename(scratch)).toStartWith("spellbook-test-");
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

  test("bunfig.toml preloads scratchHome.ts", () => {
    const bunfig = readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8");
    const preload = bunfig.match(/^\s*preload\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
    expect(preload).toContain('"./src/kit/lib/scratchHome.ts"');
  });

  test("no kit file reads the home with os.homedir(), except home.ts", () => {
    // Positive control: the one permitted reader is found by the same matcher.
    expect(homedirReads(readFileSync(HOME_HELPER, "utf8")).length).toBeGreaterThan(0);
    expect(kitFiles.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const f of kitFiles) {
      if (f === HOME_HELPER) continue;
      const src = readFileSync(f, "utf8");
      for (const at of homedirReads(src))
        offenders.push(
          `${rel(f)}:${lineOf(src, at)} reads os.homedir(), which a test preload cannot move: use homeDir() from src/kit/lib/home.ts`,
        );
    }
    expect(offenders).toEqual([]);
  });

  test("every Bun.spawn in a kit test passes env, so its child gets the scratch home", () => {
    // Calibration: the matcher sees both shapes.
    expect(spawnsWithoutEnv('Bun.spawn(["x"], { stdout: "pipe" })')).toHaveLength(1);
    expect(spawnsWithoutEnv('Bun.spawn(["x"], { env, stdout: "pipe" })')).toHaveLength(0);
    const tests = kitFiles.filter(isTestish);
    expect(tests.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    let seen = 0;
    for (const f of tests) {
      const src = readFileSync(f, "utf8");
      seen += [...src.matchAll(/\bBun\.spawn(?:Sync)?\s*\(/g)].length;
      for (const at of spawnsWithoutEnv(src))
        offenders.push(
          `${rel(f)}:${lineOf(src, at)} Bun.spawn without env: its child starts with the REAL home. Pass env: process.env (or a copy of it).`,
        );
    }
    // The population is not vacuous.
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });
});
