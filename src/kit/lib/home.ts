// The user's home folder, as the kit reads it.
//
// The kit reads `HOME` from the environment first, and `os.homedir()` only when
// `HOME` is unset. In a shell the two agree. They differ in one place: Bun's
// `os.homedir()` is fixed when the process starts, so a test preload that sets
// `HOME` (`scratchHome.ts`) cannot move it. Reading the environment is what lets
// the preload keep every kit test out of the real home.
//
// ⛔ UNDER A TEST RUN, A HOME THAT IS NOT A SCRATCH ONE IS REFUSED. `bun test`
// reads only the bunfig.toml in its cwd, so a run started from a folder with
// none (src/kit/, grimoire/, a spell's backend/) has no preload and the real
// home. Rather than hope a ward is in that run, the kit refuses to hand that
// home out. A test run is known by `NODE_ENV=test` alone, which `bun test`
// sets in its process, with or without a preload, and its children inherit
// (measured on Bun 1.4.0; a plain `bun` leaves it unset). NOT by `Bun.jest`:
// it is a function in every Bun process, so it made every plain run refuse the
// real home, and every spell on the kit with it.
//
// The ward `grimoire/kit-scratch-home-ward.test.ts` holds the kit to this: no
// other kit file names `homedir`.

import { homedir } from "node:os";

/** The shape of the preload's scratch home: `<temp>/spellbook-test/run-<pid>-…/home`. */
const SCRATCH_HOME = /\/spellbook-test\/run-\d+-[^/]+\/home$/;

/** Whether this process is a test run, or a child one started. */
export function underTest(): boolean {
  return process.env.NODE_ENV === "test";
}

/** The home folder: `HOME` when it is set, else the OS's answer. */
export function homeDir(): string {
  const home = process.env.HOME || homedir();
  if (underTest() && !SCRATCH_HOME.test(home))
    throw new Error(
      `refusing the real home folder (${home}) in a test run: no scratch HOME was preloaded. ` +
        "Run `bun test` from the repo root or a spell's folder, whose bunfig.toml preloads " +
        "src/kit/lib/scratchHome.ts, or pass --preload <repo>/src/kit/lib/scratchHome.ts.",
    );
  return home;
}
