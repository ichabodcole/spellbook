---
type: item
title: Move the daemon's incoming images out
description:
  Images coming in, arrivals and addPaths move to daemon/imagesIn.ts, with the
  arrival settle timer kept beside lastImport and the arrivals map.
status: draft
lifecycle: backlog
id: 01a20f86-9492-7558-a068-a13f044e77c7
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9403-76cd-89dc-719d7a681d99]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move the daemon's incoming images out

This is step D6 of the kit split ([feature](../features/kit-split/feature.md)).
`imagesIn`: images coming in, arrivals, `addPaths`.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `images.import.*`, `images.paste.test.ts` and `images.rowDrop.test.ts`
      pass.
- [ ] The arrival settle timer stays with `lastImport` and the arrivals map.
- [ ] The moved code's `session.` calls go through the parts.
- [ ] `server.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
