// The under-test predicate, and the reason it takes a parameter: it must survive
// a build that defines `process.env.NODE_ENV`, as Spellbook's backend build does
// (`src/build.ts` pins it to "production"). Written as that member chain, the
// check folds to `false` in the bundle, and every guard on it (the real home,
// the real Trash) is gone from the daemon a test spawns.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { underTest } from "./home";

describe("underTest", () => {
  test("reads NODE_ENV from the environment it is given", () => {
    expect(underTest({ NODE_ENV: "test" })).toBe(true);
    expect(underTest({ NODE_ENV: "production" })).toBe(false);
    expect(underTest({})).toBe(false);
  });

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
