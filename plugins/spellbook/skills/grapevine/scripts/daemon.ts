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
// sentence. Discriminate by driving THIS launcher alone, with no CLI in the
// picture: if it returns to your shell, it is this class and nothing else.
//
// `run()` takes NO ARGUMENTS on purpose: this daemon parses none, and a
// forwarder that read the argument vector would match the roster enumerator's
// arg-parsing predicate in `grimoire/lib/entry-points.ts` — which would put a
// launcher into a population whose members are caller-facing interfaces.
import { run } from "../dist/daemon.js";

process.exitCode = await run();
