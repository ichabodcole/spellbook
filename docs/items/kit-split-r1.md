---
type: item
title: Split protocol.ts by topic
description:
  protocol.ts's types move to protocol/context.ts, documents.ts, chat.ts,
  project.ts, reading.ts and frames.ts, and protocol.ts re-exports them, so none
  of its 67 importers changes.
status: draft
lifecycle: ready
id: 01a20f86-963f-72f6-9865-d50569fd5f78
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8ba5-7686-8775-15ef37334619]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Split protocol.ts by topic

This is step R1 of the kit split ([feature](../features/kit-split/feature.md)).
Types by topic, as Story Studio's: `protocol/context.ts`, `documents.ts`,
`chat.ts`, `project.ts`, `reading.ts`, `frames.ts`. `protocol.ts` becomes
`export type *` re-exports plus our two runtime values (`resolveAppState`,
`PICK_WANTS`) re-exported by name. Can run any time in lane B.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] It typechecks, and no importer of `protocol.ts` changes.
- [ ] `resolveAppState` and `PICK_WANTS` are still exported as values.
- [ ] `protocol.ts` is under 1,200 lines and its override is removed.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
