#!/usr/bin/env bun

// LAUNCHER, not the CLI. The implementation is authored at
// `src/mind-mapper/backend/cli.ts` and ships BUILT at `../dist/cli.js`
// (seams Contract 4's built-backend amendment; backend convergence Phase 7 —
// the LAST of the seven ports, and the spell two of the kit's modules were
// converged toward by name).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. The emitted bundle lives under
// `dist/` because every instrument here already defines "generated" as "under
// dist/" — but `scripts/cli.ts` is the path `grimoire/lib/entry-points.ts`
// enumerates, the path `grimoire/terminator-invariant.test.ts` pins, and the
// path an installed spell's caller types. ⚠ MIND-MAPPER HAS NO `SKILL.md`, so
// unlike its six siblings this path is named by no published document at all —
// Cole ruled the undeclared state intentional and correct (`47238d7`), the
// entry set is therefore derived from `scripts/` alone, and the port does not
// write one. Keeping a real `.ts` here is still what makes the relocation free
// rather than a roster-wide prose edit.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the backend's own tests, and would be the second
// implementation this phase exists to remove.
//
// `process.exitCode` + a natural return, NEVER `process.exit(code)` — this is
// now the site where the process ends, so the drained-exit rule lives here:
// Bun's stdout is ASYNCHRONOUS on a pipe, so an explicit exit discards whatever
// has not drained (measured at exactly 65,536 bytes), and the caller gets
// well-formed-looking JSON that stops mid-string. mind-mapper ships large
// stdout payloads (`state` on a full board, `search`, `doc`), so this is not
// theoretical for this spell. The full account is in the backend source's own
// entry block, and the CLI has ZERO live `process.exit` sites for exactly this
// reason — `grimoire/exit-site-inventory.test.ts` records it as the direction
// that inventory exists to push.
//
// `run()` takes NO ARGUMENTS on purpose: the command line belongs to the file
// that PARSES it, which is the backend source. If this forwarder read the
// argument vector itself it would match the roster enumerator's arg-parsing
// predicate in `grimoire/lib/entry-points.ts`, and the flag ward would then
// judge this spell's flags against a file that recognises none.
//
// ⛔ AND THE PREDICATE IS A TEXT SCAN, SO THIS COMMENT MUST NOT SPELL THE
// TOKEN EITHER. An earlier draft of astrolabe's twin explained the rule using
// the literal identifier and re-tripped the ward from inside the paragraph
// warning against it — prose and code are indistinguishable to a regex.
import { run } from "../dist/cli.js";

process.exitCode = await run();
