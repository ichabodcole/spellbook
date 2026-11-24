---
type: item
title: Move WorkspaceShell's column and pane-key hooks out
description:
  The column layout and pane keys move to useShellColumns.ts and usePaneKeys.ts.
status: draft
lifecycle: backlog
id: 01a20f86-99c2-7649-9db8-4e29977b8dfc
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-9926-72ec-8e93-934381ff98cf]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Move WorkspaceShell's column and pane-key hooks out

This is step W2 of the kit split ([feature](../features/kit-split/feature.md)).
`useShellColumns.ts` (544–736) and `usePaneKeys.ts` (776–865).

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-other-files), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] The 17 `WorkspaceShell*.test.tsx` pass.
- [ ] Each hook is called where its section sat, so effect order is unchanged.
- [ ] `WorkspaceShell.tsx`'s override is lowered to its new count.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)
