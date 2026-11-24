---
type: item
title:
  "Move session.ts's tree-spanning changes out: relink, structure, trash,
  images, move plan, sets"
description:
  The changes that span the tree move to session/relinkOnMove.ts, structure.ts,
  trash.ts, imageImport.ts, movePlan.ts and sets.ts, with move and rename moved
  line for line.
status: draft
lifecycle: backlog
id: 01a20f86-90a6-7488-81de-acac08e2ef93
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9015-7264-8ac2-4ba13e886670]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Move session.ts's tree-spanning changes out: relink, structure, trash, images, move plan, sets

This is step S10 of the kit split ([feature](../features/kit-split/feature.md)).
Tier 5 apart from the views: `relinkOnMove`, `structure`, `trash`,
`imageImport`, and our own `movePlan` and `sets`. The ordering inside `move` and
`rename` is the risk.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `structure.test.ts`, `relink.*`, `movePlan.test.ts`, `setPromotion.*`,
      `trash.*` and every `images.*` pass.
- [ ] `move` and `rename` are moved line for line, their order unchanged.
- [ ] `session.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
