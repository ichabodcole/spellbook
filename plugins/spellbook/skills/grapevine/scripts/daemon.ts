#!/usr/bin/env bun

// LAUNCHER, not the daemon. The implementation is authored at
// `src/grapevine/backend/daemon.ts` and ships BUILT at `../dist/daemon.js`
// (seams Contract 4's built-backend amendment; backend convergence Phase 6).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. `backend/cli.ts` spawns the daemon
// BY PATH, and that path is also what `src/grapevine/dev-styled.test.ts` runs
// and what `grimoire/lib/entry-points.ts` enumerates. Keeping a real `.ts` here
// is what makes the relocation free rather than a prose edit across the roster.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the daemon's own tests, and would be the second
// implementation this phase exists to remove.
//
// ⛔ THE SHAPE IS `process.exitCode` + A NATURAL RETURN, AND IT IS **NOT** THE
// SHAPE THE OTHER FIVE SPELLS' DAEMON LAUNCHERS CARRY. Read this before you
// "tidy" it into a match with `imago/scripts/server.ts`.
//
// Playbook Phase B, B2 as amended by D69: the launcher line is decided by ONE
// property — *after `run()` resolves, must this process still be alive?* — and
// "daemon" was only ever a fast way to guess it. Grapevine answers YES, and the
// five spells that went first answered NO. `main()` here resolves the instant
// `Bun.serve` has BOUND: it writes `daemon.port` and `daemon.pid`, prints
// `listening`, registers SIGINT/SIGTERM, and returns. **The EVENT LOOP holds
// this process up, not the promise.** The exit codes are not `run()`'s return
// value at all — they live at in-body `process.exit` calls (the
// already-running branch) and inside `shutdown()`, reached only from a signal.
//
// So `const exitCode = await run(); process.exit(exitCode)` — the shape B2 used
// to prescribe for "a daemon" — resolves to `process.exit(undefined)`, exits 0,
// and the daemon is GONE milliseconds after it bound. **Driven both ways**
// before this port (D69): the terminal shape printed `listening on
// http://127.0.0.1:56250 (pid 18450, mode release)`, wrote both lifecycle
// files, and returned to the shell at exit 0; the natural return stayed up and
// answered `GET /` with `{"ok":true,…}`.
//
// ⛔ AND THE SYMPTOM IS TWO OTHER DEFECTS' SIGNATURE, WHICH IS WHY IT COSTS A
// DAY TO GUESS WRONG. The port file is written before the exit, so the CLI's
// `readDaemonPort()` finds it, pings it, gets nothing, deletes it as stale, and
// the 3 s poll loop runs out: `daemon failed to start within 3s` — the exact
// string a WRONG SPAWN PATH produces (B4; grapevine genuinely had that defect
// too, `join(SCRIPT_DIR, "daemon.ts")`, fixed in the same chapter as this file
// was written) and the exact string `backend/cli.ts`'s own comment attributes
// to a dev-mode daemon dying at its surface import. Three defect classes, one
// sentence.
//
// ⛔ DISCRIMINATE BY DRIVING THIS LAUNCHER ALONE, WITH NO CLI IN THE PICTURE —
// and read the WHOLE outcome, not just "did I get my prompt back". The short
// form this comment used to carry ("if it returns to your shell, it is this and
// nothing else") is a FALSE BICONDITIONAL: a wrong spawn path is not reachable
// this way at all, and the dev-mode import failure ALSO returns you to your
// shell — at exit 1, with a module error. The sound test is:
//
//   returns to your shell HAVING PRINTED `listening on …`, AT EXIT 0
//     → the launcher shape, and nothing else.
//   returns at a NON-ZERO exit with a module/import error, nothing printed
//     → the surface-import class (run from a source-free install, or in dev).
//   stays up and answers `GET /`
//     → the launcher is right; the defect is on the CLI side (the spawn path).
//
// ⚠ AND THE PORT FILE IS NOT THE DISCRIMINATOR IT LOOKS LIKE. "Cause 1 creates
// the port file, cause 2 never does" is true and nearly unobservable: the CLI's
// `readDaemonPort()` pings the orphan and UNLINKS it in its first 50 ms poll —
// deterministic, at `backend/cli.ts:364-387`. Sampled by the verify pass that
// found this: six `ls` at 500 ms across the window never saw it, and a busy loop
// caught it in 1.0 % of samples. The observable that actually separates them is
// `channels/`: `ensureDirs()` runs on the boot path, so a daemon that BOUND and
// died leaves the directory behind, while a spawn that never ran and an import
// that died before `ensureDirs()` both leave `GRAPEVINE_HOME` completely empty
// (which is what `release-serve.test.ts`'s forced-dev cell asserts).
//
// `run()` takes NO ARGUMENTS on purpose: this daemon parses none, and a
// forwarder that read the argument vector would match the roster enumerator's
// arg-parsing predicate in `grimoire/lib/entry-points.ts` — which would put a
// launcher into a population whose members are caller-facing interfaces.
import { run } from "../dist/daemon.js";

process.exitCode = await run();
