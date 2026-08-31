#!/usr/bin/env bun

// Delegator, not a build. The build lives once at `src/build.ts` (seams
// Contract 2) and is spell-parameterised; this file is the per-spell entry
// point named by seams Contract 4 (`src/<spell>/build.ts`).
// Add no logic here — a second copy of Bun.build is the duplication spell-kit
// exists to remove.

import { buildSpell } from "../build";

if (import.meta.main) {
  process.exit(await buildSpell("imago"));
}
