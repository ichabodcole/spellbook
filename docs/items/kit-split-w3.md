---
type: item
title: Move WorkspaceShell's held selection and reveal out, together
description:
  The held selection and the reveal move to useHeldSelection.ts and useReveal.ts
  in one step, keeping the effect order their comment describes.
status: stable
lifecycle: active
id: 01a20f86-9a59-7302-ba4d-9aed91799269
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-99c2-7649-9db8-4e29977b8dfc]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move WorkspaceShell's held selection and reveal out, together

This is step W3 of the kit split ([feature](../features/kit-split/feature.md)).
`useHeldSelection.ts` (866–999) and `useReveal.ts` (1000–1098), in one step
because of the effect-order comment.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] The 17 `WorkspaceShell*.test.tsx` pass.
- [ ] Each hook is called where its section sat, so effect order is unchanged.
- [ ] The selection and the reveal move in the same commit, in their current
      order.
- [ ] `WorkspaceShell.tsx`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
