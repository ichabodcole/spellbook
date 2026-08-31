#!/usr/bin/env bun

// Delegator, not a build. The build lives once at `src/build.ts` (seams
// Contract 2) and is spell-parameterised; this file exists only so the
// invocation mind-mapper's own STALE DIST warning prints
// (`bun run src/mind-mapper/build.ts`, server.ts:534) keeps working.
// Add no logic here — a second copy of Bun.build is the duplication spell-kit
// exists to remove.

import { buildSpell } from "../build";

if (import.meta.main) {
  process.exit(await buildSpell("mind-mapper"));
}
