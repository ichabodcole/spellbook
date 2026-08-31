# `sharp` is a root dependency whose only consumer in the repo is one test fixture

**Added:** 2026-08-31 · **Found by:** `daedalus` while swapping imago off
`sharp` · **Scope:** root `package.json`, one test file · **Severity:** low —
**not** a shipped-artifact problem

## The measurement

After `e7b2ed2`, no spell's **shipped execution path** imports `sharp`. Its only
remaining consumer repo-wide is
`plugins/spellbook/skills/imago/tests/imageOptimize.test.ts:11`, which uses it
to build a **fixture** (`const sharp = (await import("sharp")).default`).

It sits in `dependencies`, not `devDependencies` — wrong for a test-only fixture
regardless of what happens next. And the precedent for removing it entirely
already exists: **glamour's equivalent test builds its fixtures with `Bun.Image`
alone** (`glamour/tests/imageOptimize.test.ts:14-16`).

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
