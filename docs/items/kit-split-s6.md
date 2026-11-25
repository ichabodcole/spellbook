---
type: item
title:
  "Move session.ts's small tier 2 parts out: viewer, media, sidecars, placing"
description:
  What the centre shows becomes one rule in session/viewer.ts, which the 8
  methods that set it call, and the image and sidecar helpers and placing move
  to media.ts, sidecars.ts and placing.ts.
status: stable
lifecycle: review
id: 01a20f86-8e6d-71be-86b7-11263dfb3241
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8ddd-7780-8233-0ec66f9dbc98]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move session.ts's small tier 2 parts out: viewer, media, sidecars, placing

This is step S6 of the kit split ([feature](../features/kit-split/feature.md)).
`viewer` (new: the one rule for `m.openDoc`, `m.openImage` and `m.docAside`,
today 19 assignments in 8 methods), `media`, `sidecars` and `placing`. The
viewer is a behaviour seam.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `images.*`, `show.test.ts`, `fileGone.test.ts` and `trash.test.ts` pass.
- [ ] Each of the 19 assignments is read against the viewer's rule before and
      after; a close that brought back the aside document still does.
- [ ] `session.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
