---
type: item
title: Move the daemon's watching out
description:
  The watchers, settle and recheck timers and file-event handling move to
  daemon/watching.ts, with the order of rescans and catch-up unchanged.
status: draft
lifecycle: backlog
id: 01a20f86-9375-710c-b28b-4829dedf0d82
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-92e8-76b7-b412-f3139ad48ab3]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move the daemon's watching out

This is step D4 of the kit split ([feature](../features/kit-split/feature.md)).
`watching`: watchers, settle and recheck timers, `syncWatchers`,
`announceOutside`, `handleFileEvent`. The order of rescans and catch-up decides
whose write a change was.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `fileGone.test.ts`, `daemon.integration.test.ts` and
      `concurrentRestore.integration.test.ts` pass.
- [ ] The moved code's `session.` calls go through the parts.
- [ ] `server.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).
- [ ] It lands alone: no other split step runs beside it.
- [ ] Linux CI is green on it before the next step starts.

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
