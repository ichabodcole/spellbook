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
// home out. NOT keyed on `Bun.jest`: it is a function in every Bun process, so
// it made every plain run refuse the real home, and every spell on the kit with
// it.
//
// A test run is known two ways, either one enough (`underTest`):
// - `NODE_ENV=test`. `bun test` sets it only when it is UNSET: under
//   `NODE_ENV=development bun test` it stays "development" (measured on Bun
//   1.4.0). So the preload (`scratchHome.ts`) sets it outright, and every child
//   that inherits the environment carries it.
// - a scratch `HOME`, the preload's shape. Only the preload makes one, so a
//   process that has it is a test run, or a child of one, even when something
//   reset its `NODE_ENV` on the way.
// A run with neither has no preload, so its home is the real one: the
// unpreloaded run under a preset `NODE_ENV` is not caught here, and is the
// ward's to catch (every bunfig.toml preloads `scratchHome.ts`).
//
// The ward `grimoire/kit-scratch-home-ward.test.ts` holds the kit to this: no
// other kit file names `homedir`.

import { homedir, userInfo } from "node:os";

/** The shape of the preload's scratch home: `<temp>/spellbook-test/run-<pid>-…/home`. */
const SCRATCH_HOME = /\/spellbook-test\/run-\d+-[^/]+\/home$/;

/**
 * Whether this process is a test run, or a child one started: `NODE_ENV=test`,
 * or a HOME of the preload's scratch shape (either one; see the top of the file).
 *
 * ⛔ READ THROUGH A PARAMETER, NEVER AS `process.env.NODE_ENV`. A bundler that
 * defines `process.env.NODE_ENV` (Spellbook's backend build pins it to
 * "production", so dependencies resolve their production builds) rewrites that
 * exact member chain, and this check compiles to `false`: every under-test
 * guard on it (the real home, the real Trash) is gone from the built daemon a
 * test spawns. `env.NODE_ENV` on a parameter is not the chain, so it survives.
 */
export function underTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || SCRATCH_HOME.test(env.HOME ?? "");
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

/**
 * The account's own home, from the user database, whatever `HOME` says (Bun's
 * `os.homedir()` answers `HOME` when it is set). NOT a home to read or write
 * in: it is for guards that must recognise the real home under any `HOME` — a
 * test preload's scratch one, or a caller's. Null when the system cannot say.
 */
export function accountHome(): string | null {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}
