// A file with no DOM that loads Base UI before any component test file must not
// take the popups of every component test after it in the process. Base UI reads
// the DOM once, when its modules load; the preload (`domGuard.ts`) registers a
// DOM while they load, and removes it before that file's next test. The fixture
// runs in a process of its own, so the result does not depend on what the gate
// runs first.
//
// This was CI's red on Linux (2026-10-17 on, item `ci-red-on-linux`): in a
// serial `bun test`, the filesystem's order put mind-mapper's
// `GraphCanvas.test.ts`, which imports Base UI through its context menu, before
// every component test file.
//
// Run twice: from the repo root, where bunfig.toml preloads the guard, every
// test passes; from a directory with no bunfig, the dialog never opens. The
// second run is the control that shows the fixture still reproduces the failure,
// so a pass in the first run is the preload's doing.

import { expect, test } from "bun:test";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "domLoadOrder", "baseUiFirst.tsx");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

async function run(cwd: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, "test", FIXTURE], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return out + err;
}

test("with the preload, a dialog opens after a file with no DOM loaded Base UI", async () => {
  const report = await run(REPO_ROOT);
  expect(report).toContain(" 3 pass");
  expect(report).toContain(" 0 fail");
}, 30_000);

test("without it, the same file loses the dialog (the control)", async () => {
  const report = await run(join(import.meta.dir, "fixtures", "domLoadOrder"));
  expect(report).toContain(" 2 pass");
  expect(report).toContain(" 1 fail");
  expect(report).toContain("timed out waiting for the dialog title");
}, 30_000);
