#!/usr/bin/env bun

// LAUNCHER, not the daemon. The implementation is authored at
// `src/mind-mapper/backend/server.ts` and ships BUILT at `../dist/server.js`
// (backend convergence Phase 7 — the last port).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. `cli.ts` spawns the daemon by path,
// and that path is also the key `grimoire/lib/entry-points.ts` excludes as an
// INTERNAL entry point (the daemon's argv is private — `--port`, `--host`,
// `--no-open`) and the address `grimoire/exit-site-inventory.test.ts` pins as
// family E-terminal. Keeping a real `.ts` here is what makes the relocation
// free rather than a prose edit across the roster.
//
// ⚠ AND FOR MIND-MAPPER THE SPAWN EXPRESSION HAD TO CHANGE SHAPE, WHICH IS
// GLAMOUR'S SCAR ARRIVING AT A SECOND SPELL. The CLI spawned
// `join(SCRIPT_DIR, "server.ts")` — its own directory — which was correct only
// for as long as the CLI and the daemon shared a folder. Bundled into `dist/`
// that resolves to `dist/server.ts`, a file that does not and must not exist:
// the daemon would never start and `open` would poll to "daemon did not come up
// within 10s", which reads like a slow first bundle build. The backend source
// now resolves this file UP AND BACK DOWN (`.. / scripts / server.ts`), which is
// right from both addresses. `grimoire/spawn-path-ward.test.ts` is the
// instrument — and until this port it produced ZERO coverage rows for
// mind-mapper while listing it in its population header, because `dist/` held
// only a surface. The rows switch on with this commit.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the daemon's own tests, and would be the second
// implementation this phase exists to remove.
//
// ⚠ THE ONE DIFFERENCE FROM `scripts/cli.ts`, STATED SO IT IS NOT "TIDIED" INTO
// A MATCH. The CLI launcher sets `process.exitCode` and returns, because a CLI's
// stdout is a pipe the caller parses and Bun's stdout is asynchronous on a pipe
// — an explicit exit truncates it. A DAEMON is not that: mind-mapper's `main`
// awaits a SIGNAL-RESOLVED promise and then runs its own teardown, so nothing
// is left holding the process open when it returns (playbook B2's second row —
// the property is "must this process still be alive after `main` resolves?",
// and the answer here is no). Its terminal exit is family E-terminal in the
// exit-site inventory, pinned at THIS file, and preserved verbatim across the
// relocation on purpose.
//
// `run()` takes NO ARGUMENTS on purpose: the command line belongs to the file
// that PARSES it, which is the daemon source. If this forwarder read the
// argument vector itself it would match the roster enumerator's arg-parsing
// predicate in `grimoire/lib/entry-points.ts`, and this launcher — not the
// daemon — would become the spell's pinned internal entry point.
import { run } from "../dist/server.js";

const exitCode = await run();
process.exit(exitCode);
