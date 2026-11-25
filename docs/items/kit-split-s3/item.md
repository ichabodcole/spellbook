---
type: item
title: "Move session.ts's core out: state, places, writes"
description:
  The session's core state, path guards and owned writes move to
  session/state.ts, places.ts and writes.ts, and this.m becomes this.core.m
  throughout.
status: stable
lifecycle: done
id: 01a20f86-8cbf-71da-8688-18de417f252e
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8c31-70b9-bba9-cacf4bcd0674]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move session.ts's core out: state, places, writes

This is step S3 of the kit split
([feature](../../features/kit-split/feature.md)). Tier 1: `state`, `places`
(with our own-places guards) and `writes`. `this.m` becomes `this.core.m` at
about 200 sites: the widest diff of the split.

Detail, risks and the lessons that apply:
[the write-up](../kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its
[step table](../kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [x] `session.test.ts`, `ownPlaces.test.ts` (repointed from `m.docs` to
      `core.m.docs`), `noHome.*`, `diskGuard.test.ts` and `saveUnseen.test.ts`
      pass.
- [x] Every `owned` path still reaches `writes`: the daemon's own writes are not
      announced by the watcher.
- [x] `session.ts`'s override is lowered to its new count.
- [x] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [x] The gate passes (`bun run gate`, whose type-check ward covers the kit).
- [x] It lands alone: no other split step runs beside it.

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](../kit-split-oversized-modules/item.md)
