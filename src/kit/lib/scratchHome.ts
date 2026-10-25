// The test preload (every bunfig.toml in the repo) that gives every test
// process a scratch home folder, so no test can write into the real one.
//
// A test that reaches the home folder (the workspace's `defaultWorkspace`, a
// spell CLI that keeps its state under `~`) must find an empty folder of its
// own. A foundation-cycle verifier once wrote a channel into the real
// grapevine because nothing set one.
//
// Each run gets `<temp>/spellbook-test/run-<pid>-<random>/`, holding two
// folders: `home/` becomes `HOME`, and `tmp/` becomes `TMPDIR`. The temp folder
// moves too because the home must not sit inside it: `defaultWorkspace`
// refuses a workspace at or above the home, and a test that steps out of a
// folder in the temp folder lands on the temp folder itself.
//
// ⛔ CLEANUP. Under `bun test`, `process.on("exit")` never fires (measured on
// Bun 1.4.0: a whole run left its folder, about 14 MB with Bun's transpiler
// cache under `home/`). A global `afterAll` registered here does fire, once,
// after the last file. A run that dies before it (a crash, a kill) leaves its
// folder, so every run first removes the folders of runs whose process is gone,
// read from the pid in each folder's name. A live run's folder is never
// touched.
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

import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The one folder every run's scratch folder sits in. */
export const SCRATCH_PARENT = "spellbook-test";
const RUN = /^run-(\d+)-/;

/** Whether a process with this pid is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, and belongs to someone else.
    return (e as { code?: string }).code === "EPERM";
  }
}

/** Removes the run folders under `parent` whose process is gone. */
export function pruneDeadRuns(parent: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(RUN.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    try {
      rmSync(join(parent, name), { recursive: true, force: true });
    } catch {
      // Another run pruning the same folder got there first.
    }
  }
}

const parent = join(realpathSync(tmpdir()), SCRATCH_PARENT);
mkdirSync(parent, { recursive: true });
pruneDeadRuns(parent);
const scratch = mkdtempSync(join(parent, `run-${process.pid}-`));
const home = join(scratch, "home");
const tmp = join(scratch, "tmp");
mkdirSync(home);
mkdirSync(tmp);
process.env.HOME = home;
process.env.TMPDIR = tmp;
// ⛔ SET, NOT DEFAULTED. `bun test` sets NODE_ENV=test only when it is unset,
// so `NODE_ENV=development bun test` ran every under-test guard (the real home
// refused, the real Trash refused) as a plain run. Set here, it holds in this
// process and in every child that inherits the environment (`home.ts`).
process.env.NODE_ENV = "test";
// ⚠ UNDER `--rerun-each` THE afterAll FIRES AFTER EVERY RERUN, while this
// preload runs once, so the second rerun found its TMPDIR gone and any file
// making a temp folder as it loads died with ENOENT before a test ran
// (measured on Bun 1.4.0 with links.integration.test.ts). So under that flag
// the two folders are made again, empty, after each removal; the last rerun
// leaves them, and the next run prunes them as a dead run's. Bun keeps its own
// flags out of `process.argv`, so the flag is read from the process's command
// line; where `ps` cannot answer, the folder is removed as before.
function underRerunEach(): boolean {
  try {
    const ps = Bun.spawnSync(["ps", "-o", "args=", "-p", String(process.pid)], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    return /(^|\s)--rerun-each(=|\s)/.test(ps.stdout.toString());
  } catch {
    return false;
  }
}
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // A folder a child still holds open is pruned by the next run.
  }
  if (underRerunEach()) {
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });
  }
});
