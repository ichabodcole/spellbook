/**
 * The addresses mind-mapper's own test suite needs, derived ONCE.
 *
 * ⛔ TEST-ONLY, AND NEITHER ENTRY IMPORTS IT. It is a non-test module under
 * `backend/`, so it is a legitimate backend source — but `cli.ts` and
 * `server.ts` do not reach it, so it is in no bundle, it is not an entry (there
 * is no `scripts/paths.ts` launcher, which is what `src/build.ts` derives an
 * entry from, D43), and nothing it says ships.
 *
 * ⛔ WHY IT EXISTS: THE SUITE AND ITS SUBJECT ARE NOW IN DIFFERENT TREES, AND NO
 * NUMBER OF `..` REACHES ACROSS. The 32 test files moved to
 * `src/mind-mapper/backend/`; the process a caller runs lives at
 * `plugins/spellbook/skills/mind-mapper/`. Playbook B6 says "re-derive every
 * path from an explicit SKILL ROOT, never by counting `..`" and then assumes you
 * still have one. This is it — and it is derived by walking up for a repo-root
 * MARKER, which is the house form and a scar rather than a taste: a sibling
 * spell's copy counted `..`, a non-author placed the file at a different depth,
 * and BOTH arms died at spawn — which reads as a broken daemon, not as a wrong
 * path. The marker also fails LOUDLY and by name, which a wrong `..` never does.
 *
 * ⛔ AND THE THREE ADDRESSES ARE NOT INTERCHANGEABLE. Sort every reference to a
 * moved entry by what it NEEDS (playbook B6.1, and mind-mapper is the spell that
 * grew the third category):
 *
 *   a PROCESS SPAWN      → the LAUNCHER (`CLI_LAUNCHER` / `SERVER_LAUNCHER`).
 *                          The launcher imports `../dist/<entry>.js`, which is
 *                          what a caller actually runs.
 *   a SOURCE SCAN        → the SOURCE (`CLI_SOURCE`). A regex over the launcher
 *                          finds none of what it pins and fails as a broken
 *                          regex, not as a wrong file.
 *   a SYMBOL IMPORT      → the SOURCE, by ordinary relative specifier
 *                          (`./server.ts`). Not spelled here because the
 *                          importers sit beside their subject.
 *
 * ⚠ Getting either of the first two wrong is silent in both directions: a
 * spawner left pointing at the source boots NOTHING at exit 0 (there is no
 * `import.meta.main` block any more), and an importer pointed at the launcher
 * gets a file that exports nothing at all.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up for the repo-root marker. Loud and by name when it fails. */
function repoRoot(from: string): string {
  let d = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".anthill", "config.json"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`repo root marker (.anthill/config.json) not found above ${from}`);
}

/** The deployed skill folder — launchers, `dist/`, `acc.config.json`. */
export const SKILL_ROOT = join(
  repoRoot(import.meta.dir),
  "plugins",
  "spellbook",
  "skills",
  "mind-mapper",
);

/** `dist/`, the served directory — which now also holds the two bundles. */
export const DIST_DIR = join(SKILL_ROOT, "dist");

/** SPAWN THIS to exercise the CLI as a process. */
export const CLI_LAUNCHER = join(SKILL_ROOT, "scripts", "cli.ts");

/** SPAWN THIS to exercise the daemon as a process. */
export const SERVER_LAUNCHER = join(SKILL_ROOT, "scripts", "server.ts");

/** SCAN THIS when the assertion is about the CLI's own text. */
export const CLI_SOURCE = join(import.meta.dir, "cli.ts");

/**
 * The daemon's dev-mode cwd — `src/mind-mapper/`, where `bunfig.toml` lives.
 * Bun reads `bunfig.toml` from cwd ONLY (seams Contract 5's cwd pin), so a
 * dev-mode daemon spawned anywhere else cannot compile the surface stylesheet.
 * ⚠ Derived from the repo root here, NOT from a five-level climb off the test
 * file: three suites carried that climb, identically, and it was correct only
 * while they sat in `scripts/`.
 */
export const SURFACE_CWD = join(repoRoot(import.meta.dir), "src", "mind-mapper");
