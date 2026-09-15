#!/usr/bin/env bun

// LAUNCHER, not the CLI. The implementation is authored at
// `src/grapevine/backend/cli.ts` and ships BUILT at `../dist/cli.js`
// (seams Contract 4's built-backend amendment; backend convergence Phase 6).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. `dist/` is where every instrument in
// this repo already defines "generated" to be, so the bundle goes there — but
// `scripts/cli.ts` is the path SKILL.md names, the path
// `grimoire/lib/entry-points.ts` enumerates, the path `flag-invariant` and
// `terminator-invariant` pin, and the path an installed caller types. Keeping a
// real `.ts` here is what makes the relocation free instead of a roster-wide
// prose edit.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the backend's own tests, and would be the second
// implementation this phase exists to remove.
//
// THE SHAPE, AND THE QUESTION IT ANSWERS. Playbook Phase B, B2 as amended by
// D69: the discriminator is *after `run()` resolves, must this process still be
// alive?* For the CLI the answer is NO and nothing is left holding it open —
// every verb has finished by the time `main` returns. So either shape would
// work, and the tie is broken by the stdout contract: `tail` writes JSONL an
// agent parses, and Bun's stdout is ASYNCHRONOUS on a pipe (synchronous on a
// TTY or file), so an explicit exit discards whatever has not drained —
// measured at exactly 65,536 bytes, and the caller receives well-formed-LOOKING
// JSON that stops mid-string. Reproduced, fixed and gated in bounty first
// (P0, #77/#78). `process.exitCode` + a natural return, never `process.exit`.
// Do not tidy this into a match with `scripts/daemon.ts`, which is a DIFFERENT
// case for a different reason — read that file's block before you touch either.
//
// `run()` takes NO ARGUMENTS on purpose: the command line belongs to the file
// that PARSES it, which is the backend source. If this forwarder read the
// argument vector itself it would match the roster enumerator's arg-parsing
// predicate in `grimoire/lib/entry-points.ts`, and the flag ward would then
// judge this spell's 26 documented flags against a file that recognises none.
//
// ⛔ AND THAT PREDICATE IS A TEXT SCAN, SO THIS COMMENT MUST NOT SPELL THE
// TOKENS EITHER — prose and code are indistinguishable to a regex, and an
// earlier draft of a sibling launcher re-tripped the ward from inside the
// paragraph warning against it.
import { run } from "../dist/cli.js";

process.exitCode = await run();
