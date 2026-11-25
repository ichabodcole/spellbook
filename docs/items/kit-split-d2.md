---
type: item
title: "Move the daemon's kernel out: core and views"
description:
  The daemon's sockets, event log, emit and state broadcast move to
  daemon/core.ts and its view state to daemon/views.ts, and their session calls
  move onto the session's parts.
status: draft
lifecycle: backlog
id: 01a20f86-9259-7734-ab81-7e643acba754
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by:
  [01a20f86-9134-771c-84f4-f5e4034f54de, 01a20f86-91ca-7673-92c9-1c4284d2c0f6]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move the daemon's kernel out: core and views

This is step D2 of the kit split ([feature](../features/kit-split/feature.md)).
`core` (sockets, surface ids, the event log, SSE clients, `send`, `emit`,
`broadcastState`, the edit timer) and `views` (`viewState`, `sendState`, `line`,
`announce`, `revealPath`), as closure parts. From here on each D step moves its
`session.` calls onto the parts in a second commit.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `server.test.ts`, `events.test.ts`, the `tail-handoff.*` tests,
      `quietTail.test.ts` and `heartbeat.test.ts` pass.
- [ ] The state broadcast keeps its throttle.
- [ ] The moved code's `session.` calls go through the parts, in a second
      commit.
- [ ] `server.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).
- [ ] It lands alone: no other split step runs beside it.

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
