// A file with no DOM that loads Base UI before any component test file must not
// take the popups of every component test after it in the process. Base UI reads
// the DOM once, when its modules load; the preload (`domGuard.ts`) registers a
// DOM while they load, and removes it around that file's tests. Each fixture
// runs in a process of its own, so the result does not depend on what the gate
// runs first.
//
// This was CI's red on Linux (2026-10-17 on, item `ci-red-on-linux`): in a
// serial `bun test`, the filesystem's order put mind-mapper's
// `GraphCanvas.test.ts`, which imports Base UI through its context menu, before
// every component test file.
//
// The first two cells run the same fixture twice: from the repo root, where
// bunfig.toml preloads the guard, every test passes; from a directory with no
// bunfig, the dialog never opens. The second run is the control that shows the
// fixture still reproduces the failure, so a pass in the first run is the
// preload's doing. The next two pin where the preload's DOM shows in a file with
// no DOM of its own (`domGuard.ts` says why it shows at all).

import { expect, test } from "bun:test";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures", "domLoadOrder");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

async function run(fixture: string, cwd = REPO_ROOT): Promise<string> {
  const proc = Bun.spawn([process.execPath, "test", join(FIXTURES, fixture)], {
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

/** The one line a fixture reports on, parsed. */
function seen(report: string): Record<string, string> {
  const line = /SEEN (\{.*\})/.exec(report);
  if (!line?.[1]) throw new Error(`no SEEN line in:\n${report}`);
  return JSON.parse(line[1]);
}

test("with the preload, a dialog opens after a file with no DOM loaded Base UI", async () => {
  const report = await run("baseUiFirst.tsx");
  expect(report).toContain(" 3 pass");
  expect(report).toContain(" 0 fail");
}, 30_000);

test("without it, the same file loses the dialog (the control)", async () => {
  const report = await run("baseUiFirst.tsx", FIXTURES);
  expect(report).toContain(" 2 pass");
  expect(report).toContain(" 1 fail");
  expect(report).toContain("timed out waiting for the dialog title");
}, 30_000);

test("a top-level Base UI import shows the DOM until the file's first test, and no further", async () => {
  const report = await run("topLevel.ts");
  expect(report).toContain(" 1 pass");
  expect(seen(report)).toEqual({
    load: "object",
    describe: "object",
    beforeAll: "object",
    test: "undefined",
    afterAll: "undefined",
  });
}, 30_000);

test("a Base UI import inside a test shows the DOM until that test ends, not in afterAll", async () => {
  const report = await run("lazyLast.ts");
  expect(report).toContain(" 1 pass");
  expect(seen(report)).toEqual({ before: "undefined", after: "object", afterAll: "undefined" });
}, 30_000);

test("a require of Base UI gets its CommonJS build whole", () => {
  // The preload's load hook takes Base UI's ES modules only; through it, the
  // CommonJS build came back as an empty object.
  const dialog = require("@base-ui/react/dialog") as { Dialog?: unknown };
  expect(dialog.Dialog).toBeDefined();
});
