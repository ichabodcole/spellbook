---
type: item
title: Move WorkspaceShell's right column out
description:
  The right column and its tabs move to useRightColumn.ts, rightTabs.ts and
  useRightTab.ts, leaving WorkspaceShell under 1,200 lines.
status: stable
lifecycle: done
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

This is step W5 of the kit split
([feature](../../features/kit-split/feature.md)). `useRightColumn.ts`,
`rightTabs.ts` and `useRightTab.ts` (1393–1746). Theme (491–543) and the
composer stay in `ShellBody`.

Detail, risks and the lessons that apply:
[the write-up](../kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](../kit-split-oversized-modules/write-up.md#the-build-steps).

Note from W4 (2026-11-25): W4 moved only the notices. The rest of the span the
write-up gives W4 (1129–1392 before W1) stays in `ShellBody` on purpose: the
`workspace` context memo, `activeDoc`, `askDescribe`, the tree-selection pruning
effect and the `contextBody` JSX. None of it is notice logic, and none of it is
the right column either, so W5 leaves it in place too.

Note from W5 (2026-11-25): there is no `rightTabs.ts`. The tabs are JSX built on
every render and the parent needs the array, so their panels stay in
`ShellBody`; see the session record.

## Definition of done

- [x] The 17 `WorkspaceShell*.test.tsx` pass.
- [x] Each hook is called where its section sat, so effect order is unchanged.
- [x] `WorkspaceShell.tsx` is under 1,200 lines and its override is removed.
- [x] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [x] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](../kit-split-oversized-modules/item.md)
