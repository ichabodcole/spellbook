// The under-test predicate, and the reason it takes a parameter: it must survive
// a build that defines `process.env.NODE_ENV`, as Spellbook's backend build does
// (`src/build.ts` pins it to "production"). Written as that member chain, the
// check folds to `false` in the bundle, and every guard on it (the real home,
// the real Trash) is gone from the daemon a test spawns.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { underTest } from "./home";

describe("underTest", () => {
  test("reads NODE_ENV from the environment it is given", () => {
    expect(underTest({ NODE_ENV: "test" })).toBe(true);
    expect(underTest({ NODE_ENV: "production" })).toBe(false);
    expect(underTest({})).toBe(false);
  });

  test("a HOME of the preload's scratch shape is a test run, whatever NODE_ENV says", () => {
    const scratch = "/tmp/spellbook-test/run-123-abc/home";
    expect(underTest({ NODE_ENV: "development", HOME: scratch })).toBe(true);
    expect(underTest({ NODE_ENV: "production", HOME: "/Users/someone" })).toBe(false);
    expect(underTest({ HOME: "/tmp/spellbook-test/run-123-abc/home/deeper" })).toBe(false);
  });

  // ⛔ `bun test` keeps a NODE_ENV that is already set. Before the preload set
  // it, `NODE_ENV=development bun test` ran with every under-test guard off:
  // the real home handed out, and a daemon with no trash function sent to the
  // real Trash. The fixture checks the guard, and nothing else.
  test("under NODE_ENV=development bun test, the run is still under test", () => {
    const repo = resolve(import.meta.dir, "..", "..", "..");
    const fixture = join(import.meta.dir, "fixtures", "scratchHome", "presetNodeEnv.ts");
    const p = Bun.spawnSync([process.execPath, "test", fixture], {
      cwd: repo,
      env: { ...process.env, NODE_ENV: "development" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = p.stdout.toString() + p.stderr.toString();
    expect(p.exitCode, out).toBe(0);
    expect(out).toContain("NODE_ENV=test");
    expect(out).toContain("UNDER_TEST=true");
    expect(out).toContain("HOME_REFUSED=true");
  }, 30_000);

  test("survives a build that defines process.env.NODE_ENV", async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "home.ts")],
      target: "bun",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    expect(result.success).toBe(true);
    const out = await (result.outputs[0] as Blob).text();
    // The check is still read at run time, and nothing folded it away.
    expect(out).toContain('env.NODE_ENV === "test"');
    expect(out).not.toMatch(/function underTest\([^)]*\)\s*\{\s*return false;/);
  });
});
