#!/usr/bin/env bun

// LAUNCHER, not the CLI. The implementation is authored at
// `src/magpie/backend/cli.ts` and ships BUILT at `../dist/cli.js`
// (seams Contract 4's built-backend amendment, ruled 2026-08-31).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. The emitted bundle lives under
// `dist/` because every instrument here already defines "generated" as "under
// dist/" — but `scripts/cli.ts` is the path named 27 times across the two
// SKILL.md files and launched by `grimoire/exit-site-inventory.test.ts` and
// `grimoire/terminator-invariant.test.ts`. Keeping a real `.ts` here is what
// makes the location ruling free instead of a 27-site prose edit.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the backend's own tests, and would be the second
// implementation this slice exists to remove.
//
// `process.exitCode` + a natural return, NEVER `process.exit(code)` — this is
// now the site where the process ends, so the P0 drained-exit rule lives here:
// Bun's stdout is ASYNCHRONOUS on a pipe, so an explicit exit discards whatever
// has not drained (measured at exactly 65,536 bytes), and the caller gets
// well-formed-looking JSON that stops mid-string. The full account is in the
// backend source's own entry block. Do not tidy this into an explicit exit.
//
// `run()` takes NO ARGUMENTS on purpose: the command line belongs to the file
// that PARSES it, which is the backend source. If this forwarder read the
// argument vector itself it would match the roster enumerator's arg-parsing
// predicate in `grimoire/lib/entry-points.ts`, and the flag ward would then
// judge this spell's documented flags against a file that recognises none.
//
// ⛔ AND THE PREDICATE IS A TEXT SCAN, SO THIS COMMENT MUST NOT SPELL THE
// TOKEN EITHER. An earlier draft explained the rule using the literal
// identifier and re-tripped the ward from inside the paragraph warning
// against it — prose and code are indistinguishable to a regex.
import { run } from "../dist/cli.js";

process.exitCode = await run();
