---
type: backlog
title:
  "`sharp` is a root dependency whose only consumer in the repo is one test
  fixture"
status: stable
description:
  sharp is a root-level dependency used only by one test fixture to build test
  data, not by any shipped execution path
lifecycle: open
generated: { by: unknown, at: 2026-08-31 }
---

# `sharp` is a root dependency whose only consumer in the repo is one test fixture

## The measurement

After `e7b2ed2`, no spell's **shipped execution path** imports `sharp`. Its only
remaining consumer repo-wide is `src/imago/backend/imageOptimize.test.ts:11`
(relocated from `plugins/spellbook/skills/imago/tests/` by backend convergence
Phase 3), which uses it to build a **fixture**
(`const sharp = (await import("sharp")).default`).

It sits in `dependencies`, not `devDependencies` — wrong for a test-only fixture
regardless of what happens next. And the precedent for removing it entirely
already exists: **glamour's equivalent test builds its fixtures with `Bun.Image`
alone** (`src/glamour/backend/imageOptimize.test.ts:14-16`).

## Why it was deliberately not touched

Sprint 01 scoped `sharp` removal to the shipped execution path on purpose. Ward
1b does not cover `tests/`, tests are not what a consumer executes, and
requiring zero `sharp` repo-wide would have forced an unrelated test rewrite
inside a phase that had a live boot defect to fix.

**The tree is correct today.** This is tidiness with a precedent attached, not a
defect.

## Acceptance

- [ ] Either rewrite the fixture on `Bun.Image` following glamour's, and drop
      the dependency; or move it to `devDependencies` and record why it stays.
- [ ] Whichever: `bun test` stays green, and the fixture still produces an image
      large enough to exercise the downscale path.
