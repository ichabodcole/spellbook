---
type: item
title: Move DocumentPane's link writing, save and revert, and drops out
description:
  Link writing, save and revert, and images pasted and rows dragged in move to
  useLinkWriting.ts, useSaveRevert.ts and useDocumentDrops.ts.
status: draft
lifecycle: backlog
id: 01a20f86-9d34-7505-8584-99229c1dac75
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9ca3-744e-8fe9-41bc09ef7b2d]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Move DocumentPane's link writing, save and revert, and drops out

This is step P3 of the kit split ([feature](../features/kit-split/feature.md)).
`useLinkWriting.ts` (826–929), `useSaveRevert.ts` (754–825) and
`useDocumentDrops.ts` (1410–1640). Story Studio's P3 had to reorder effects to
cut one section; expect the same.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] The 21 `DocumentPane*.test.tsx` pass.
- [ ] Each moved effect is checked for order in review.
- [ ] Any effect reordered to make the cut is named in the commit and shown not
      to change behaviour.
- [ ] `DocumentPane.tsx`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
