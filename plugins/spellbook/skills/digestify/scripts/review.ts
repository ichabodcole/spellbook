#!/usr/bin/env bun

// LAUNCHER, not the review daemon. The implementation is authored at
// `src/digestify/backend/review.ts` and ships BUILT at `../dist/review.js`
// (seams Contract 4's built-backend amendment; backend convergence Phase 5).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. The emitted bundle lives under
// `dist/` because every instrument here already defines "generated" as "under
// dist/" — but `scripts/review.ts` is the path SKILL.md names, the path
// `grimoire/lib/entry-points.ts` enumerates, the path `src/digestify`'s own
// `dev-styled.test.ts` spawns, and the path an installed spell's caller types.
// Keeping a real `.ts` here is what makes the relocation free instead of a
// roster-wide prose edit.
//
// ⛔ DIGESTIFY IS THE SPELL'S WHOLE ENTRY SET — ONE ENTRY, NOT TWO. There is no
// `cli.ts` here and there must not be one: `review.ts` IS the process the agent
// runs, and D43's rule (a backend entry is `src/<spell>/backend/X.ts` for which
// a launcher `scripts/X.ts` exists) is what lets that be true without a second
// name.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact, is invisible to the backend's own tests, and would be the second
// implementation this phase exists to remove.
//
// ⛔ THE CLI SHAPE, AND THE QUESTION IT ANSWERS IS THE STDOUT ONE — WHICH IS NOT
// THE SAME QUESTION AS THIS ENTRY'S LIFECYCLE OR ITS ARITHMETIC (playbook Phase
// B, B2; D55). `review.ts` is a CLI by stdout contract — it writes exactly one
// JSON object the calling agent parses — a SERVER by lifecycle (it calls
// `Bun.serve` and blocks until a human submits), and a DAEMON by arithmetic
// (its `SKILL_ROOT` is `join(SCRIPT_DIR, "..")`, true only from a child of the
// skill root, which is why the backend source keeps no `import.meta.main`).
// Only the first of those three decides the shape here, and the shape is:
//
// `process.exitCode` + a natural return, NEVER `process.exit(code)`. Bun's
// stdout is ASYNCHRONOUS on a pipe (synchronous on a TTY or file), so an
// explicit exit discards whatever has not drained — measured at exactly 65,536
// bytes, and the caller receives well-formed-LOOKING JSON that stops mid-string.
// A digestify review can easily carry more than that: the answers and the
// comment bodies are whatever the human typed. Reproduced, fixed and gated in
// bounty first (P0, #77/#78); `review.test.ts` has this spell's own gate for it,
// through a SHELL pipe, because `Bun.spawn`'s pipe does not reproduce it.
// Do not tidy this into an explicit exit.
//
// `run()` takes NO ARGUMENTS on purpose: the command line belongs to the file
// that PARSES it, which is the backend source. If this forwarder read the
// argument vector itself it would match the roster enumerator's arg-parsing
// predicate in `grimoire/lib/entry-points.ts`, and the flag ward would then
// judge this spell's documented flags against a file that recognises none.
//
// ⛔ AND THAT PREDICATE IS A TEXT SCAN, SO THIS COMMENT MUST NOT SPELL THE TOKEN
// EITHER — prose and code are indistinguishable to a regex, and an earlier
// draft of a sibling launcher re-tripped the ward from inside the paragraph
// warning against it.
import { run } from "../dist/review.js";

process.exitCode = await run();
