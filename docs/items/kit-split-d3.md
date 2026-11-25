---
type: item
title: Move the daemon's prefs, presence and messages out
description:
  Prefs, the held selection and the agent's presence, and the chat on the tail
  move to daemon/prefs.ts, presence.ts and messages.ts.
status: draft
lifecycle: backlog
id: 01a20f86-92e8-76b7-b412-f3139ad48ab3
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9259-7734-ab81-7e643acba754]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move the daemon's prefs, presence and messages out

This is step D3 of the kit split ([feature](../features/kit-split/feature.md)).
`prefs`, `presence` (the held selection, the agent's tails and grace,
`holdAgent`) and `messages`. The grace timer moves to `presence.stop()`, at the
same place in `close`.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `selection.test.ts`, `pointed.integration.test.ts`,
      `messageViaRefs.test.ts`, `messageAppAbout.server.test.ts` and
      `replyHint.test.ts` pass.
- [ ] No moved name resolves to a browser global (`history`, `close`).
- [ ] The moved code's `session.` calls go through the parts.
- [ ] `server.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
