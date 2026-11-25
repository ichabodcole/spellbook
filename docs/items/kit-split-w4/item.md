---
type: item
title: Move WorkspaceShell's daemon notices out
description: The daemon notices move to useDaemonNotices.ts.
status: stable
lifecycle: done
id: 01a20f86-9aec-76aa-b212-a119874e1f16
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9a59-7302-ba4d-9aed91799269]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move WorkspaceShell's daemon notices out

This is step W4 of the kit split
([feature](../../features/kit-split/feature.md)). `useDaemonNotices.ts`
(1129–1392).

Detail, risks and the lessons that apply:
[the write-up](../kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](../kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [x] The 17 `WorkspaceShell*.test.tsx` pass.
- [x] Each hook is called where its section sat, so effect order is unchanged.
- [x] `WorkspaceShell.tsx`'s override is lowered to its new count.
- [x] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [x] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](../kit-split-oversized-modules/item.md)
