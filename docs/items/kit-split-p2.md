---
type: item
title: Move DocumentPane's document menu out
description:
  "The document menu moves to useDocumentMenu.ts, the menu only: the link
  picker's state stays with the link section."
status: draft
lifecycle: backlog
id: 01a20f86-9ca3-744e-8fe9-41bc09ef7b2d
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9c0f-7692-b618-d5ad34c51a77]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Move DocumentPane's document menu out

This is step P2 of the kit split ([feature](../features/kit-split/feature.md)).
`useDocumentMenu.ts` (930–1365), the menu only, since the link picker sets state
the link section owns (Story Studio's P2 lesson).

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] The 21 `DocumentPane*.test.tsx` pass.
- [ ] Each moved effect is checked for order in review.
- [ ] `DocumentPane.tsx`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
