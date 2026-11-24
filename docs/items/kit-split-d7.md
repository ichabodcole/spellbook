---
type: item
title: Move the daemon's structure and link-following out
description:
  Structure, following links after a move and pushAppAct move to
  daemon/structure.ts, linkFollow.ts and appWork.ts, with move, relink and
  follow in today's order.
status: draft
lifecycle: backlog
id: 01a20f86-951f-75e7-bfc1-38f3fd29845e
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9492-7558-a068-a13f044e77c7]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Move the daemon's structure and link-following out

This is step D7 of the kit split ([feature](../features/kit-split/feature.md)).
`structure` and `linkFollow`, which call each other, and `appWork`
(`pushAppAct`).

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `structure.test.ts`, `relink.*`, `history.follow.server.test.ts` and
      `links.integration.test.ts` pass.
- [ ] `move` then `relink` then the follow run line for line as today.
- [ ] No moved name resolves to a browser global (Story Studio's D7 hit
      `history`).
- [ ] The moved code's `session.` calls go through the parts.
- [ ] `server.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
