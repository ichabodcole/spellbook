---
type: item
title:
  link.backlinks integration test waits on a file watch that can miss its one
  write
description:
  "src/kit/workspace/links.integration.test.ts 'the links that land…' writes
  c.md once and waits 5 s for the watch to see it; under load the write is lost
  and it times out (base: 5 in 120 runs). The harness's write-until-seen helper
  exists for this."
status: stable
lifecycle: ready
id: 01a16a5b-db51-7050-abd1-c921b47c0dad
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-23 }
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
cycle: 2026-10-polish
---

# link.backlinks integration test waits on a file watch that can miss its one write

`src/kit/workspace/links.integration.test.ts`, describe `link.backlinks`, fails
now and then with a 5000 ms `waitUntil` timeout. It failed the sign branch's
gate once during the polish cycle (2026-10-23), and the verifier then measured
it on the cycle's base, c2f2210a: 5 failures in 120 runs, four of them beside a
busy `bun test src/kit` and one alone. The cells that time out are "the links
that land, read as the documents write them" and "an unsaved edit in another
document counts". The branch failed once in 120. "dot-paths never push
context.changed" failed once too, so it may share the cause.

**Likely cause, not yet confirmed:** around line 194 the test writes `c.md`
once, then waits for the file watch to report it. The test harness has a
write-until-seen helper for exactly this, whose comment records watch-arming
writes lost under load, and this test doesn't use it.

**Cause and fix (2026-10-23, `impl/watch-test-regression`, `8b4f2433`):** the
cause is the one in
[kit-watch-tests-unproven-watch](kit-watch-tests-unproven-watch.md): a write
made straight after a watch is armed, before FSEvents delivers for it, is never
reported. The cause was traced in `fileGone.test.ts`, not in this file. Here it
is inferred from the same pattern and from the loop below. The test's `c.md` and
`d.md` writes, and "dot-paths" final `b.md` write, now go through
`writeUntilSeen`. No timeout was raised. In a short interleaved loop alone, with
`fseventsd` saturated by other work, the base failed 5 of 11 runs (6 of them in
the two backlinks cells, 2 in the `_meta/profiles` cell) and the fix failed 1
of 11. That one was a process stall ("no state frame yet" in `beforeEach`), not
a watch. The 50-run bar was not run: the machine was taking over a minute for
each 6 s run.

## Definition of done

- [ ] Confirm the cause, and fix it in the test (or the watch, if it really is
      the watch's bug), without raising a timeout.
- [ ] The whole file passes 50 runs in a row, alone and beside a busy
      `bun test src/kit`.
