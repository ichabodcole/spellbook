---
type: item
title: Move the daemon's saving, trash and picker out
description:
  Switching versions and the edit relay, trash for the human, and the native
  picker move to daemon/saving.ts, trash.ts and picker.ts.
status: draft
lifecycle: backlog
id: 01a20f86-9403-76cd-89dc-719d7a681d99
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9375-710c-b28b-4829dedf0d82]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move the daemon's saving, trash and picker out

This is step D5 of the kit split ([feature](../features/kit-split/feature.md)).
`saving` (switches, `activate`, `relayEdit`, `editActive`, `editLeft`, deleting
versions), `trash` and `picker`.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `editRelay.server.test.ts`, `editLeft.server.test.ts`, `trash.*` and
      `picker.test.ts` pass.
- [ ] Blind tests on the edit relay are repointed and shown still to see their
      calls.
- [ ] The moved code's `session.` calls go through the parts.
- [ ] `server.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
