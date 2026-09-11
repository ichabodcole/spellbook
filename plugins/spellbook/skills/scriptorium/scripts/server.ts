#!/usr/bin/env bun

// LAUNCHER, not the daemon. The implementation is authored at
// `src/scriptorium/backend/server.ts` and ships BUILT at `../dist/server.js`.
// `cli.ts` spawns the daemon by THIS path (resolved up and back down from
// `dist/`, never as a flat sibling), and its existence is what makes
// `backend/server.ts` a build entry at all (D43).
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact and is invisible to the daemon's own tests.
//
// ⚠ TERMINAL EXIT, AND IT DIFFERS FROM `scripts/cli.ts` ON PURPOSE — do not tidy
// the two into a match. The daemon's `main()` awaits the session's end AND its
// own drain before it resolves, so by the time it returns the teardown has run
// and nothing may keep the process alive; a leftover directory watcher or a
// wedged socket would. glamour's server has the same shape, and this launcher
// is family E-terminal in the exit-site inventory. The CLI releases this
// process's stdout after the handshake, so no pipe is truncated here.
//
// `run()` takes NO ARGUMENTS: the command line belongs to the file that parses
// it, which is the daemon source.
import { run } from "../dist/server.js";

const exitCode = await run();
process.exit(exitCode);
