---
type: item
title: Move DocumentPane's reader mode out
description: Reader mode's rendered reads move to useRenderedReads.ts.
status: draft
lifecycle: backlog
id: 01a20f86-9e5b-775d-b927-06e28f08bf78
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9dc7-71e7-9c8f-bf60ff08a8ac]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move DocumentPane's reader mode out

This is step P5 of the kit split ([feature](../features/kit-split/feature.md)).
`useRenderedReads.ts` (reader mode, 548–670).

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
