---
type: item
title: Move verbs.ts's command rows out, by topic
description:
  The 39 rows of ROWS move to verbs/rows/session.ts, chat.ts, notes.ts,
  structure.ts and reading.ts, split at the same verbs as Story Studio's, with
  every verb's help unchanged.
status: draft
lifecycle: backlog
id: 01a20f86-9891-71c1-ad6c-33ddf2b2261e
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-97fd-7563-9968-df77ad20baf0]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move verbs.ts's command rows out, by topic

This is step V4 of the kit split ([feature](../features/kit-split/feature.md)).
`verbs/rows/{session,chat,notes,structure,reading}.ts`: our 39 rows in `ROWS`
(1282–1972), split at the same verbs as Story Studio's.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] Every `*.cli.test.ts` passes.
- [ ] The start-path test passes: the new parts import only what `verbs.ts`
      imports today.
- [ ] `help` for every verb is snapshotted before this step and is identical
      after.
- [ ] `verbs.ts` is under 1,200 lines and its override is removed.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
