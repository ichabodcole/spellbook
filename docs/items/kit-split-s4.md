---
type: item
title: Move session.ts's chats and tasks out
description:
  The chat and the task verbs move to session/chats.ts and session/tasks.ts.
status: stable
lifecycle: active
id: 01a20f86-8d4d-71ee-826d-c0c379a47214
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8cbf-71da-8688-18de417f252e]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move session.ts's chats and tasks out

This is step S4 of the kit split ([feature](../features/kit-split/feature.md)).
`chats` (about 50 lines) and `tasks`. Small for us; the write-up allows folding
it into S6, in which case this item closes with S6 and says so.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `tasks.test.ts`, `waiting.test.ts`, `chatNames.server.test.ts` and
      `noteAsk.server.test.ts` pass.
- [ ] `session.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
