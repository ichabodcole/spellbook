// A component test file that throws while it loads must not leave its DOM to
// the files after it. The two fixture files run in a process of their own, in
// that order, so the result does not depend on what the gate runs first.
//
// Run twice: from the repo root, where bunfig.toml preloads the guard, the
// backend file passes; from a directory with no bunfig, the same pair leaks.
// The second run is the control that shows the fixtures still reproduce the
// leak, so a pass in the first run is the guard's doing.

import { expect, test } from "bun:test";
import { join } from "node:path";

const DIR = join(import.meta.dir, "fixtures", "domLeak");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

async function runPair(cwd: string): Promise<string> {
  const run = Bun.spawn(
    [process.execPath, "test", join(DIR, "1-throws-at-load.tsx"), join(DIR, "2-backend.ts")],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [, out, err] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return out + err;
}

test("with the preload, a file after one that threw while loading sees no DOM", async () => {
  const report = await runPair(REPO_ROOT);
  expect(report).toContain("deliberate throw at module load");
  expect(report).toContain(" 1 pass");
}, 30_000);

test("without it, the same pair leaks (the control)", async () => {
  const report = await runPair(DIR);
  expect(report).toContain("deliberate throw at module load");
  expect(report).toContain(" 0 pass");
}, 30_000);
