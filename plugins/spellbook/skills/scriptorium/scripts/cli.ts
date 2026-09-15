#!/usr/bin/env bun

// LAUNCHER, not the CLI. The implementation is authored at
// `src/scriptorium/backend/cli.ts` and ships BUILT at `../dist/cli.js`
// (seams Contract 4's built-backend amendment). This path is the one SKILL.md
// names, `grimoire/lib/entry-points.ts` enumerates and an installed caller
// types — and it is also the BUILD'S ENTRY PREDICATE: `src/build.ts` builds
// `backend/cli.ts` only because this file exists (D43).
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact and is invisible to the backend's own tests.
//
// NATURAL RETURN — `process.exitCode` and nothing else. The CLI's `main()` does
// not return while the process must live (question 5 of playbook N1), and its
// stdout is a pipe the agent parses: Bun's stdout is asynchronous on a pipe, so
// an explicit exit discards what has not drained (measured at 65,536 bytes).
//
// `run()` takes NO ARGUMENTS: the command line belongs to the file that PARSES
// it, which is the backend source. A forwarder that read the argument vector
// itself would match the roster enumerator's arg-parsing predicate, and the
// flag ward would judge the spell's documented flags against this file. The
// predicate is a text scan, so this comment does not spell the token either.
import { run } from "../dist/cli.js";

process.exitCode = await run();
