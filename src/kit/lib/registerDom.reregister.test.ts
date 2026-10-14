// A DOM test file that loads Base UI AFTER another DOM test file, one that never
// loaded Base UI, has removed the DOM. `registerDom.ts` evaluates once per
// process, so that file's import alone registers nothing; the preload
// (`domGuard.ts`) must register the DOM again before Base UI loads, or the
// file's popups never portal. The two files run in a process of their own, in
// that order, so the result does not depend on what the gate runs first.
//
// Run twice: from the repo root, where bunfig.toml preloads the guard, both
// files pass; from a directory with no bunfig, the popup test fails. The second
// run is the control that shows the fixtures still reproduce the failure, so a
// pass in the first run is the preload's doing.

import { expect, test } from "bun:test";
import { join } from "node:path";

const DIR = join(import.meta.dir, "fixtures", "domReregister");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

async function runPair(cwd: string): Promise<{ code: number; report: string }> {
  const run = Bun.spawn(
    [process.execPath, "test", join(DIR, "1-dom-only.ts"), join(DIR, "2-popup.tsx")],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { code, report: out + err };
}

test("with the preload, a Base UI popup opens in a DOM file after a DOM-only one", async () => {
  const { code, report } = await runPair(REPO_ROOT);
  expect(report).toContain(" 2 pass");
  expect(code, report).toBe(0);
}, 30_000);

test("without it, the same pair fails the popup (the control)", async () => {
  const { report } = await runPair(DIR);
  expect(report).toContain(" 1 pass");
  expect(report).toContain(" 1 fail");
}, 30_000);
