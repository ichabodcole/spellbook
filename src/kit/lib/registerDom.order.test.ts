// Guards the order that once failed: a DOM test file that loads CodeMirror
// AFTER another DOM test file has removed the DOM. Such a file's modules load
// with no DOM registered, so CodeMirror read Bun's own navigator platform while
// the test read happy-dom's, and `Mod-Shift-K` pressed the wrong modifier (the
// link-insert tests timed out waiting for the picker). The two files run in a
// process of their own, so the order holds whatever the gate runs first.

import { expect, test } from "bun:test";
import { join } from "node:path";

const DIR = join(import.meta.dir, "fixtures", "domOrder");

test("a DOM test file after another one still gets the shortcut CodeMirror expects", async () => {
  const run = Bun.spawn(
    [process.execPath, "test", join(DIR, "1-earlier.tsx"), join(DIR, "2-shortcut.tsx")],
    { cwd: import.meta.dir, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  const report = out + err;
  expect(report).toContain(" 2 pass");
  expect(code, report).toBe(0);
}, 30_000);
