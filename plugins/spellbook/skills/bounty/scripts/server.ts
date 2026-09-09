#!/usr/bin/env bun

// LAUNCHER, not the daemon. The implementation is authored at
// `src/bounty/backend/server.ts` and ships BUILT at `../dist/server.js`
// (backend convergence Phase 4 — decisions D2, D6, D12 and D43).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. `cli.ts` spawns the daemon BY PATH,
// and that path is also named by `grimoire/lib/entry-points.ts` and
// `grimoire/exit-site-inventory.test.ts`. Keeping a real `.ts` here is what
// makes the relocation free rather than a prose edit across the roster.
//
// ⚠ AND FOR BOUNTY THAT SPAWN PATH HAD TO CHANGE SHAPE — THE DEFECT GLAMOUR
// SHIPPED AND THE PLAYBOOK PREDICTED HERE BEFORE THIS SPELL WAS TOUCHED.
// bounty's CLI spawned `join(SCRIPT_DIR, "server.ts")` — its own directory —
// correct only while the CLI itself lived in `scripts/`. Bundled into `dist/`
// that resolves to `dist/server.ts`, a file that does not and must not exist:
// the daemon would never start and `open` would report a start timeout after
// its handshake deadline, which reads like a slow first bundle build rather
// than a wrong path. The backend source now resolves this file up-and-back-down
// (`join(SCRIPT_DIR, "..", "scripts", "server.ts")`), which is right from both
// addresses. `grimoire/spawn-path-ward.test.ts` is the instrument.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the daemon's own tests, and would be the second
// implementation this phase exists to remove.
//
// ⚠ THE ONE DIFFERENCE FROM `scripts/cli.ts`, STATED SO IT IS NOT "TIDIED" INTO
// A MATCH. The CLI launcher sets `process.exitCode` and returns, because a CLI's
// stdout is a pipe the caller parses and Bun's stdout is asynchronous on a pipe
// — an explicit exit truncates it. A DAEMON is not that: its teardown has
// already run inside `main` (it awaits its own drain), its stdout is released
// by the CLI after the handshake, and its terminal exit is family E-terminal in
// the exit-site inventory, pinned at THIS file. For bounty the exit is
// load-bearing twice: the signal path (P1f) is redirected INTO the bounded
// teardown that precedes it, and a shutdown WATCHDOG force-exits if that
// teardown does not finish — the property that keeps a 23-minute hang from
// shipping again. The exit is preserved verbatim across the relocation.
//
// `run()` takes NO ARGUMENTS on purpose: the command line belongs to the file
// that PARSES it, which is the daemon source. If this forwarder read the
// argument vector itself it would match the roster enumerator's arg-parsing
// predicate in `grimoire/lib/entry-points.ts`, and this launcher — not the
// daemon — would become the spell's pinned internal entry point.
import { run } from "../dist/server.js";

const exitCode = await run();
process.exit(exitCode);
