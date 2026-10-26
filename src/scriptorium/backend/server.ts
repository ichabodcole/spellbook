/**
 * scriptorium's per-session daemon — the entry the launcher
 * (`plugins/spellbook/skills/scriptorium/scripts/server.ts`) imports, built
 * into `dist/server.js`. It is the kit's workspace daemon under Scriptorium's
 * name (`./kit/server.ts`), which owns the page it serves, the routes, the
 * session and its teardown.
 *
 * ⛔ The shipped Scriptorium's daemon that lived in this file was deleted at
 * the cutover (item scriptorium-delete-shipped).
 *
 * ── THE EIGHT QUESTIONS (scaffolding playbook N1), ANSWERED AS DESIGN ──────
 *
 * 1. Arithmetic: none here. `./kit/server.ts` finds the built page in its own
 *    folder, which in the bundle is `dist/`.
 * 2. Serves: YES, through the kit daemon: `/` is the built `index.html`.
 * 3. Second half: YES — `./cli.ts`, which spawns this through the launcher.
 * 4. Lifecycle: long-running, one daemon per session, idle-timeout.
 * 5. `main()` returns while the process must live? NO — the kit daemon's run
 *    awaits the session's end and its drain, so the launcher is TERMINAL-EXIT
 *    (`process.exit(await run())`).
 * 6. Event ids recovered across restart? NO — the log is per boot and stamped
 *    with an epoch, which the tail reads.
 * 7. A kit subject in a different shape? No: the daemon is the kit's.
 * 8. A kit module names this spell as its source? No.
 */

import { runKitDaemon } from "./kit/server";

/**
 * The daemon's entry, for the LAUNCHER. `import.meta.main` is FALSE in the
 * bundle, so there is no such block here, and this takes no arguments: the
 * command line belongs to the file that parses it.
 */
export async function run(): Promise<number> {
  return await runKitDaemon(process.argv.slice(2));
}
