---
type: item
title: "Move session.ts's tree out: context and workspace"
description:
  The context tree, with the scan filter and watchRoots, moves to
  session/context.ts, and the workspace and its overlap to session/workspace.ts.
status: draft
lifecycle: backlog
id: 01a20f86-8f88-70d1-bfc9-53d9b1eb9b9f
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8efa-774d-b516-2ff089d69144]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move session.ts's tree out: context and workspace

This is step S8 of the kit split ([feature](../features/kit-split/feature.md)).
`context` (with the scan filter and `watchRoots`) and our own `workspace` (no
home, the workspace and its overlap, the app slot).

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `tree.*`, `scanFilter.*`, `noHome.*`, `structure.test.ts` and
      `layers.test.ts` pass.
- [ ] `relink` then the rescan still run in that order after each change.
- [ ] `session.ts`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
