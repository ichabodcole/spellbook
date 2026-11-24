---
type: item
title: Move the daemon's dispatchers out and leave server.ts as the shell
description:
  handleClientOp's cases by topic, the agent commands and the HTTP server move
  to daemon/surfaceOps/*, agentOps.ts and http.ts, and server.ts is left as the
  shell under 1,200 lines.
status: draft
lifecycle: backlog
id: 01a20f86-95ae-7357-8026-a46b53bb5192
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-951f-75e7-bfc1-38f3fd29845e]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Move the daemon's dispatchers out and leave server.ts as the shell

This is step D9 of the kit split ([feature](../features/kit-split/feature.md)).
`surfaceOps.ts` with `surfaceOps/{documents,chats,tree}.ts`, `agentOps` and
`http`; `server.ts` becomes the shell (`createWorkspaceDaemon`, the lock,
`boot()`, `close`, `runWorkspaceDaemon`). There is no D8: we have no auto mode
or projects. With every caller on the parts, the facade's delegates are retired
(decision 5).

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] Every `*.server.test.ts` passes.
- [ ] A test shows the merged surface map's keys equal `CLIENT_OPS`.
- [ ] The tier test covers `daemon/`.
- [ ] `DocumentPane.contextMenu.test.tsx` is repointed if moving the caller
      blinded it, and is shown still to see its calls.
- [ ] `session.ts` delegates with no caller left are removed.
- [ ] `server.ts` is under 1,200 lines and its override is removed.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
