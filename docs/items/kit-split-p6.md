---
type: item
title: Move DocumentPane's compare, agent pointing and text offer out
description:
  Compare, the agent's pointing and the text offer move to useCompare.ts,
  useAgentPointing.ts and useTextOffer.ts, leaving DocumentPane under 1,200
  lines.
status: draft
lifecycle: backlog
id: 01a20f86-9eeb-768a-9a3b-a930a5770fbe
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9e5b-775d-b927-06e28f08bf78]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move DocumentPane's compare, agent pointing and text offer out

This is step P6 of the kit split ([feature](../features/kit-split/feature.md)).
`useCompare.ts` (671–732), `useAgentPointing.ts` (1641–1767) and our own
`useTextOffer.ts` (1366–1409).

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] The 21 `DocumentPane*.test.tsx` pass.
- [ ] Each moved effect is checked for order in review.
- [ ] `DocumentPane.tsx` is under 1,200 lines and its override is removed.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
