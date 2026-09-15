#!/usr/bin/env bun

// LAUNCHER, not the CLI. The implementation is authored at
// `src/bounty/backend/cli.ts` and ships BUILT at `../dist/cli.js`
// (seams Contract 4's built-backend amendment; backend convergence Phase 4).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. The emitted bundle lives under
// `dist/` because every instrument here already defines "generated" as "under
// dist/" — but `scripts/cli.ts` is the path SKILL.md names, the path
// `grimoire/exit-site-inventory.test.ts`, `grimoire/terminator-invariant.test.ts`
// and `grimoire/lib/entry-points.ts` all pin, and the path an installed spell's
// caller types (`bun ${CLAUDE_PLUGIN_ROOT}/skills/bounty/scripts/cli.ts <verb>`,
// spelled that way in SKILL.md). Keeping a real `.ts` here is what makes the
// relocation free instead of a roster-wide prose edit.
//
// ⚠ AND FOR BOUNTY THIS FILE USED TO BE THE 1,506-LINE CLI ITSELF, WHICH IS THE
// STATE `grimoire/launcher-pairing-ward.test.ts` CELL C EXISTS FOR. A real
// `scripts/cli.ts` beside a `src/bounty/backend/cli.ts` makes `cli` a derived
// entry (D43) whose emitted artifact nothing imports. The import below is what
// closes that.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the backend's own tests, and would be the second
// implementation this phase exists to remove.
//
// `process.exitCode` + a natural return, NEVER `process.exit(code)` — this is
// now the site where the process ends, so the drained-exit rule lives here:
// Bun's stdout is ASYNCHRONOUS on a pipe, so an explicit exit discards whatever
// has not drained (measured at exactly 65,536 bytes), and the caller gets
// well-formed-looking JSON that stops mid-string. bounty's `state` on a real
// board is exactly that payload, and this spell has already paid for it once:
// a reader concluded "our board is too big to read" and three agents worked
// under that false rule. The full account is in the backend source's own entry
// block.
//
// `run()` takes NO ARGUMENTS on purpose: the command line belongs to the file
// that PARSES it, which is the backend source. If this forwarder read the
// argument vector itself it would match the roster enumerator's arg-parsing
// predicate in `grimoire/lib/entry-points.ts`, and the flag ward would then
// judge this spell's documented flags against a file that recognises none.
//
// ⛔ AND THE PREDICATE IS A TEXT SCAN, SO THIS COMMENT MUST NOT SPELL THE
// TOKEN EITHER — prose and code are indistinguishable to a regex.
import { run } from "../dist/cli.js";

process.exitCode = await run();
