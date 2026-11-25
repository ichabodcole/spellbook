---
type: item
title: Test the session's ledger sites that no test catches
description:
  15 of the session's 21 write-ledger calls can be dropped with no watcher or
  ledger test failing; each needs a test that sees the daemon's own write
  announced.
status: draft
lifecycle: triage
id: 01a2121c-7291-73e7-b235-1041aca49e93
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-s3/sessions/2026-11-25-kit-split-s3.md
---

# Test the session's ledger sites that no test catches

The session records each write it makes into a watched place in its ledger
(`src/kit/workspace/session/writes.ts`), so the watcher does not announce the
daemon's own write as someone else's. S3's review dropped each ledger call in
turn and ran 23 watcher and ledger test files: 15 of 21 mutations survived, the
same on develop. A dropped call would show only as a spurious "changed outside"
or a preserved version nobody asked for.

The uncaught sites (as of S3, in `session.ts` unless named):

- `adoptActive`'s `writes.own`, on restore and after `setActive`
- `preserveOutside`'s `writeVersion`
- the edit-after-switch `writeVersion` (two sites) and `newVersion`'s
- `disown` on deleting a version
- the save's `writeOwned`, and the two link-rewrite `writeOwned`s
- the adopted hand-written version's `own`, and the version-changed `own`
- `wroteBundle` on duplicate and on rename (two sites)
- the echo window's `ownBundles.delete` in `writes.ts`

The review's mutation script is kept at
`/private/tmp/claude-501/-Users-colereed-Projects-Spellbook/e55a1201-5c9e-447f-8c62-68272f5c2a6c/scratchpad/s3-review/mutate.sh`
while the scratchpad lasts; the list above is the durable record.

## Definition of done

- [ ] Each site above has a test that fails when its ledger call is dropped: the
      daemon's own write, echoed by the watcher, is announced or preserved.
- [ ] Re-running the drop-one-call mutations, none of the 21 survives.
- [ ] No source change beyond what a test needs to observe the write.
