#!/usr/bin/env bun

// LAUNCHER, not the daemon. The implementation is authored at
// `src/magpie/backend/server.ts` and ships BUILT at `../dist/server.js`
// (backend convergence Phase 1b, chapter 1 — decisions D2 and D6).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. `cli.ts` spawns
// `join(SCRIPT_DIR, "..", "scripts", "server.ts")`, and that path is also named
// by `grimoire/lib/entry-points.ts` and `grimoire/exit-site-inventory.test.ts`.
// Keeping a real `.ts` here is what makes the relocation free rather than a
// prose edit across the roster — exactly as `scripts/cli.ts` did for the CLI.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the daemon's own tests, and would be the second
// implementation this phase exists to remove.
//
// ⚠ AND THE ONE DIFFERENCE FROM `scripts/cli.ts`, STATED SO IT IS NOT "TIDIED"
// INTO A MATCH. The CLI launcher sets `process.exitCode` and returns, because a
// CLI's stdout is a pipe the caller parses and Bun's stdout is asynchronous on a
// pipe — an explicit exit truncates it. A DAEMON is not that: its teardown has
// already run inside `main` (it awaits its own drain and races `server.stop`),
// its stdout is `"ignore"` in the detached spawn, and its terminal exit is
// family E-terminal in the exit-site inventory, pinned at THIS file. The exit is
// preserved verbatim across the relocation on purpose (Phase 1b brief,
// measurement 7): D8 made `die` throw for the two CLIs; a daemon's terminal exit
// is a different case and was not in scope to change.
//
// `run()` takes NO ARGUMENTS on purpose: the command line belongs to the file
// that PARSES it, which is the daemon source. If this forwarder read the
// argument vector itself it would match the roster enumerator's arg-parsing
// predicate in `grimoire/lib/entry-points.ts`, and this launcher — not the
// daemon — would become the spell's pinned internal entry point.
import { run } from "../dist/server.js";

const exitCode = await run();
process.exit(exitCode);
