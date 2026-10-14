// The user's home folder, as the kit reads it.
//
// The kit reads `HOME` from the environment first, and `os.homedir()` only when
// `HOME` is unset. In a shell the two agree. They differ in one place: Bun's
// `os.homedir()` is fixed when the process starts, so a test preload that sets
// `HOME` (`scratchHome.ts`) cannot move it. Reading the environment is what lets
// the preload keep every kit test out of the real home.
//
// The ward `grimoire/kit-scratch-home-ward.test.ts` holds the kit to this: no
// other kit file imports `homedir` from `node:os`.

import { homedir } from "node:os";

/** The home folder: `HOME` when it is set, else the OS's answer. */
export function homeDir(): string {
  return process.env.HOME || homedir();
}
