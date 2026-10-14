// The test preload (root bunfig.toml) that gives every test process a scratch
// home folder, so no test can write into the real one.
//
// A test that reaches the home folder (the workspace's `defaultWorkspace`, a
// spell CLI that keeps its state under `~`) must find an empty folder of its
// own. A foundation-cycle verifier once wrote a channel into the real
// grapevine because nothing set one.
//
// One scratch folder holds two: `home/` becomes `HOME`, and `tmp/` becomes
// `TMPDIR`. The temp folder moves too because the home must not sit inside it:
// `defaultWorkspace` refuses a workspace at or above the home, and a test that
// steps out of a folder in the temp folder lands on the temp folder itself.
// With the home inside it, that step would be refused for the wrong reason.
//
// What it covers, and what it cannot (measured on Bun 1.4.0):
// - In this process, `process.env.HOME` is the scratch home. The kit reads its
//   home through `homeDir()` (`home.ts`), which reads `HOME` first.
// - Bun's `os.homedir()` answers the home the process STARTED with, so code
//   that calls it directly still sees the real one. The kit has no such call
//   outside `home.ts` (the ward checks). `os.tmpdir()` does follow `TMPDIR`.
// - A child started with `env: { ...process.env }`, or through
//   `node:child_process` (which passes `process.env`), starts with the scratch
//   folders, and its own `os.homedir()` answers the scratch home.
// - A child started by `Bun.spawn` with no `env` gets the environment this
//   process STARTED with: the real home. Kit tests pass `env` (the ward checks).
//
// The ward is `grimoire/kit-scratch-home-ward.test.ts`.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "spellbook-test-")));
const home = join(scratch, "home");
const tmp = join(scratch, "tmp");
mkdirSync(home);
mkdirSync(tmp);
process.env.HOME = home;
process.env.TMPDIR = tmp;
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // A folder a child still holds open is left for the OS to clear.
  }
});
