---
type: item
title: Move session.ts's documents out, with follow, compare, saving and notes
description:
  The documents part moves to session/documents.ts with its misfiled helpers
  rehomed, then follow.ts, compare.ts, saving.ts and notes.ts, with the note
  guard still loaded lazily.
status: stable
lifecycle: active
id: 01a20f86-8efa-774d-b516-2ff089d69144
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8e6d-71be-86b7-11263dfb3241]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move session.ts's documents out, with follow, compare, saving and notes

This is step S7 of the kit split ([feature](../features/kit-split/feature.md)).
`documents` with the misfiled helpers (`activeText`, `isDirty`, `jsonProblemOf`,
`refuseInvalidJson`), then `follow`, `compare`, `saving`, `notes`, and `tasks`
if S4 folded. `notes.ts` keeps `loadNoteGuard`'s `await import` and imports
`NOT_PLACED` from `notPlaced.ts`.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `session.test.ts`, `json.*`, `history.*`, `notes.test.ts`,
      `noteGuard.lazy.test.ts`, `editLeft.server.test.ts` and
      `saveUnseen.test.ts` pass.
- [ ] `notes.ts` keeps the guard's `await import`, and the start-path test
      passes.
- [ ] `DocumentPane.contextMenu.test.tsx` still sees its calls (it goes blind
      only when a D step moves the caller).
- [ ] `session.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
