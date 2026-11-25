---
type: item
title: Move WorkspaceShell's right column out
description:
  The right column and its tabs move to useRightColumn.ts, rightTabs.ts and
  useRightTab.ts, leaving WorkspaceShell under 1,200 lines.
status: draft
lifecycle: backlog
id: 01a20f86-9b81-7503-b97e-cc9b8355b1e3
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9aec-76aa-b212-a119874e1f16]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Move WorkspaceShell's right column out

This is step W5 of the kit split ([feature](../features/kit-split/feature.md)).
`useRightColumn.ts`, `rightTabs.ts` and `useRightTab.ts` (1393–1746). Theme
(491–543) and the composer stay in `ShellBody`.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] The 17 `WorkspaceShell*.test.tsx` pass.
- [ ] Each hook is called where its section sat, so effect order is unchanged.
- [ ] `WorkspaceShell.tsx` is under 1,200 lines and its override is removed.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
