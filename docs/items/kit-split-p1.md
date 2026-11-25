---
type: item
title: "Move DocumentPane's small hooks out: pane width, stats, now, focus mode"
description:
  usePaneWidth, useDebouncedStats and useNow move to paneHooks.ts, and focus
  mode to useFocusMode.ts.
status: draft
lifecycle: ready
id: 01a20f86-9c0f-7692-b618-d5ad34c51a77
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8ba5-7686-8775-15ef37334619]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move DocumentPane's small hooks out: pane width, stats, now, focus mode

This is step P1 of the kit split ([feature](../features/kit-split/feature.md)).
`paneHooks.ts` (`usePaneWidth`, `useDebouncedStats`, `useNow`) and
`useFocusMode.ts`.

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
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
