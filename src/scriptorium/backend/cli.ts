/**
 * scriptorium CLI — the entry the launcher (`scripts/cli.ts`) imports, built
 * into `dist/cli.js`. It hands the command line to the kit's workspace CLI
 * under Scriptorium's name (`./kit/cli.ts`), with the three things only this
 * file can know, because only here is `import.meta.url` the bundle's own
 * address: the daemon launcher, the daemon's working directory, and the
 * plugin's version.
 *
 * ⛔ The shipped Scriptorium that lived in this file was deleted at the
 * cutover (item scriptorium-delete-shipped). Its sessions are converted by the
 * daemon the first time it restores them (`./kit/convert.ts`).
 *
 * ── THE EIGHT QUESTIONS (scaffolding playbook N1), ANSWERED AS DESIGN ──────
 *
 * 1. Arithmetic: NONE carried beyond what is true at the emitted address.
 *    From `dist/cli.js`, `..` is the skill folder, so the daemon launcher is
 *    `../scripts/server.ts` (up and back down — never a flat sibling), and the
 *    dev cwd is `src/scriptorium/` five levels up (Contract 5), used only when
 *    dev mode is resolved.
 * 2. Serves: no.
 * 3. Second half: YES — the daemon (`./server.ts`), spawned through its
 *    launcher; the two share the kit's workspace protocol.
 * 4. Lifecycle: single-shot per verb; `tail` is long-running and returns its
 *    own exit code.
 * 5. `main()` returns while the process must live? NO → NATURAL-RETURN
 *    launcher (`process.exitCode = await run()`): stdout is a pipe the agent
 *    parses, and an explicit exit truncates it at 64 KiB.
 * 6. Event ids across restart: the daemon's are per-boot and epoch-stamped;
 *    the kit's tail resets its cursor on an epoch change and says so.
 * 7. A kit subject in a different shape? No: the CLI is the kit's.
 * 8. A kit module names this spell as its source? No.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runKitCli } from "./kit/cli";

const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
const SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "scriptorium");

/**
 * Contract 5: a dev daemon must run with cwd at `src/scriptorium/`, where the
 * bunfig that loads the Tailwind plugin is: Bun's dev server reads it only
 * from the daemon's cwd. Release when the built page (`dist/index.html`) is
 * there; the env var overrides.
 */
export function daemonCwd(): string {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release") return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev") return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}

/** `--version`: the plugin's version, from its manifest beside the skills. */
function versionInfo(): { name: string; version: string } {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string") return { name: "scriptorium", version: pkg.version };
  } catch {
    /* fall through */
  }
  return { name: "scriptorium", version: "unknown" };
}

/**
 * The CLI's entry, for the LAUNCHER. Returns the code rather than exiting
 * (stdout is a pipe; an explicit exit truncates it), and takes no arguments
 * (the command line belongs to the file that parses it).
 */
export async function run(): Promise<number> {
  return await runKitCli(process.argv.slice(2), {
    serverScript: SERVER_SCRIPT,
    daemonCwd,
    version: versionInfo,
  });
}
