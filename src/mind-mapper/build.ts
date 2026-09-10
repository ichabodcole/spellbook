#!/usr/bin/env bun

// Delegator, not a build. The build lives once at `src/build.ts` (seams
// Contract 2) and is spell-parameterised; this file is the per-spell entry
// point named by seams Contract 4 (`src/<spell>/build.ts`), identical in shape
// to its astrolabe and imago siblings.
// (Its ORIGINAL stated reason for existing was to keep the invocation printed
// by mind-mapper's STALE DIST warning working. That warning is gone — the
// build stamp was removed by Cole's ruling — so this file now stands on the
// Contract 4 symmetry alone, which is why it is not deleted with the warning.)
// Add no logic here — a second copy of Bun.build is the duplication spell-kit
// exists to remove.

import { buildSpell } from "../build";

if (import.meta.main) {
  process.exit(await buildSpell("mind-mapper"));
}
